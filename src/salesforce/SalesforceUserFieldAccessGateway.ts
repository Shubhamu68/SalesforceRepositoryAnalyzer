import type { SalesforceOrgConnection, SalesforceSObjectDescribe } from "./SalesforceOrgConnection.js";
import type { SalesforceFieldMetadataService } from "./SalesforceFieldMetadataService.js";
import { recordSoqlCount } from "../services/SoqlPerformanceMetrics.js";

/**
 * Shared, conservative UserFieldAccess gateway for SOQL, Stack Trace,
 * Access Checker, and Access Matrix. A compound parent is only considered
 * when live Describe establishes the relationship; component access always
 * takes precedence over parent evidence.
 *
 * A parent Read=true can verify the component Read when Salesforce omits its
 * UserFieldAccess row. Parent Read=false is deliberately NOT converted to a
 * confirmed component denial. Parent Edit is never inherited: compound
 * address/location parents are read-only.
 */
type Connection = Pick<SalesforceOrgConnection, "status" | "queryAll" | "describeSObject">;
type DescribeField = SalesforceSObjectDescribe["fields"][number];
type UserAccessRow = {
  UserId: string;
  IsAccessible?: boolean | null;
  IsUpdatable?: boolean | null;
  FieldDefinition?: { QualifiedApiName?: string | null } | null;
};
type DirectAccess = {
  state: "PRESENT" | "MISSING" | "INCONCLUSIVE";
  read: boolean | null;
  edit: boolean | null;
};
type CacheEntry<T> = { expires: number; promise: Promise<T> };

export type EffectiveUserFieldAccess = {
  read: boolean | null;
  edit: boolean | null;
  /** Non-empty only when a component's Read was inferred from an explicitly verified parent. */
  readFromCompoundParent?: string;
  /** Evidence came from live/snapshot IsPermissionable=false, not a user grant. */
  nonPermissionableSource?: "LIVE" | "SNAPSHOT";
};

const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 2000;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const standardAddressSuffixes = [
  "GeocodeAccuracy", "PostalCode", "CountryCode", "StateCode",
  "Latitude", "Longitude", "Country", "Street", "State", "City",
];

const norm = (value: string): string => value.trim().toLowerCase();
const userKey = (id: string) => id.slice(0, 15);
const isCompoundType = (type: string | undefined): boolean =>
  ["address", "location", "name"].includes(type?.toLowerCase() ?? "");

/** Only a recognized compound field in Describe may become an FLS parent. */
export function compoundParentFromDescribe(
  describe: Pick<SalesforceSObjectDescribe, "fields">,
  requestedField: string,
): string | null {
  const fields = new Map(describe.fields.filter((item) => typeof item.name === "string").map((item) => [norm(item.name), item]));
  const component = fields.get(norm(requestedField));
  if (!component) return null;
  if (typeof component.compoundFieldName === "string" && component.compoundFieldName.trim()) {
    const parent = fields.get(norm(component.compoundFieldName));
    if (!parent || norm(parent.name) === norm(component.name)) return null;
    // Explicit Salesforce metadata is authoritative even if the parent has no
    // type in a minimal Describe response.
    if (parent.type && !isCompoundType(parent.type)) return null;
    return parent.name;
  }
  // Some REST Describe versions omit compoundFieldName. Recognize standard
  // and custom address/geolocation syntax only when a live Describe field of
  // compound type is present. Never infer from naming alone.
  const name = component.name;
  const custom = /^(.*)__(City|Country|Street|State|PostalCode|CountryCode|StateCode|GeocodeAccuracy|Latitude|Longitude)__s$/i.exec(name);
  if (custom) {
    const parent = fields.get(norm(custom[1] + "__c"));
    return parent && isCompoundType(parent.type) ? parent.name : null;
  }
  for (const suffix of standardAddressSuffixes) {
    if (!name.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    const candidate = name.slice(0, -suffix.length) + "Address";
    const parent = fields.get(norm(candidate));
    if (parent?.type?.toLowerCase() === "address") return parent.name;
  }
  return null;
}

function toAccess(rows: UserAccessRow[], userId: string, field: string): DirectAccess {
  if (rows.length === 0) return { state: "MISSING", read: null, edit: null };
  if (rows.some((row) =>
    userKey(row.UserId ?? "") !== userKey(userId) ||
    norm(row.FieldDefinition?.QualifiedApiName ?? "") !== norm(field))) {
    return { state: "INCONCLUSIVE", read: null, edit: null };
  }
  const values = rows.map((row) => ({
    read: typeof row.IsAccessible === "boolean" ? row.IsAccessible : null,
    edit: typeof row.IsUpdatable === "boolean" ? row.IsUpdatable : null,
  }));
  const first = values[0];
  if (values.some((value) => value.read !== first.read || value.edit !== first.edit)) {
    return { state: "INCONCLUSIVE", read: null, edit: null };
  }
  return { state: "PRESENT", read: first.read, edit: first.edit };
}

export class SalesforceUserFieldAccessGateway {
  private readonly fullCache = new Map<string, CacheEntry<Map<string, DirectAccess>>>();
  private readonly exactCache = new Map<string, CacheEntry<DirectAccess>>();
  private readonly parentCache = new Map<string, CacheEntry<Map<string, string>>>();

  constructor(
    private readonly connection: Connection,
    private readonly metadata?: SalesforceFieldMetadataService,
  ) {}

  private scope(): string {
    const status = this.connection.status;
    return (status?.organizationId ?? "not-connected") + "|" + (status?.instanceUrl ?? "");
  }

  private cached<T>(store: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) { recordSoqlCount("org.user_field_gateway.cache_hits"); return hit.promise; }
    recordSoqlCount("org.user_field_gateway.cache_misses");
    if (store.size > MAX_CACHE_ENTRIES) store.clear();
    const promise = load().catch((error: unknown) => {
      store.delete(key); // Do not persist network/metadata failures.
      throw error;
    });
    store.set(key, { expires: Date.now() + CACHE_MS, promise });
    return promise;
  }

  private async allFields(userId: string, object: string): Promise<Map<string, DirectAccess>> {
    const cacheKey = this.scope() + "|" + userKey(userId) + "|" + norm(object);
    return this.cached(this.fullCache, cacheKey, async () => {
      const soql =
        `SELECT UserId, FieldDefinition.QualifiedApiName, IsAccessible, IsUpdatable FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}'`;
      recordSoqlCount("org.user_field_gateway.object_wide_queries");
      const records = await this.connection.queryAll<UserAccessRow>(soql, "tooling", 20000);
      const byField = new Map<string, UserAccessRow[]>();
      for (const row of records) {
        const name = row.FieldDefinition?.QualifiedApiName;
        if (!name || !FIELD_NAME.test(name)) continue;
        const key = norm(name);
        const previous = byField.get(key) ?? [];
        previous.push(row);
        byField.set(key, previous);
      }
      return new Map([...byField].map(([name, rows]) => [name, toAccess(rows, userId, name)]));
    });
  }

  private async exact(userId: string, object: string, field: string): Promise<DirectAccess> {
    const key = this.scope() + "|" + userKey(userId) + "|" + norm(object) + "|" + norm(field);
    return this.cached(this.exactCache, key, async () => {
      const soql =
        `SELECT UserId, IsAccessible, IsUpdatable, FieldDefinition.QualifiedApiName FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}' AND FieldDefinition.QualifiedApiName = '${field}'`;
      recordSoqlCount("org.user_field_gateway.exact_queries");
      return toAccess(await this.connection.queryAll<UserAccessRow>(soql, "tooling", 5), userId, field);
    });
  }

  private async direct(userId: string, object: string, field: string): Promise<DirectAccess> {
    try {
      const record = (await this.allFields(userId, object)).get(norm(field));
      if (record) return record; // Direct denials and conflicts always win.
      recordSoqlCount("org.user_field_gateway.missing_row_fallbacks");
    } catch {
      recordSoqlCount("org.user_field_gateway.object_wide_failures");
      // Some orgs reject object-wide queries. A field-specific query may work.
    }
    try {
      return await this.exact(userId, object, field);
    } catch {
      return { state: "INCONCLUSIVE", read: null, edit: null };
    }
  }

  private async compoundParents(object: string): Promise<Map<string, string>> {
    const key = this.scope() + "|" + norm(object);
    return this.cached(this.parentCache, key, async () => {
      const describe = await this.connection.describeSObject(object);
      const parents = new Map<string, string>();
      for (const field of describe.fields) {
        const parent = compoundParentFromDescribe(describe, field.name);
        if (parent) parents.set(norm(field.name), parent);
      }
      return parents;
    });
  }

  /** Returns null when Describe is unavailable, ambiguous, or not a compound field. */
  async compoundParent(object: string, field: string): Promise<string | null> {
    if (!FIELD_NAME.test(object) || !FIELD_NAME.test(field)) return null;
    try {
      return (await this.compoundParents(object)).get(norm(field)) ?? null;
    } catch {
      return null;
    }
  }

  async verifyUserField(userId: string, object: string, field: string): Promise<EffectiveUserFieldAccess> {
    const unknown = { read: null, edit: null };
    if (!USER_ID.test(userId) || !FIELD_NAME.test(object) || !FIELD_NAME.test(field)) return unknown;
    // Non-permissionable field components cannot have independent FLS
    // grants. Live EntityParticle wins over any stale offline snapshot.
    const fieldMetadata = await this.metadata?.getField(object, field);
    if (fieldMetadata?.permissionable === false) {
      return {
        read: true, edit: null,
        nonPermissionableSource: fieldMetadata.source === "LIVE" ? "LIVE" : "SNAPSHOT",
      };
    }
    const direct = await this.direct(userId, object, field);
    if (direct.state !== "MISSING") return { read: direct.read, edit: direct.edit };
    const parent = await this.compoundParent(object, field)
      ?? await this.metadata?.getCompoundNameParent(object, field) ?? null;
    if (!parent) return unknown;
    const parentAccess = await this.direct(userId, object, parent);
    if (parentAccess.state === "PRESENT" && parentAccess.read === true) {
      // Only promote positive, metadata-backed parent READ. A parent denial is
      // not enough proof to assert a component denial; parent EDIT is irrelevant.
      return { read: true, edit: null, readFromCompoundParent: parent };
    }
    return unknown;
  }
}
