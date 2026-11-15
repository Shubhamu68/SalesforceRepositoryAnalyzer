import type { Persona } from "../models/Persona.js";
import { MATRIX_PERMISSION_KEYS, type MatrixPermission } from "../models/ObjectAccessMatrixResult.js";
import type { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";
import type { SalesforcePersonaAccessVerifier } from "./SalesforcePersonaAccessVerifier.js";

export type OrgPermissionOutcome = "VERIFIED" | "DENIED" | "UNVERIFIED";
export interface OrgPermissionEvidence {
  source: "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
  outcome: OrgPermissionOutcome;
  message: string;
  matchedUsers: number;
  checkedUsers: number;
}

type ObjectEvidence = Record<MatrixPermission, OrgPermissionEvidence>;
type FieldEvidence = Record<"read" | "edit", OrgPermissionEvidence>;
type ActiveUser = { id: string; profileId: string };
type PerUser = Record<MatrixPermission, boolean | null>;
type UserObjectAccess = {
  UserId: string;
  IsReadable?: boolean; IsCreatable?: boolean; IsEditable?: boolean; IsDeletable?: boolean;
};
type Assignment = {
  AssigneeId: string; PermissionSetId?: string | null; PermissionSetGroupId?: string | null;
  IsActive?: boolean; ExpirationDate?: string | null;
};
type OrgSet = {
  Id: string; ProfileId?: string | null; PermissionSetGroupId?: string | null;
  PermissionsViewAllData?: boolean; PermissionsModifyAllData?: boolean;
};
type ObjectGrant = {
  ParentId: string;
  PermissionsViewAllRecords?: boolean;
  PermissionsModifyAllRecords?: boolean;
  PermissionsViewAllFields?: boolean;
};
type FieldAccess = {
  UserId: string; IsAccessible?: boolean; IsUpdatable?: boolean;
  FieldDefinition?: { QualifiedApiName?: string } | null;
};

const ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const key = (value: string) => value.slice(0, 15);
const quote = (value: string) => `'${value}'`;
const BATCH_SIZE = 60;
const CONCURRENCY = 5;
const CACHE_MS = 60_000;
const OBJECT_CRUD = ["read", "create", "edit", "delete"] as const;
const ALL_RECORDS = ["viewAllRecords", "modifyAllRecords", "viewAllFields"] as const;

function chunks<T>(data: readonly T[], size: number): T[][] {
  const items: T[][] = [];
  for (let i = 0; i < data.length; i += size) items.push(data.slice(i, i + size));
  return items;
}

async function concurrently<T, R>(
  items: readonly T[], task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (const batch of chunks(items, CONCURRENCY)) results.push(...await Promise.all(batch.map(task)));
  return results;
}

export function consensus(
  values: readonly (boolean | null)[], permission: string, expected: number, failure?: string
): OrgPermissionEvidence {
  const checkedUsers = values.length;
  const base = { matchedUsers: expected, checkedUsers };
  if (failure || expected === 0 || checkedUsers !== expected || values.some((v) => v === null)) {
    return {
      ...base, source: "UNVERIFIED", outcome: "UNVERIFIED",
      message: `Salesforce org verification failed or returned incomplete access for ${permission}. Needs Review.${failure ? " " + failure : ""} Checked ${checkedUsers}/${expected} matching active users.`,
    };
  }
  const granted = values.filter(Boolean).length;
  if (granted > 0 && granted < expected) return {
    ...base, source: "UNVERIFIED", outcome: "UNVERIFIED",
    message: `Mixed Salesforce access for ${permission}: ${granted}/${expected} matching active users granted. Needs Review.`,
  };
  return granted === expected
    ? { ...base, source: "ORG_VERIFIED", outcome: "VERIFIED",
      message: `Grant not found in repository metadata. Access verified in Salesforce org for all ${expected} matching active users.` }
    : { ...base, source: "ORG_DENIED", outcome: "DENIED",
      message: `Grant not found in repository metadata. Salesforce confirmed no ${permission} grant for any of the ${expected} matching active users.` };
}

function failureEvidence(message: string, permission: string): OrgPermissionEvidence {
  return consensus([], permission, 0, message);
}

/**
 * All-permission fallback for Access Checker and Matrix only.
 *
 * Uses ALL matched active users (Profile + direct PS + PSG). Never selects a
 * representative user to infer permission parity. Standard CRUD uses the
 * Tooling UserEntityAccess effective-access API; View All/Modify All/View All
 * Fields use assigned Profile/PS/PSG aggregate permission metadata.
 *
 * A missing row, unsupported API field, org failure, or mixed access is Review.
 * This does not impersonate users or change the Salesforce org.
 */
export class SalesforceEffectivePermissionVerifier {
  private readonly objectCache = new Map<string, { until: number; value: Promise<ObjectEvidence> }>();
  private readonly fieldCache = new Map<string, { until: number; value: Promise<FieldEvidence> }>();

  constructor(
    private readonly connection: SalesforceOrgConnection,
    private readonly matcher: SalesforcePersonaAccessVerifier,
  ) {}

  private cacheKey(persona: Persona, object: string, field = ""): string {
    return JSON.stringify([
      this.matcher.getVerificationScope(), persona.profile ?? "", persona.name,
      [...persona.permissionSets].sort(), [...persona.permissionSetGroups].sort(), object, field,
    ]);
  }

  private getCached<T>(
    cache: Map<string, { until: number; value: Promise<T> }>,
    cacheKey: string, work: () => Promise<T>
  ): Promise<T> {
    const existing = cache.get(cacheKey);
    if (existing && Date.now() < existing.until) return existing.value;
    if (cache.size > 1000) cache.clear();
    const value = work();
    cache.set(cacheKey, { until: Date.now() + CACHE_MS, value });
    return value;
  }

  verifyObject(persona: Persona, object: string): Promise<ObjectEvidence> {
    return this.getCached(this.objectCache, this.cacheKey(persona, object), () => this.loadObject(persona, object));
  }

  verifyField(persona: Persona, object: string, field: string): Promise<FieldEvidence> {
    return this.getCached(this.fieldCache, this.cacheKey(persona, object, field), () => this.loadField(persona, object, field));
  }

  private async loadObject(persona: Persona, object: string): Promise<ObjectEvidence> {
    const empty = (message: string): ObjectEvidence => Object.fromEntries(
      MATRIX_PERMISSION_KEYS.map((permission) => [permission, failureEvidence(message, `${object} ${permission}`)])
    ) as ObjectEvidence;
    if (!NAME.test(object)) return empty("Invalid Salesforce object API name.");
    let users: ActiveUser[];
    try {
      users = (await this.matcher.matchingActiveUsersForConsensus(persona)).users;
    } catch (error) {
      return empty(error instanceof Error ? error.message : "Unable to match active Salesforce users.");
    }
    const [crud, advanced] = await Promise.allSettled([
      this.loadCrud(users, object),
      this.loadAdvanced(users, object),
    ]);
    const permissionResults = Object.fromEntries(MATRIX_PERMISSION_KEYS.map((permission) => {
      const values = (OBJECT_CRUD as readonly string[]).includes(permission)
        ? crud.status === "fulfilled" ? crud.value[permission] : null
        : advanced.status === "fulfilled" ? advanced.value[permission] : null;
      const failure = (OBJECT_CRUD as readonly string[]).includes(permission)
        ? crud.status === "rejected" ? String(crud.reason instanceof Error ? crud.reason.message : crud.reason) : undefined
        : advanced.status === "rejected" ? String(advanced.reason instanceof Error ? advanced.reason.message : advanced.reason) : undefined;
      return [permission, consensus(values ?? [], `${object} ${permission}`, users.length, failure)];
    }));
    return permissionResults as ObjectEvidence;
  }

  private async loadCrud(users: ActiveUser[], object: string): Promise<Partial<Record<MatrixPermission, (boolean | null)[]>>> {
    const perUser = await concurrently(users, async (user): Promise<Partial<PerUser>> => {
      try {
        const soql = `SELECT UserId, IsReadable, IsCreatable, IsEditable, IsDeletable FROM UserEntityAccess WHERE UserId = '${user.id}' AND EntityDefinition.QualifiedApiName = '${object}'`;
        const rows = await this.connection.queryAll<UserObjectAccess>(soql, "tooling", 2);
        if (rows.length !== 1 || key(rows[0].UserId) !== key(user.id)) return {};
        return { read: rows[0].IsReadable ?? null, create: rows[0].IsCreatable ?? null,
          edit: rows[0].IsEditable ?? null, delete: rows[0].IsDeletable ?? null };
      } catch {
        return {};
      }
    });
    const result: Partial<Record<MatrixPermission, (boolean | null)[]>> = {};
    for (const permission of OBJECT_CRUD) result[permission] = perUser.map((entry) => entry[permission] ?? null);
    return result;
  }

  private async loadAdvanced(users: ActiveUser[], object: string): Promise<Partial<Record<MatrixPermission, (boolean | null)[]>>> {
    const userIds = users.map((u) => u.id);
    const profiles = [...new Set(users.map((u) => u.profileId))];
    const assignments: Assignment[] = [];
    for (const part of chunks(userIds, BATCH_SIZE)) {
      if (part.some((id) => !ID.test(id))) throw new Error("Invalid matched Salesforce user ID.");
      assignments.push(...await this.connection.queryAll<Assignment>(
        `SELECT AssigneeId, PermissionSetId, PermissionSetGroupId, IsActive, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId IN (${part.map(quote).join(",")})`,
        "data", 20000));
    }
    const active = assignments.filter((assignment) =>
      assignment.IsActive !== false &&
      (!assignment.ExpirationDate || new Date(assignment.ExpirationDate).getTime() >= Date.now()));
    const directIds = [...new Set(active.filter((a) => !a.PermissionSetGroupId && a.PermissionSetId && ID.test(a.PermissionSetId))
      .map((a) => a.PermissionSetId!))];
    const groupIds = [...new Set(active.filter((a) => a.PermissionSetGroupId && ID.test(a.PermissionSetGroupId))
      .map((a) => a.PermissionSetGroupId!))];
    const sets: OrgSet[] = [];
    const selectedFields = "Id, ProfileId, PermissionSetGroupId, PermissionsViewAllData, PermissionsModifyAllData";
    const fetchSets = async (field: string, ids: string[]) => {
      for (const part of chunks(ids, BATCH_SIZE)) {
        if (part.some((id) => !ID.test(id))) throw new Error("Invalid Salesforce permission metadata ID.");
        sets.push(...await this.connection.queryAll<OrgSet>(
          `SELECT ${selectedFields} FROM PermissionSet WHERE ${field} IN (${part.map(quote).join(",")})`,
          "data", 20000));
      }
    };
    await fetchSets("ProfileId", profiles);
    await fetchSets("Id", directIds);
    await fetchSets("PermissionSetGroupId", groupIds);
    const byId = new Map(sets.map((set) => [key(set.Id), set]));
    const byProfile = new Map(sets.filter((set) => set.ProfileId).map((set) => [key(set.ProfileId!), set.Id]));
    const byGroup = new Map(sets.filter((set) => set.PermissionSetGroupId).map((set) => [key(set.PermissionSetGroupId!), set.Id]));
    const perUserSets = new Map<string, OrgSet[] | null>();
    for (const user of users) {
      const userSetIds = new Set<string>();
      const profileSet = byProfile.get(key(user.profileId));
      let complete = Boolean(profileSet);
      if (profileSet) userSetIds.add(key(profileSet));
      for (const assignment of active.filter((a) => key(a.AssigneeId) === key(user.id))) {
        // Salesforce can surface profile-owned/system-managed PSA rows with an
        // X-prefixed synthetic PermissionSetId. The user's ProfileId is already
        // represented by its Profile-owned PermissionSet above.
        if (!assignment.PermissionSetGroupId && assignment.PermissionSetId?.startsWith("X")) continue;
        const id = assignment.PermissionSetGroupId
          ? byGroup.get(key(assignment.PermissionSetGroupId))
          : assignment.PermissionSetId;
        if (!id || !byId.has(key(id))) complete = false;
        else userSetIds.add(key(id));
      }
      perUserSets.set(key(user.id), complete
        ? [...userSetIds].map((id) => byId.get(id)!).filter(Boolean)
        : null);
    }
    const allSetIds = [...new Set([...perUserSets.values()].flatMap((entries) => entries?.map((set) => set.Id) ?? []))];
    const baseGrants: ObjectGrant[] = [];
    const fieldGrants: ObjectGrant[] = [];
    let viewAllFieldsFailure: string | undefined;
    for (const part of chunks(allSetIds, BATCH_SIZE)) {
      baseGrants.push(...await this.connection.queryAll<ObjectGrant>(
        `SELECT ParentId, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE SobjectType = '${object}' AND ParentId IN (${part.map(quote).join(",")})`,
        "data", 20000));
      try {
        fieldGrants.push(...await this.connection.queryAll<ObjectGrant>(
          `SELECT ParentId, PermissionsViewAllFields FROM ObjectPermissions WHERE SobjectType = '${object}' AND ParentId IN (${part.map(quote).join(",")})`,
          "data", 20000, "v63.0"));
      } catch (error) {
        viewAllFieldsFailure = error instanceof Error ? error.message : "View All Fields metadata unavailable.";
      }
    }
    const byParent = new Map(baseGrants.map((g) => [key(g.ParentId), g]));
    const fieldByParent = new Map(fieldGrants.map((g) => [key(g.ParentId), g]));
    const out: Partial<Record<MatrixPermission, (boolean | null)[]>> = {};
    for (const permission of ALL_RECORDS) out[permission] = users.map((user) => {
      const entries = perUserSets.get(key(user.id));
      if (!entries) return null;
      if (permission === "viewAllFields" && viewAllFieldsFailure) return null;
      return entries.some((set) => {
        const objectGrant = byParent.get(key(set.Id));
        if (permission === "viewAllFields") return fieldByParent.get(key(set.Id))?.PermissionsViewAllFields === true;
        if (permission === "modifyAllRecords") return set.PermissionsModifyAllData === true || objectGrant?.PermissionsModifyAllRecords === true;
        return set.PermissionsViewAllData === true || set.PermissionsModifyAllData === true ||
          objectGrant?.PermissionsViewAllRecords === true || objectGrant?.PermissionsModifyAllRecords === true;
      });
    });
    return out;
  }

  private async loadField(persona: Persona, object: string, field: string): Promise<FieldEvidence> {
    const empty = (message: string): FieldEvidence => ({
      read: failureEvidence(message, `${object}.${field} field Read`),
      edit: failureEvidence(message, `${object}.${field} field Edit`),
    });
    if (!NAME.test(object) || !NAME.test(field)) return empty("Invalid Salesforce object or field API name.");
    let users: ActiveUser[];
    try {
      users = (await this.matcher.matchingActiveUsersForConsensus(persona)).users;
    } catch (error) {
      return empty(error instanceof Error ? error.message : "Unable to match active Salesforce users.");
    }
    const result = await concurrently(users, async (user): Promise<{ read: boolean | null; edit: boolean | null }> => {
      try {
        const soql = `SELECT UserId, IsAccessible, IsUpdatable, FieldDefinition.QualifiedApiName FROM UserFieldAccess WHERE User.Id = '${user.id}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}' AND FieldDefinition.QualifiedApiName = '${field}'`;
        const records = await this.connection.queryAll<FieldAccess>(soql, "tooling", 5);
        const row = records.length === 1 ? records[0] : null;
        if (!row || key(row.UserId) !== key(user.id) ||
            row.FieldDefinition?.QualifiedApiName?.toLowerCase() !== field.toLowerCase()) return { read: null, edit: null };
        return { read: typeof row.IsAccessible === "boolean" ? row.IsAccessible : null,
          edit: typeof row.IsUpdatable === "boolean" ? row.IsUpdatable : null };
      } catch {
        return { read: null, edit: null };
      }
    });
    return {
      read: consensus(result.map((entry) => entry.read), `${object}.${field} field Read`, users.length),
      edit: consensus(result.map((entry) => entry.edit), `${object}.${field} field Edit`, users.length),
    };
  }
}
