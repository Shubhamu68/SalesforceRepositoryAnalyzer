import type { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";
import { OptionalFieldMetadataCache } from "../services/OptionalFieldMetadataCache.js";
import { recordSoqlCount } from "../services/SoqlPerformanceMetrics.js";

/**
 * One metadata source for every analysis workflow:
 *  1. current-org EntityParticle (authoritative for FLS applicability);
 *  2. an explicitly configured, org-scoped offline cache (never bundled);
 *  3. UNKNOWN, never an inferred permission grant.
 *
 * Org metadata is cached in memory by org ID, instance and API version.
 * A successful live lookup never falls back to offline cache metadata if
 * the field is absent from the queried org's EntityParticle response.
 */
type Connection = Pick<SalesforceOrgConnection, "status" | "queryAll">;
export type FieldMetadataSource = "LIVE" | "OPTIONAL_CACHE" | "UNKNOWN";

export interface SalesforceFieldMetadata {
  permissionable: boolean | undefined;
  isComponent?: boolean;
  isCompound?: boolean;
  dataType?: string;
  source: FieldMetadataSource;
}

export type EntityParticleRow = {
  QualifiedApiName?: string | null;
  IsPermissionable?: boolean | null;
  IsComponent?: boolean | null;
  IsCompound?: boolean | null;
  DataType?: string | null;
};
type CacheEntry = { until: number; value: Promise<Map<string, SalesforceFieldMetadata> | null> };
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TTL_MS = 300_000;
const ERROR_TTL_MS = 20_000;
const MAX_ENTRIES = 250;
const norm = (name: string): string => name.trim().toLowerCase();
const NAME_PARTS = /^(.*?)(Salutation|FirstName|MiddleName|LastName|Suffix)$/i;

export function compoundNameParentFromMetadata(
  fields: ReadonlyMap<string, SalesforceFieldMetadata>,
  fieldName: string,
): string | null {
  const component = fields.get(norm(fieldName));
  if (component?.source !== "LIVE" || component.isComponent !== true) return null;
  const match = NAME_PARTS.exec(fieldName);
  if (!match) return null;
  const candidate = match[1] + "Name";
  const parent = fields.get(norm(candidate));
  return parent?.source === "LIVE" && parent.isCompound === true ? candidate : null;
}

export class SalesforceFieldMetadataService {
  private readonly cachedObjects = new Map<string, CacheEntry>();

  constructor(
    private readonly connection?: Connection,
    private readonly offlineCache = new OptionalFieldMetadataCache(
      process.env.FIELD_PERMISSIONABILITY_SNAPSHOT_PATH?.trim(),
      process.env.FIELD_METADATA_OFFLINE_ORG_ID?.trim(),
    ),
  ) {}

  private cacheKey(object: string): string {
    const state = this.connection?.status;
    return JSON.stringify([
      state?.organizationId ?? "no-org",
      state?.instanceUrl ?? "no-instance",
      process.env.SALESFORCE_API_VERSION?.trim() || "v62.0",
      norm(object),
    ]);
  }

  /** Null means live metadata could not be retrieved, not that fields are absent. */
  async getObjectMetadata(object: string): Promise<Map<string, SalesforceFieldMetadata> | null> {
    if (!VALID_NAME.test(object) || !this.connection) return null;
    const key = this.cacheKey(object);
    const cached = this.cachedObjects.get(key);
    if (cached && cached.until > Date.now()) { recordSoqlCount("org.field_metadata.cache_hits"); return cached.value; }
    recordSoqlCount("org.field_metadata.cache_misses");
    if (this.cachedObjects.size >= MAX_ENTRIES) this.cachedObjects.clear();

    const entry: CacheEntry = { until: Date.now() + TTL_MS, value: Promise.resolve(null) };
    entry.value = (async () => {
      const soql = `SELECT QualifiedApiName, DataType, IsPermissionable, IsComponent, IsCompound FROM EntityParticle WHERE EntityDefinition.QualifiedApiName = '${object}'`;
      try {
        const records = await this.connection!.queryAll<EntityParticleRow>(soql, "tooling", 20000);
        const result = new Map<string, SalesforceFieldMetadata>();
        for (const field of records) {
          if (!field.QualifiedApiName || !VALID_NAME.test(field.QualifiedApiName)) continue;
          // A missing boolean isn't a false FLS permissionability decision.
          result.set(norm(field.QualifiedApiName), {
            permissionable: typeof field.IsPermissionable === "boolean" ? field.IsPermissionable : undefined,
            ...(typeof field.IsComponent === "boolean" ? { isComponent: field.IsComponent } : {}),
            ...(typeof field.IsCompound === "boolean" ? { isCompound: field.IsCompound } : {}),
            ...(typeof field.DataType === "string" ? { dataType: field.DataType } : {}),
            source: "LIVE",
          });
        }
        return result;
      } catch {
        recordSoqlCount("org.field_metadata.query_failures");
        // Tooling EntityParticle can require View Setup and Configuration.
        // Do not persist a failed remote query as an authoritative empty map.
        entry.until = Date.now() + ERROR_TTL_MS;
        return null;
      }
    })();
    this.cachedObjects.set(key, entry);
    return entry.value;
  }

  async getField(object: string, field: string): Promise<SalesforceFieldMetadata> {
    const unknown: SalesforceFieldMetadata = { permissionable: undefined, source: "UNKNOWN" };
    if (!VALID_NAME.test(object) || !VALID_NAME.test(field)) return unknown;
    const live = await this.getObjectMetadata(object);
    if (live !== null) return live.get(norm(field)) ?? unknown;
    // Only opt-in metadata from the SAME org may supplement a failed live
    // request. Repository-only mode requires FIELD_METADATA_OFFLINE_ORG_ID.
    const connectedOrgId = this.connection?.status.organizationId;
    const cached = this.connection && !connectedOrgId ? undefined
      : this.offlineCache.getField(object, field, connectedOrgId);
    return cached === undefined ? unknown : { permissionable: cached, source: "OPTIONAL_CACHE" };
  }

  async getCompoundNameParent(object: string, field: string): Promise<string | null> {
    if (!VALID_NAME.test(object) || !VALID_NAME.test(field)) return null;
    const live = await this.getObjectMetadata(object);
    return live ? compoundNameParentFromMetadata(live, field) : null;
  }
}
