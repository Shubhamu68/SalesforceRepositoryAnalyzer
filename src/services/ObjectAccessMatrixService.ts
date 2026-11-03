import path from "node:path";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver, type ResolvedPersonaPermissions } from "../analyzer/PersonaPermissionResolver.js";
import { parseMutingPermissionSet } from "../parser/mutingPermissionSetParser.js";
import type { ObjectPermission } from "../models/ObjectPermission.js";
import type { PermissionSet } from "../models/PermissionSet.js";
import type { PermissionSource } from "../analyzer/permissionAggregator.js";
import {
  MATRIX_PERMISSION_KEYS,
  type MatrixPermission,
  type MatrixAccess,
  type MatrixPermissionSources,
  type ObjectAccessMatrixPersona,
  type ObjectAccessMatrixResult,
  type MutedPermissionSource,
} from "../models/ObjectAccessMatrixResult.js";

// Map the UI's permission names to Salesforce Metadata API objectPermission names.
const METADATA_KEYS: Record<MatrixPermission, keyof ObjectPermission> = {
  read: "allowRead",
  create: "allowCreate",
  edit: "allowEdit",
  delete: "allowDelete",
  viewAllRecords: "viewAllRecords",
  modifyAllRecords: "modifyAllRecords",
  viewAllFields: "viewAllFields",
};

const equal = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function hasGrant(
  permissionSet: PermissionSet,
  objectName: string,
  permission: MatrixPermission
): boolean {
  return permissionSet.objectPermissions.some(
    (record) => equal(record.object, objectName) && record[METADATA_KEYS[permission]] === true
  );
}

/** Salesforce mutes dependent object permissions within the same PSG. */
function hasMute(
  permissionSet: PermissionSet,
  objectName: string,
  permission: MatrixPermission
): boolean {
  const mutedRead = hasGrant(permissionSet, objectName, "read");
  // Muting Read removes dependent object operations within that PSG.
  if (mutedRead && ["create", "edit", "delete", "viewAllRecords", "modifyAllRecords"].includes(permission)) {
    return true;
  }
  // Muting Delete also removes Modify All Records.
  if (permission === "modifyAllRecords" && hasGrant(permissionSet, objectName, "delete")) {
    return true;
  }
  return hasGrant(permissionSet, objectName, permission);
}

function emptyAccess(): MatrixAccess {
  return {
    read: false,
    create: false,
    edit: false,
    delete: false,
    viewAllRecords: false,
    modifyAllRecords: false,
    viewAllFields: false,
  };
}

function emptySources(): Record<MatrixPermission, MatrixPermissionSources> {
  return {
    read: { grantedBy: [], mutedBy: [] },
    create: { grantedBy: [], mutedBy: [] },
    edit: { grantedBy: [], mutedBy: [] },
    delete: { grantedBy: [], mutedBy: [] },
    viewAllRecords: { grantedBy: [], mutedBy: [] },
    modifyAllRecords: { grantedBy: [], mutedBy: [] },
    viewAllFields: { grantedBy: [], mutedBy: [] },
  };
}

/**
 * Resolve all seven object permissions using group-scoped muting.
 * A mute removes grants from its own PSG only; direct PS grants and other
 * PSGs continue to contribute, as they do in Salesforce.
 *
 * Exported for focused tests, without filesystem fixtures.
 */
export function calculateMatrixPersona(
  objectName: string,
  resolved: ResolvedPersonaPermissions,
  mutesByGroup: ReadonlyMap<string, readonly PermissionSet[]>,
  warnings: string[] = []
): ObjectAccessMatrixPersona {
  const access = emptyAccess();
  const sources = emptySources();

  for (const key of MATRIX_PERMISSION_KEYS) {
    const contributions: PermissionSource[] = [];
    const mutedBy: MutedPermissionSource[] = [];

    for (const group of resolved.permissionSetGroups) {
      const groupGrants = group.permissionSets.filter((ps) => hasGrant(ps, objectName, key));
      if (groupGrants.length === 0) continue;

      const mutingSets = mutesByGroup.get(group.name) ?? [];
      const activeMutes = mutingSets.filter((ps) => hasMute(ps, objectName, key));

      if (activeMutes.length > 0) {
        for (const mute of activeMutes) {
          mutedBy.push({
            permissionSetGroup: group.name,
            mutingPermissionSet: mute.name,
            affectedPermissionSets: groupGrants.map((ps) => ps.name),
          });
        }
      } else {
        for (const ps of groupGrants) {
          contributions.push({
            permissionSet: ps.name,
            type: "permissionSetGroup",
            permissionSetGroup: group.name,
          });
        }
      }
    }

    // A separately assigned Permission Set is unaffected by a PSG mute.
    for (const ps of resolved.directPermissionSets) {
      if (hasGrant(ps, objectName, key)) {
        contributions.push({ permissionSet: ps.name, type: "directPermissionSet" });
      }
    }

    // Avoid duplicate sources in case the metadata lists a PS more than once.
    const deduplicated = new Map<string, PermissionSource>();
    for (const source of contributions) {
      const id = `${source.type}|${source.permissionSetGroup ?? ""}|${source.permissionSet}`.toLowerCase();
      deduplicated.set(id, source);
    }

    sources[key] = { grantedBy: [...deduplicated.values()], mutedBy };
    access[key] = deduplicated.size > 0;
  }

  return {
    personaName: resolved.persona.name,
    access,
    sources,
    warnings,
  };
}

export class ObjectAccessMatrixService {
  constructor(
    private readonly personaConfigLoader: PersonaConfigLoader,
    private readonly personaPermissionResolver: PersonaPermissionResolver,
    private readonly mutingPermissionSetsDirectory: string
  ) {}

  async analyze(objectName: string): Promise<ObjectAccessMatrixResult> {
    const object = objectName.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object) || object.length > 255) {
      throw new Error("Invalid object API name. Enter a Salesforce object API name, such as Account or OrderSummary.");
    }

    const personas = await this.personaConfigLoader.getAllPersonas();
    const results: ObjectAccessMatrixPersona[] = [];

    // Request-local promise cache prevents repeated parsing of the same mute set.
    const muteCache = new Map<string, Promise<PermissionSet>>();
    function cachedMute(filePath: string): Promise<PermissionSet> {
      let cached = muteCache.get(filePath);
      if (!cached) {
        cached = parseMutingPermissionSet(filePath);
        muteCache.set(filePath, cached);
      }
      return cached;
    }

    // Limited concurrency avoids creating hundreds of simultaneous file reads.
    for (let start = 0; start < personas.length; start += 5) {
      const chunk = personas.slice(start, start + 5);
      const chunkResults = await Promise.all(chunk.map(async (persona) => {
        const resolved = await this.personaPermissionResolver.resolve(persona);
        const warnings: string[] = [];
        const mutesByGroup = new Map<string, PermissionSet[]>();

        for (const name of persona.permissionSetGroups) {
          if (!resolved.permissionSetGroups.some((group) => equal(group.name, name))) {
            warnings.push(`Permission Set Group metadata unavailable: ${name}`);
          }
        }
        for (const name of persona.permissionSets) {
          if (!resolved.directPermissionSets.some((ps) => equal(ps.name, name))) {
            warnings.push(`Direct Permission Set metadata unavailable: ${name}`);
          }
        }

        for (const group of resolved.permissionSetGroups) {
          for (const name of group.permissionSetNames) {
            if (!group.permissionSets.some((ps) => equal(ps.name, name))) {
              warnings.push(`Permission Set metadata unavailable: ${name} (PSG: ${group.name})`);
            }
          }

          // The PSG XML is authoritative for which mute belongs to which group.
          // Older persona configs may list a mute separately; for a single PSG,
          // that explicit list is an unambiguous fallback if PSG XML omits it.
          const muteNames = group.mutingPermissionSetNames.length > 0
            ? group.mutingPermissionSetNames
            : resolved.permissionSetGroups.length === 1
              ? persona.mutingPermissionSets
              : [];

          const muted: PermissionSet[] = [];
          for (const muteName of [...new Set(muteNames)]) {
            try {
              const filePath = path.join(
                this.mutingPermissionSetsDirectory,
                `${muteName}.mutingpermissionset-meta.xml`
              );
              muted.push(await cachedMute(filePath));
            } catch {
              warnings.push(`Muting Permission Set metadata unavailable: ${muteName} (PSG: ${group.name})`);
            }
          }
          mutesByGroup.set(group.name, muted);
        }

        if (resolved.permissionSetGroups.length > 1) {
          const linked = new Set(resolved.permissionSetGroups.flatMap((group) => group.mutingPermissionSetNames));
          for (const configured of persona.mutingPermissionSets) {
            if (![...linked].some((name) => equal(name, configured))) {
              warnings.push(`Cannot associate configured muting set ${configured} to a PSG; add it to the correct PSG metadata.`);
            }
          }
        }

        return calculateMatrixPersona(object, resolved, mutesByGroup, warnings);
      }));
      results.push(...chunkResults);
    }

    return {
      object,
      personas: results,
      totalPersonas: results.length,
      personasWithRead: results.filter((persona) => persona.access.read).length,
      warnings: [...new Set(results.flatMap((persona) => persona.warnings))],
    };
  }
}
