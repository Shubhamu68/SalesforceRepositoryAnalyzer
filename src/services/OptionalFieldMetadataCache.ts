import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Optional, explicitly selected offline metadata. There is deliberately NO
 * repository-bundled fallback: field metadata from one Salesforce org must not
 * automatically become a fact about another project or org.
 *
 * The cache is useful only when its source org matches the active Salesforce
 * org, or an explicitly selected offline target org. Consumers treat an
 * unavailable, stale or invalid cache as UNKNOWN (never as permission granted).
 */
export type FieldPermissionability = boolean | undefined;
export const FIELD_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface OfflineFieldCacheFile {
  version: 2;
  organizationId: string;
  capturedAt: string;
  objects: Record<string, Record<string, boolean>>;
}

type Loaded = {
  organizationId: string;
  capturedAtMs: number;
  fields: ReadonlyMap<string, boolean>;
};

/** Opt-in cache selector; path and offline org ID are local-only settings. */
export class OptionalFieldMetadataCache {
  private loaded: Loaded | null | undefined;
  private warningEmitted = false;

  constructor(
    private readonly filePath?: string,
    private readonly offlineOrgId?: string,
    private readonly now: () => number = Date.now,
  ) {}

  getField(objectName: string, fieldName: string, connectedOrgId?: string): FieldPermissionability {
    if (!this.filePath || !FIELD_NAME.test(objectName) || !FIELD_NAME.test(fieldName)) return undefined;
    // An org-connected request MUST NOT fall back to an unrelated offline
    // selection. Callers pass the connected org ID explicitly.
    const expectedOrgId = connectedOrgId || this.offlineOrgId;
    if (!expectedOrgId || !ORG_ID.test(expectedOrgId)) return undefined;
    const cache = this.load();
    if (!cache || cache.organizationId.slice(0, 15).toLowerCase() !== expectedOrgId.slice(0, 15).toLowerCase()) {
      return undefined;
    }
    const age = this.now() - cache.capturedAtMs;
    if (age < -5 * 60_000 || age > FIELD_CACHE_MAX_AGE_MS) return undefined;
    return cache.fields.get(`${objectName}.${fieldName}`.toLowerCase());
  }

  private load(): Loaded | null {
    if (this.loaded !== undefined) return this.loaded;
    try {
      const source = JSON.parse(readFileSync(path.resolve(this.filePath!), "utf8")) as Partial<OfflineFieldCacheFile>;
      if (source.version !== 2 || typeof source.organizationId !== "string" ||
        !ORG_ID.test(source.organizationId) || typeof source.capturedAt !== "string" ||
        !source.objects || typeof source.objects !== "object" || Array.isArray(source.objects)) {
        throw new Error("Invalid metadata cache schema (expected version 2 and source org details).");
      }
      const capturedAtMs = Date.parse(source.capturedAt);
      if (!Number.isFinite(capturedAtMs) || !/^\d{4}-\d{2}-\d{2}T/.test(source.capturedAt)) {
        throw new Error("Metadata cache has an invalid capturedAt timestamp.");
      }
      const fields = new Map<string, boolean>();
      for (const [objectName, objectFields] of Object.entries(source.objects)) {
        if (!FIELD_NAME.test(objectName) || !objectFields ||
          typeof objectFields !== "object" || Array.isArray(objectFields)) {
          throw new Error("Metadata cache contains an invalid object.");
        }
        for (const [fieldName, value] of Object.entries(objectFields)) {
          const key = `${objectName}.${fieldName}`.toLowerCase();
          if (!FIELD_NAME.test(fieldName) || typeof value !== "boolean" || fields.has(key)) {
            throw new Error("Metadata cache contains a duplicate/invalid field.");
          }
          fields.set(key, value);
        }
      }
      this.loaded = { organizationId: source.organizationId, capturedAtMs, fields };
    } catch {
      this.loaded = null;
      if (!this.warningEmitted) {
        this.warningEmitted = true;
        console.warn("Optional field metadata cache unavailable or invalid; unresolved field permissionability will remain unknown.");
      }
    }
    return this.loaded ?? null;
  }
}
