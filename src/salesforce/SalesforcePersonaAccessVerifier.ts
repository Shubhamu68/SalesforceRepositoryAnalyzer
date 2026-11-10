import type { Persona } from "../models/Persona.js";
import type { OrgCheckedUser } from "../models/StackTraceImpact.js";
import { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";
import { matchPersonaUsers, type OrgAssignment, type OrgProfile, type OrgUser } from "./OrgPersonaMatcher.js";

export type OrgAccessOutcome = "VERIFIED" | "DENIED" | "UNVERIFIED";
export interface OrgObjectAccessEvidence {
  object: string;
  field?: string;
  outcome: OrgAccessOutcome;
  /** Active users matching the configured Profile and required PS/PSG subset. */
  matchedUsers: number;
  /** Number actually checked via UserEntityAccess. */
  checkedUsers: number;
  /** True if there were additional exact matches beyond the verification cap. */
  sampled: boolean;
  /** Name and username of each user actually checked in Salesforce. */
  checkedUserDetails?: OrgCheckedUser[];
  verifiedAt?: string;
  message: string;
}

type SfProfile = { Id: string; Name: string };
type SfUser = { Id: string; ProfileId: string; Name?: string; Username?: string };
type SfGroup = { Id: string; DeveloperName: string };
type SfAssignment = {
  AssigneeId: string;
  PermissionSetId: string | null;
  PermissionSetGroupId: string | null;
  IsActive?: boolean;
  ExpirationDate?: string | null;
};
type SfPermissionSet = { Id: string; Name: string | null; IsOwnedByProfile?: boolean };
type SfUserEntityAccess = { UserId: string; IsReadable: boolean };
type SfUserFieldAccess = { UserId: string; IsAccessible: boolean; FieldDefinition?: { QualifiedApiName?: string } | null };

type Inventory = {
  profiles: OrgProfile[];
  users: OrgUser[];
  userDetails: Map<string, OrgCheckedUser>;
  assignments: Map<string, OrgAssignment>;
  /** Names returned for directly assignable (non-profile-owned) Permission Sets. */
  knownPermissionSetNames: Set<string>;
  knownGroupNames: Set<string>;
  /** Some user assignments could not be classified; never silently treat these as known grants. */
  unclassifiedAssignmentsByUser: Map<string, number>;
};
const CACHE_MS = 3 * 60 * 1000;
const MAX_USERS_PER_PERSONA = 25;
const VERIFY_CONCURRENCY = 5;
const USER_CHUNK = 100;
const objectNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const userIdPattern = /^005[A-Za-z0-9]{12,15}$/;
const sfIdPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const normalized = (name: string) => name.trim().toLowerCase();
// REST references can be returned as either 15- or 18-character Salesforce IDs.
// The first 15 characters are the case-sensitive core of either representation.
const idKey = (id: string) => id.slice(0, 15);
const quoteId = (id: string) => `'${id}'`; // IDs are validated before interpolation.

/**
 * Live checks are supplementary evidence. This service does not impersonate a
 * persona, grant FLS, or change any Salesforce configuration.
 */
export class SalesforcePersonaAccessVerifier {
  private inventoryCache: { key: string; until: number; value: Inventory } | null = null;
  private inventoryInflight: Promise<Inventory> | null = null;
  // Many fields on one object share the same user-level FLS response.
  // Cache the in-flight request to avoid duplicate Tooling API calls.
  private fieldAccessCache = new Map<string, { expires: number; promise: Promise<Map<string, boolean>> }>();
  private singleFieldCache = new Map<string, { expires: number; promise: Promise<boolean | null> }>();

  constructor(private readonly connection: SalesforceOrgConnection) {}

  private async inventory(): Promise<Inventory> {
    await this.connection.connect();
    const status = this.connection.status;
    const key = `${status.organizationId ?? ""}|${status.instanceUrl ?? ""}`;
    if (this.inventoryCache?.key === key && Date.now() < this.inventoryCache.until) return this.inventoryCache.value;
    if (this.inventoryInflight) return this.inventoryInflight;
    this.inventoryInflight = this.loadInventory().then((value) => {
      this.inventoryCache = { key, until: Date.now() + CACHE_MS, value };
      return value;
    }).finally(() => { this.inventoryInflight = null; });
    return this.inventoryInflight;
  }

  private async loadInventory(): Promise<Inventory> {
    const profiles = await this.connection.queryAll<SfProfile>(
      "SELECT Id, Name FROM Profile", "data", 1500);
    const groups = await this.connection.queryAll<SfGroup>(
      "SELECT Id, DeveloperName FROM PermissionSetGroup", "data", 5000);
    const users = await this.connection.queryAll<SfUser>(
      "SELECT Id, Name, Username, ProfileId FROM User WHERE IsActive = true", "data", 20000);
    if (profiles.some((p) => !p.Id || !p.Name) || users.some((u) => !u.Id || !u.ProfileId)) {
      throw new Error("Incomplete Salesforce Profile/User metadata; persona matching is inconclusive.");
    }
    const groupNames = new Map(groups.map((group) => [idKey(group.Id), group.DeveloperName]));
    const knownGroupNames = new Set(groups.map((group) => normalized(group.DeveloperName)));

    // Query actual, non-profile-owned Permission Sets once. Do NOT build a list
    // of every PermissionSetId found on every active user's assignments and then
    // require 100% of those IDs to resolve. Salesforce includes system-managed
    // Profile assignment rows, and unrelated unresolvable assignments must not
    // block verification for all personas.
    const definitions = await this.connection.queryAll<SfPermissionSet>(
      "SELECT Id, Name, IsOwnedByProfile FROM PermissionSet WHERE IsOwnedByProfile = false",
      "data", 50000);
    const permissionSets = new Map<string, SfPermissionSet>();
    const knownPermissionSetNames = new Set<string>();
    for (const ps of definitions) {
      // A platform-owned definition with missing Name cannot be used as a
      // matching grant. Don't let it abort checks for unrelated personas.
      if (!sfIdPattern.test(ps.Id) || !ps.Name?.trim()) continue;
      permissionSets.set(idKey(ps.Id), ps);
      knownPermissionSetNames.add(normalized(ps.Name));
    }

    const assignments = new Map<string, OrgAssignment>();
    const unclassifiedAssignmentsByUser = new Map<string, number>();
    const noteUnclassified = (userId: string) => {
      const key = idKey(userId);
      unclassifiedAssignmentsByUser.set(key, (unclassifiedAssignmentsByUser.get(key) ?? 0) + 1);
    };

    for (let i = 0; i < users.length; i += USER_CHUNK) {
      const ids = users.slice(i, i + USER_CHUNK).map((user) => user.Id);
      if (ids.some((id) => !userIdPattern.test(id))) {
        throw new Error("Unexpected Salesforce User ID; unable to verify persona assignments.");
      }
      const soql = `SELECT AssigneeId, PermissionSetId, PermissionSetGroupId, IsActive, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId IN (${ids.map(quoteId).join(",")})`;
      const records = await this.connection.queryAll<SfAssignment>(soql, "data", 20000);
      for (const record of records) {
        if (record.IsActive === false ||
            (record.ExpirationDate && new Date(record.ExpirationDate).getTime() < Date.now())) continue;
        if (!userIdPattern.test(record.AssigneeId)) {
          throw new Error("Salesforce returned an invalid assignment user ID.");
        }
        const userId = idKey(record.AssigneeId);
        const existing = assignments.get(userId) ?? {
          userId, permissionSets: new Set<string>(), permissionSetGroups: new Set<string>()
        };
        if (record.PermissionSetGroupId) {
          const groupName = groupNames.get(idKey(record.PermissionSetGroupId));
          if (groupName) existing.permissionSetGroups.add(normalized(groupName));
          else noteUnclassified(userId);
        } else if (record.PermissionSetId && sfIdPattern.test(record.PermissionSetId)) {
          const ps = permissionSets.get(idKey(record.PermissionSetId));
          if (ps?.Name) existing.permissionSets.add(normalized(ps.Name));
          else {
            // Common for Profile-backed/system-managed assignments. The user's
            // Profile is evaluated independently using User.ProfileId.
            noteUnclassified(userId);
          }
        } else {
          noteUnclassified(userId);
        }
        assignments.set(userId, existing);
      }
    }
    return {
      profiles: profiles.map((p) => ({ id: idKey(p.Id), name: p.Name })),
      users: users.map((u) => ({ id: idKey(u.Id), profileId: idKey(u.ProfileId) })),
      userDetails: new Map(users.map((u) => [idKey(u.Id), {
        id: idKey(u.Id),
        name: u.Name?.trim() || "Name unavailable",
        username: u.Username?.trim() || "Username unavailable"
      }])),
      assignments,
      knownPermissionSetNames,
      knownGroupNames,
      unclassifiedAssignmentsByUser
    };
  }

  /**
   * Find active users whose Profile and every CONFIGURED PS/PSG match.
   * Extra grants are allowed and are not exposed as warnings in the UI.
   * UserFieldAccess/UserEntityAccess measure the matched users' effective access;
   * they do not attribute access to an individual Permission Set.
   */
  private async matchingUsers(persona: Persona): Promise<{
    users: string[]; checkedUserDetails: OrgCheckedUser[]; matchedUsers: number; sampled: boolean;
  }> {
    const inventory = await this.inventory();
    const unavailableSets = (persona.permissionSets ?? []).filter(
      (name) => !inventory.knownPermissionSetNames.has(normalized(name)));
    if (unavailableSets.length) throw new Error(
      `Required Permission Sets not found in Salesforce: ${unavailableSets.join(", ")}.`);
    const unavailableGroups = (persona.permissionSetGroups ?? []).filter(
      (name) => !inventory.knownGroupNames.has(normalized(name)));
    if (unavailableGroups.length) throw new Error(
      `Required Permission Set Groups not found in Salesforce: ${unavailableGroups.join(", ")}.`);
    const match = matchPersonaUsers(persona, inventory.profiles, inventory.users, inventory.assignments);
    if (!match.eligibleCount) throw new Error(match.reason ?? "No matching active users.");
    const users = match.users.slice(0, MAX_USERS_PER_PERSONA);
    const checkedUserDetails = users.map((userId) => inventory.userDetails.get(idKey(userId)) ?? {
      id: idKey(userId), name: "Name unavailable", username: "Username unavailable"
    });
    return { users, checkedUserDetails, matchedUsers: match.eligibleCount, sampled: users.length < match.eligibleCount };
  }

  /**
   * A verified permission must hold for ALL matching active users, never merely
   * the first user or a successful subset. A single explicit false is a real
   * denial for at least one matched user. API/metadata failures are inconclusive.
   */
  private decide(
    object: string, field: string | undefined,
    matchedUsers: number, checkedUsers: number, sampled: boolean,
    checkedUserDetails: OrgCheckedUser[], results: Array<boolean | null>, errorLabel: string
  ): OrgObjectAccessEvidence {
    const common = {
      object, ...(field ? { field } : {}), matchedUsers, checkedUsers, sampled,
      checkedUserDetails, verifiedAt: new Date().toISOString()
    };
    const denied = results.filter((value) => value === false).length;
    const unknown = results.filter((value) => value === null).length;
    if (denied > 0) return { ...common, outcome: "DENIED",
      message: `Salesforce denied ${errorLabel} for ${denied} of ${checkedUsers} checked matching active users.` };
    if (unknown > 0 || sampled || checkedUsers !== matchedUsers) return {
      ...common, outcome: "UNVERIFIED",
      message: `Salesforce confirmed ${checkedUsers - unknown} users, but could not verify all ${matchedUsers} matched users for ${errorLabel}.`
    };
    if (checkedUsers === 0) return { ...common, outcome: "UNVERIFIED",
      message: `No matching users could be checked for ${errorLabel}.` };
    return { ...common, outcome: "VERIFIED",
      message: `Access verified from Salesforce for all ${checkedUsers} matching active users.` };
  }

  async verifyObjectRead(persona: Persona, object: string): Promise<OrgObjectAccessEvidence> {
    const uncertain = (message: string): OrgObjectAccessEvidence => ({
      object, outcome: "UNVERIFIED", matchedUsers: 0, checkedUsers: 0, sampled: false, message
    });
    if (!objectNamePattern.test(object)) return uncertain("Invalid Salesforce object API name.");
    try {
      const { users, checkedUserDetails, matchedUsers, sampled } = await this.matchingUsers(persona);
      const readable: Array<boolean | null> = [];
      for (let i = 0; i < users.length; i += VERIFY_CONCURRENCY) {
        const batch = users.slice(i, i + VERIFY_CONCURRENCY);
        const results = await Promise.all(batch.map(async (userId): Promise<boolean | null> => {
          try {
            const soql = `SELECT UserId, IsReadable FROM UserEntityAccess WHERE UserId = '${userId}' AND EntityDefinition.QualifiedApiName = '${object}'`;
            const rows = await this.connection.queryAll<SfUserEntityAccess>(soql, "tooling", 2);
            return rows.length === 1 && idKey(rows[0].UserId) === idKey(userId) && typeof rows[0].IsReadable === "boolean"
              ? rows[0].IsReadable : null;
          } catch { return null; }
        }));
        readable.push(...results);
      }
      return this.decide(object, undefined, matchedUsers, readable.length, sampled, checkedUserDetails, readable, `${object} object Read`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salesforce verification failed.";
      return uncertain(`Unable to verify object Read from Salesforce: ${message}`);
    }
  }

  /**
   * Queries field-level access for a particular User + sObject. The Tooling API
   * supports filtering UserFieldAccess by User.Id and the field's object.
   * A missing field row is NOT the same as IsAccessible=false.
   */
  private async fieldAccessByUserAndObject(userId: string, object: string): Promise<Map<string, boolean>> {
    const status = this.connection.status;
    const cacheKey = `${status.organizationId ?? status.instanceUrl ?? ""}|${idKey(userId)}|${normalized(object)}`;
    const cached = this.fieldAccessCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const soql = `SELECT UserId, FieldDefinition.QualifiedApiName, IsAccessible FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}'`;
    const promise = this.connection.queryAll<SfUserFieldAccess>(soql, "tooling", 20000).then((rows) => {
      const fields = new Map<string, boolean>();
      for (const row of rows) {
        const field = row.FieldDefinition?.QualifiedApiName;
        if (idKey(row.UserId) !== idKey(userId) || !field || typeof row.IsAccessible !== "boolean") continue;
        const key = normalized(field);
        // If Salesforce returns conflicting rows, treat the field as unresolved
        // rather than incorrectly claiming Read is granted.
        if (fields.has(key) && fields.get(key) !== row.IsAccessible) fields.delete(key);
        else fields.set(key, row.IsAccessible);
      }
      return fields;
    });
    this.fieldAccessCache.set(cacheKey, { expires: Date.now() + CACHE_MS, promise });
    return promise;
  }

  /** If an object-wide UserFieldAccess response omitted a field (or Salesforce
   * rejected that broad query), retry using the documented field-specific
   * filter. Neither a missing row nor an API error is interpreted as denial. */
  private async fieldAccessForUser(userId: string, object: string, field: string): Promise<boolean | null> {
    try {
      const all = await this.fieldAccessByUserAndObject(userId, object);
      const value = all.get(normalized(field));
      if (typeof value === "boolean") return value;
    } catch {
      // Some orgs may reject broad UserFieldAccess queries. Try a field filter.
    }
    const status = this.connection.status;
    const cacheKey = `${status.organizationId ?? status.instanceUrl ?? ""}|${idKey(userId)}|${normalized(object)}|${normalized(field)}`;
    const cached = this.singleFieldCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const soql = `SELECT UserId, IsAccessible, FieldDefinition.QualifiedApiName FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}' AND FieldDefinition.QualifiedApiName = '${field}'`;
    const promise = this.connection.queryAll<SfUserFieldAccess>(soql, "tooling", 5)
      .then((rows): boolean | null => rows.length === 1 &&
        idKey(rows[0].UserId) === idKey(userId) &&
        normalized(rows[0].FieldDefinition?.QualifiedApiName ?? "") === normalized(field) &&
        typeof rows[0].IsAccessible === "boolean" ? rows[0].IsAccessible : null)
      .catch(() => null);
    this.singleFieldCache.set(cacheKey, { expires: Date.now() + CACHE_MS, promise });
    return promise;
  }

  async verifyFieldRead(persona: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence> {
    const uncertain = (message: string): OrgObjectAccessEvidence => ({
      object, field, outcome: "UNVERIFIED", matchedUsers: 0, checkedUsers: 0, sampled: false, message
    });
    if (!objectNamePattern.test(object) || !objectNamePattern.test(field)) {
      return uncertain("Invalid Salesforce field API name.");
    }
    try {
      const { users, checkedUserDetails, matchedUsers, sampled } = await this.matchingUsers(persona);
      const readable: Array<boolean | null> = [];
      for (let i = 0; i < users.length; i += VERIFY_CONCURRENCY) {
        const batch = users.slice(i, i + VERIFY_CONCURRENCY);
        const results = await Promise.all(batch.map(async (userId): Promise<boolean | null> => {
          try {
            return await this.fieldAccessForUser(userId, object, field);
          } catch { return null; }
        }));
        readable.push(...results);
      }
      return this.decide(object, field, matchedUsers, readable.length, sampled, checkedUserDetails, readable, `${object}.${field} field Read`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salesforce verification failed.";
      return uncertain(`Unable to verify field Read from Salesforce: ${message}`);
    }
  }
}
