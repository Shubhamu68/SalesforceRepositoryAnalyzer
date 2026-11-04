import type { ResolvedPersonaPermissions } from "./PersonaPermissionResolver.js";
import type { PermissionSet } from "../models/PermissionSet.js";
import type { PermissionSetGrant } from "../models/PermissionSetGrant.js";
import type { PermissionSource } from "./permissionAggregator.js";
import type { EffectiveFieldPermission } from "./fieldPermissionAggregator.js";
import { getFieldPermissionability } from "./fieldPermissionability.js";
import { isSchemaRequiredField } from "./schemaRequiredFields.js";
import {
  MATRIX_PERMISSION_KEYS,
  type MatrixPermission,
  type MatrixAccess,
  type MatrixPermissionSources,
} from "../models/ObjectAccessMatrixResult.js";

const norm = (value: string): string => value.trim().toLowerCase();
const isTrue = (ps: PermissionSet, permission: string): boolean =>
  ps.userPermissions?.[permission.toLowerCase()] === true;

type SystemPermission = "ViewAllData" | "ModifyAllData";
type SourceDetails = PermissionSource & { viaSystemPermission?: SystemPermission };

function objectGrants(ps: PermissionSet, objectName: string, key: MatrixPermission): boolean {
  const record = ps.objectPermissions.find((p) => norm(p.object) === norm(objectName));
  if (!record) return false;
  switch (key) {
    case "read": return record.allowRead || record.viewAllRecords || record.modifyAllRecords || record.viewAllFields;
    case "create": return record.allowCreate;
    case "edit": return record.allowEdit || record.modifyAllRecords;
    case "delete": return record.allowDelete || record.modifyAllRecords;
    case "viewAllRecords": return record.viewAllRecords || record.modifyAllRecords;
    case "modifyAllRecords": return record.modifyAllRecords;
    case "viewAllFields": return record.viewAllFields;
  }
}

/** The global permissions are object grants, NOT field-level-security overrides. */
function globalGrants(ps: PermissionSet, key: MatrixPermission): SystemPermission | undefined {
  if (isTrue(ps, "ModifyAllData") && key !== "viewAllFields") return "ModifyAllData";
  if (isTrue(ps, "ViewAllData") && (key === "read" || key === "viewAllRecords")) return "ViewAllData";
  return undefined;
}

function hasObjectMute(mute: PermissionSet, objectName: string, key: MatrixPermission): boolean {
  // Muting Read suppresses dependent object operations in that PSG only.
  if (objectGrants(mute, objectName, "read")) return true;
  if (key === "modifyAllRecords" && objectGrants(mute, objectName, "delete")) return true;
  return objectGrants(mute, objectName, key);
}

function matchingSources(
  source: PermissionSource,
  permissionSet: PermissionSet,
  object: string,
  key: MatrixPermission
): SourceDetails[] {
  const entries: SourceDetails[] = [];
  if (objectGrants(permissionSet, object, key)) entries.push(source);
  const via = globalGrants(permissionSet, key);
  if (via) entries.push({ ...source, viaSystemPermission: via });
  return entries;
}

export interface EvaluatedObjectAccess {
  access: MatrixAccess;
  sources: Record<MatrixPermission, MatrixPermissionSources>;
}

/**
 * One effective-access evaluator for the CLI, API, SOQL scanner, matrix and stack trace.
 * A PSG mute affects only grants from its own group; Profile and direct PS grants survive.
 */
export function createPersonaAccessEvaluator(
  resolved: ResolvedPersonaPermissions,
  mutesByGroup: ReadonlyMap<string, readonly PermissionSet[]> = resolved.mutesByGroup ?? new Map()
) {
  // Normal resolver supplies provenance-aware grants. Legacy callers that
  // construct a resolved persona manually can still use this shared engine.
  const grants: PermissionSetGrant[] = resolved.permissionSetGrants.length > 0
    ? resolved.permissionSetGrants
    : [
        ...(resolved.profile ? [{ permissionSet: resolved.profile, type: "profile" as const }] : []),
        ...resolved.permissionSetGroups.flatMap((group) => group.permissionSets.map((permissionSet) => ({
          permissionSet, type: "permissionSetGroup" as const, permissionSetGroup: group.name,
        }))),
        ...resolved.directPermissionSets.map((permissionSet) => ({
          permissionSet, type: "directPermissionSet" as const,
        })),
      ];
  const objectCache = new Map<string, EvaluatedObjectAccess>();
  const fieldCache = new Map<string, EffectiveFieldPermission>();

  function evaluateObject(objectName: string): EvaluatedObjectAccess {
    const keyName = norm(objectName);
    const cached = objectCache.get(keyName);
    if (cached) return cached;
    const access = {} as MatrixAccess;
    const sources = {} as Record<MatrixPermission, MatrixPermissionSources>;

    for (const key of MATRIX_PERMISSION_KEYS) {
      const grantedBy: SourceDetails[] = [];
      const mutedBy: MatrixPermissionSources["mutedBy"] = [];
      for (const grant of grants) {
        const base: PermissionSource = {
          type: grant.type,
          permissionSet: grant.permissionSet.name,
          ...(grant.permissionSetGroup ? { permissionSetGroup: grant.permissionSetGroup } : {}),
        };
        const contributions = matchingSources(base, grant.permissionSet, objectName, key);
        if (contributions.length === 0) continue;

        const groupName = grant.permissionSetGroup;
        const mutes = groupName ? mutesByGroup.get(groupName) ?? [] : [];
        const accepted: SourceDetails[] = [];
        for (const contribution of contributions) {
          const applicable = mutes.filter((mute) =>
            contribution.viaSystemPermission
              ? isTrue(mute, contribution.viaSystemPermission!) || hasObjectMute(mute, objectName, key)
              : hasObjectMute(mute, objectName, key)
          );
          if (!applicable.length) {
            accepted.push(contribution);
          } else {
            for (const mute of applicable) {
              const existing = mutedBy.find((item) =>
                item.permissionSetGroup === groupName && item.mutingPermissionSet === mute.name
              );
              if (existing) {
                if (!existing.affectedPermissionSets.includes(grant.permissionSet.name)) {
                  existing.affectedPermissionSets.push(grant.permissionSet.name);
                }
              } else {
                mutedBy.push({
                  permissionSetGroup: groupName!,
                  mutingPermissionSet: mute.name,
                  affectedPermissionSets: [grant.permissionSet.name],
                });
              }
            }
          }
        }
        grantedBy.push(...accepted);
      }
      const uniqueSources = new Map<string, SourceDetails>();
      for (const source of grantedBy) {
        const id = `${source.type}|${source.permissionSetGroup ?? ""}|${source.permissionSet}|${source.viaSystemPermission ?? ""}`.toLowerCase();
        uniqueSources.set(id, source);
      }
      access[key] = uniqueSources.size > 0;
      sources[key] = { grantedBy: [...uniqueSources.values()], mutedBy };
    }
    const result = { access, sources };
    objectCache.set(keyName, result);
    return result;
  }

  function evaluateField(fullFieldName: string): EffectiveFieldPermission {
    const fieldKey = norm(fullFieldName);
    const cached = fieldCache.get(fieldKey);
    if (cached) return cached;
    const dot = fullFieldName.indexOf(".");
    const objectName = dot < 0 ? "" : fullFieldName.slice(0, dot);
    const objectAccess = evaluateObject(objectName);
    const fieldName = dot < 0 ? "" : fullFieldName.slice(dot + 1);
    const permissionable = getFieldPermissionability(objectName, fieldName);
    const schemaRequired = isSchemaRequiredField(resolved.metadataObjectsDirectory, objectName, fieldName);
    const readGrantedBy: PermissionSource[] = [];
    const editGrantedBy: PermissionSource[] = [];
    const mutedBy: string[] = [];

    for (const grant of grants) {
      const field = grant.permissionSet.fieldPermissions.find((p) => norm(p.field) === norm(fullFieldName));
      if (!field) continue;
      const mutes = grant.permissionSetGroup ? mutesByGroup.get(grant.permissionSetGroup) ?? [] : [];
      const isMuted = (key: "readable" | "editable") => mutes.some((mute) =>
        mute.fieldPermissions.some((p) => norm(p.field) === norm(fullFieldName) && p[key])
      );
      const source: PermissionSource = {
        type: grant.type,
        permissionSet: grant.permissionSet.name,
        ...(grant.permissionSetGroup ? { permissionSetGroup: grant.permissionSetGroup } : {}),
      };
      if (field.readable) {
        if (isMuted("readable")) mutedBy.push(...mutes.filter((mute) => mute.fieldPermissions.some((p) => norm(p.field) === norm(fullFieldName) && p.readable)).map((mute) => mute.name));
        else readGrantedBy.push(source);
      }
      if (field.editable) {
        if (isMuted("editable") || isMuted("readable")) mutedBy.push(...mutes.filter((mute) => mute.fieldPermissions.some((p) => norm(p.field) === norm(fullFieldName) && (p.editable || p.readable))).map((mute) => mute.name));
        else editGrantedBy.push(source);
      }
    }

    // View All Fields removes the need for individual Read FLS, but does not
    // grant Edit on fields or bypass object-level Read.
    if (objectAccess.access.read && objectAccess.access.viewAllFields) {
      readGrantedBy.push(...objectAccess.sources.viewAllFields.grantedBy);
    }

    const dedupe = (sources: PermissionSource[]) => [...new Map(sources.map((s) => [
      `${s.type}:${s.permissionSetGroup ?? ""}:${s.permissionSet}`.toLowerCase(), s
    ])).values()];
    const result = {
      field: fullFieldName,
      // Universally required custom fields cannot have individual FLS entries
      // in Profile/PS XML. Object permission is still necessary. Required-on-
      // layout fields are NOT exempt from FLS.
      readable: objectAccess.access.read && (schemaRequired || permissionable === false || readGrantedBy.length > 0),
      editable: objectAccess.access.edit && (schemaRequired || editGrantedBy.length > 0),
      permissionable,
      schemaRequired,
      readGrantedBy: dedupe(readGrantedBy),
      editGrantedBy: dedupe(editGrantedBy),
      mutedBy: [...new Set(mutedBy)],
    };
    fieldCache.set(fieldKey, result);
    return result;
  }

  function knownObjects(): string[] {
    const names = new Map<string, string>();
    for (const grant of grants) {
      for (const objectPermission of grant.permissionSet.objectPermissions) {
        names.set(norm(objectPermission.object), objectPermission.object);
      }
      for (const fieldPermission of grant.permissionSet.fieldPermissions) {
        const object = fieldPermission.field.split(".")[0];
        if (object) names.set(norm(object), object);
      }
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  return { evaluateObject, evaluateField, knownObjects };
}
