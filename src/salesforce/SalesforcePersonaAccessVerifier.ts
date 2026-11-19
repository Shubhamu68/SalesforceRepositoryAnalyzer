import type { Persona } from "../models/Persona.js";
import type { OrgCheckedUser } from "../models/StackTraceImpact.js";
import { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";
import { matchPersonaUsers, selectMostRecentlyLoggedInMatchedUser, type OrgAssignment, type OrgProfile, type OrgUser } from "./OrgPersonaMatcher.js";
import { SalesforceUserFieldAccessGateway } from "./SalesforceUserFieldAccessGateway.js";
import { SalesforceFieldMetadataService } from "./SalesforceFieldMetadataService.js";
import { noteSoqlUserMatching } from "../services/SoqlAnalysisProgress.js";

export type OrgAccessOutcome = "VERIFIED" | "DENIED" | "UNVERIFIED";
export interface OrgObjectAccessEvidence {
  object: string;
  field?: string;
  outcome: OrgAccessOutcome;
  /** Number of representative users selected for verification (currently 1). */
  matchedUsers: number;
  /** Total persona-matched active users before representative selection. */
  eligibleUsers?: number;
  /** Number actually checked via UserEntityAccess or UserFieldAccess. */
  checkedUsers: number;
  /** Legacy compatibility flag; false for newest-user representative checks. */
  sampled: boolean;
  /** Name and username of each user actually checked in Salesforce. */
  checkedUserDetails?: OrgCheckedUser[];
  verifiedAt?: string;
  /** When exact UserFieldAccess is absent, verified Read via a metadata-linked compound parent. */
  compoundParent?: string;
  message: string;
  /** Structured explanation for an inconclusive check (never inferred from message text). */
  selectionMethod?: "RECENT_LOGIN" | "ACTIVE_UNFROZEN_FALLBACK";
  unverifiedReason?: "NO_MATCHING_USERS" | "NO_LOGGED_IN_USERS" | "NO_UNFROZEN_USERS";
}

type MatchedUsers = {
  users: string[];
  checkedUserDetails: OrgCheckedUser[];
  matchedUsers: number;
  sampled: boolean;
  eligibleUsers: number;
  selectionMethod: "RECENT_LOGIN" | "ACTIVE_UNFROZEN_FALLBACK";
};

/** The org responded, but no active users could be associated with this persona. */
class NoMatchingOrgUsersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMatchingOrgUsersError";
  }
}

/** Matching active users had no confirmed unfrozen login records. */
class NoUnfrozenOrgUsersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoUnfrozenOrgUsersError";
  }
}

type SfProfile = { Id: string; Name: string };
type SfUser = { Id: string; ProfileId: string; Name?: string; Username?: string; LastLoginDate?: string | null };
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
type SfUserLogin = { UserId: string; IsFrozen: boolean };

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
  // Deduplicate concurrent user selection across many OLS/FLS checks. The
  // inventory WeakMap isolates results across orgs and metadata refreshes.
  private readonly matchingCache = new WeakMap<Inventory, Map<string, Promise<MatchedUsers>>>();
  constructor(
    private readonly connection: SalesforceOrgConnection,
    private readonly userFieldAccess = new SalesforceUserFieldAccessGateway(
      connection, new SalesforceFieldMetadataService(connection)),
  ) {}

  /** Cache isolation across Salesforce orgs and reconnects. */
  getVerificationScope(): string {
    const status = this.connection.status;
    return `${status.organizationId ?? "not-connected"}|${status.instanceUrl ?? ""}`;
  }

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
      "SELECT Id, Name, Username, ProfileId, LastLoginDate FROM User WHERE IsActive = true", "data", 20000);
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
      users: users.map((u) => ({ id: idKey(u.Id), profileId: idKey(u.ProfileId), lastLoginDate: u.LastLoginDate ?? null })),
      userDetails: new Map(users.map((u) => [idKey(u.Id), {
        id: idKey(u.Id),
        name: u.Name?.trim() || "Name unavailable",
        username: u.Username?.trim() || "Username unavailable",
        ...(u.LastLoginDate ? { lastLoginDate: u.LastLoginDate } : {}),
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
  private async matchingUsers(persona: Persona): Promise<MatchedUsers> {
    // Progress is request-scoped; this is emitted only for actual org lookups.
    noteSoqlUserMatching();
    const inventory = await this.inventory();
    const cacheKey = JSON.stringify([
      normalized(persona.profile ?? ""),
      [...(persona.permissionSets ?? [])].map(normalized).sort(),
      [...(persona.permissionSetGroups ?? [])].map(normalized).sort()
    ]);
    let cache = this.matchingCache.get(inventory);
    if (!cache) {
      cache = new Map();
      this.matchingCache.set(inventory, cache);
    }
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Publish the in-flight lookup before its first asynchronous API request.
    const pending = this.selectMatchingUnfrozenUser(persona, inventory);
    cache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      // Transient Salesforce/metadata errors should be retried, while known
      // no-match/no-unfrozen conclusions remain stable for this inventory.
      if (!(error instanceof NoMatchingOrgUsersError || error instanceof NoUnfrozenOrgUsersError)) {
        cache.delete(cacheKey);
      }
      throw error;
    }
  }

  private async selectMatchingUnfrozenUser(persona: Persona, inventory: Inventory): Promise<MatchedUsers> {
    const missingSets = (persona.permissionSets ?? []).filter(
      name => !inventory.knownPermissionSetNames.has(normalized(name)));
    if (missingSets.length) throw new Error(
      `Required Permission Sets not found in Salesforce: ${missingSets.join(", ")}.`);
    const missingGroups = (persona.permissionSetGroups ?? []).filter(
      name => !inventory.knownGroupNames.has(normalized(name)));
    if (missingGroups.length) throw new Error(
      `Required Permission Set Groups not found in Salesforce: ${missingGroups.join(", ")}.`);
    if (!persona.profile?.trim()) throw new Error("Persona has no configured Profile; org-user matching is inconclusive.");

    const match = matchPersonaUsers(persona, inventory.profiles, inventory.users, inventory.assignments);
    if (!match.eligibleCount) throw new NoMatchingOrgUsersError(
      match.reason ?? "No matching active users.");

    // Inventory already selects User.IsActive=true. Confirm IsFrozen=false
    // separately via UserLogin; never infer unfrozen status from LastLoginDate.
    // Query only persona-matched users, in bounded batches.
    const unfrozen = new Set<string>();
    const frozen = new Set<string>();
    for (let i = 0; i < match.users.length; i += USER_CHUNK) {
      const ids = match.users.slice(i, i + USER_CHUNK);
      if (ids.some(id => !userIdPattern.test(id))) {
        throw new Error("Unexpected matched Salesforce User ID; verification is inconclusive.");
      }
      const query = `SELECT UserId, IsFrozen FROM UserLogin WHERE UserId IN (${ids.map(quoteId).join(",")})`;
      const rows = await this.connection.queryAll<SfUserLogin>(query, "data", USER_CHUNK * 2);
      const requested = new Set(ids.map(idKey));
      for (const row of rows) {
        if (!row.UserId || !requested.has(idKey(row.UserId))) continue;
        const id = idKey(row.UserId);
        if (row.IsFrozen === true) frozen.add(id);
        else if (row.IsFrozen === false) unfrozen.add(id);
      }
    }
    // Missing/contradictory UserLogin records never imply an unfrozen user.
    const eligible = match.users.filter(id => unfrozen.has(idKey(id)) && !frozen.has(idKey(id)));
    if (!eligible.length) throw new NoUnfrozenOrgUsersError(
      "Matching active Salesforce users exist, but none has a confirmed unfrozen UserLogin record.");

    // Existing preference: most recently logged-in eligible user. New
    // fallback: first least-extra-grant eligible user, stable by Salesforce ID.
    const recent = selectMostRecentlyLoggedInMatchedUser(eligible, inventory.users);
    const selected = recent ?? eligible[0];
    const checkedUserDetails = [inventory.userDetails.get(idKey(selected)) ?? {
      id: idKey(selected), name: "Name unavailable", username: "Username unavailable"
    }];
    return {
      users: [selected], checkedUserDetails, matchedUsers: 1,
      eligibleUsers: match.eligibleCount, sampled: false,
      selectionMethod: recent ? "RECENT_LOGIN" : "ACTIVE_UNFROZEN_FALLBACK",
    };
  }

  /**
   * Full-consensus access checks use every matching ACTIVE user, not the
   * representative last-login user used by legacy stack/Read analysis.
   * An excessive match count is REVIEW, never silently sampled as Yes.
   */
  async matchingActiveUsersForConsensus(persona: Persona, limit = 50): Promise<{
    users: Array<{ id: string; profileId: string; detail: OrgCheckedUser }>;
    eligibleUsers: number;
  }> {
    const inventory = await this.inventory();
    if (!persona.profile?.trim()) throw new Error("Persona has no configured Profile; org verification needs review.");
    const missingSets = (persona.permissionSets ?? []).filter(
      (name) => !inventory.knownPermissionSetNames.has(normalized(name)));
    const missingGroups = (persona.permissionSetGroups ?? []).filter(
      (name) => !inventory.knownGroupNames.has(normalized(name)));
    if (missingSets.length || missingGroups.length) throw new Error(
      `Configured Salesforce assignments not found: ${[...missingSets, ...missingGroups].join(", ")}.`);
    const matched = matchPersonaUsers(persona, inventory.profiles, inventory.users, inventory.assignments);
    if (matched.eligibleCount === 0) throw new Error(matched.reason ?? "No active Salesforce users match this persona.");
    if (matched.eligibleCount > limit) throw new Error(
      `Found ${matched.eligibleCount} matching active users; limit is ${limit}. Org verification requires review, not sampling.`);
    const byId = new Map(inventory.users.map((user) => [idKey(user.id), user]));
    return {
      eligibleUsers: matched.eligibleCount,
      users: matched.users.map((id) => ({
        id,
        profileId: byId.get(idKey(id))!.profileId,
        detail: inventory.userDetails.get(idKey(id)) ?? {
          id, name: "Name unavailable", username: "Username unavailable",
        }
      })),
    };
  }

  /**
   * Results describe ONE active, confirmed-unfrozen persona-matched user.
   * Latest successful login is preferred, but never required; this does not establish
   * permission parity for all users assigned to a persona.
   * Missing rows or API failures remain inconclusive, never DENIED.
   */
  private decide(
    object: string, field: string | undefined,
    matchedUsers: number, checkedUsers: number, sampled: boolean,
    checkedUserDetails: OrgCheckedUser[], results: Array<boolean | null>, errorLabel: string,
    eligibleUsers?: number,
    selectionMethod?: MatchedUsers["selectionMethod"],
  ): OrgObjectAccessEvidence {
    const common = {
      object, ...(field ? { field } : {}), matchedUsers, checkedUsers, sampled,
      checkedUserDetails, verifiedAt: new Date().toISOString(),
      ...(eligibleUsers !== undefined ? { eligibleUsers } : {}),
      ...(selectionMethod ? { selectionMethod } : {}),
    };
    const denied = results.filter((value) => value === false).length;
    const unknown = results.filter((value) => value === null).length;
    if (denied > 0) return { ...common, outcome: "DENIED",
      message: `Salesforce denied ${errorLabel}.` };
    if (unknown > 0 || sampled || checkedUsers !== matchedUsers) return {
      ...common, outcome: "UNVERIFIED",
      message: `Salesforce could not conclusively verify ${errorLabel}.`
    };
    if (checkedUsers === 0) return { ...common, outcome: "UNVERIFIED",
      message: `No matching users could be checked for ${errorLabel}.` };
    return { ...common, outcome: "VERIFIED",
      message: selectionMethod === "ACTIVE_UNFROZEN_FALLBACK"
        ? "Access verified from Salesforce using an active, unfrozen persona-matched user without recorded login history."
        : "Access verified from Salesforce." };
  }

  async verifyObjectRead(persona: Persona, object: string): Promise<OrgObjectAccessEvidence> {
    const uncertain = (message: string): OrgObjectAccessEvidence => ({
      object, outcome: "UNVERIFIED", matchedUsers: 0, checkedUsers: 0, sampled: false, message
    });
    if (!objectNamePattern.test(object)) return uncertain("Invalid Salesforce object API name.");
    try {
      const { users, checkedUserDetails, matchedUsers, eligibleUsers, sampled, selectionMethod } = await this.matchingUsers(persona);
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
      return this.decide(object, undefined, matchedUsers, readable.length, sampled, checkedUserDetails, readable, `${object} object Read`, eligibleUsers, selectionMethod);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salesforce verification failed.";
      return { ...uncertain(`Unable to verify object Read from Salesforce: ${message}`),
        ...(error instanceof NoMatchingOrgUsersError ? { unverifiedReason: "NO_MATCHING_USERS" as const } : {}),
        ...(error instanceof NoUnfrozenOrgUsersError ? { unverifiedReason: "NO_UNFROZEN_USERS" as const } : {}) };
    }
  }

  async verifyFieldRead(persona: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence> {
    const uncertain = (message: string): OrgObjectAccessEvidence => ({
      object, field, outcome: "UNVERIFIED", matchedUsers: 0, checkedUsers: 0, sampled: false, message
    });
    if (!objectNamePattern.test(object) || !objectNamePattern.test(field)) {
      return uncertain("Invalid Salesforce field API name.");
    }
    try {
      const { users, checkedUserDetails, matchedUsers, eligibleUsers, sampled, selectionMethod } = await this.matchingUsers(persona);
      const readable: Array<boolean | null> = [];
      const compoundParents: string[] = [];
      let nonPermissionable = false;
      for (let i = 0; i < users.length; i += VERIFY_CONCURRENCY) {
        const batch = users.slice(i, i + VERIFY_CONCURRENCY);
        const results = await Promise.all(batch.map(async (userId) => {
          try {
            return await this.userFieldAccess.verifyUserField(userId, object, field);
          } catch { return { read: null, edit: null }; }
        }));
        readable.push(...results.map((item) => item.read));
        nonPermissionable ||= results.some((item) => Boolean(item.nonPermissionableSource));
        compoundParents.push(...results.map((item) => item.readFromCompoundParent).filter(
          (item): item is string => typeof item === "string"
        ));
      }
      const decision = this.decide(object, field, matchedUsers, readable.length, sampled, checkedUserDetails,
        readable, `${object}.${field} field Read`, eligibleUsers, selectionMethod);
      if (decision.outcome === "VERIFIED" && nonPermissionable) {
        return {
          ...decision,
          message: `Salesforce field metadata identifies ${object}.${field} as non-permissionable; no individual Read FLS grant is required. Object Read is evaluated separately.`,
        };
      }
      if (decision.outcome === "VERIFIED" && compoundParents.length > 0) {
        const unique = [...new Set(compoundParents.map((item) => item.toLowerCase()))];
        if (unique.length === 1) {
          const parent = compoundParents[0];
          return {
            ...decision,
            compoundParent: parent,
            message: `Read verified via compound parent ${object}.${parent} for ${object}.${field}; direct component row was absent.`,
          };
        }
      }
      return decision;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salesforce verification failed.";
      return { ...uncertain(`Unable to verify field Read from Salesforce: ${message}`),
        ...(error instanceof NoMatchingOrgUsersError ? { unverifiedReason: "NO_MATCHING_USERS" as const } : {}),
        ...(error instanceof NoUnfrozenOrgUsersError ? { unverifiedReason: "NO_UNFROZEN_USERS" as const } : {}) };
    }
  }
}
