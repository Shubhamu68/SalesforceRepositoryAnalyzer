import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Offline Salesforce EntityParticle.IsPermissionable snapshot.
 * false: field has no configurable FLS (its Read access follows object Read).
 * true: normal field Read FLS evaluation is required.
 * undefined: not covered by this org snapshot; keep the existing evaluation.
 */
export type FieldPermissionability = boolean | undefined;

interface Snapshot {
  version: number;
  objects: Record<string, Record<string, boolean>>;
}

let cached: Map<string, boolean> | undefined;
let cachedNamedFields: Map<string, string[]> | undefined;

function snapshotPath(): string {
  const configured = process.env.FIELD_PERMISSIONABILITY_SNAPSHOT_PATH?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(process.cwd(), "config", "field-permissionability.json");
}

function load(): Map<string, boolean> {
  if (cached) return cached;
  const filePath = snapshotPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load Salesforce field permissionability snapshot at ${filePath}: ${String(error)}`);
  }
  if (
    !parsed || typeof parsed !== "object" ||
    (parsed as Partial<Snapshot>).version !== 1 ||
    !(parsed as Partial<Snapshot>).objects ||
    typeof (parsed as Snapshot).objects !== "object"
  ) {
    throw new Error(`Invalid field permissionability snapshot format: ${filePath}`);
  }
  const entries = new Map<string, boolean>();
  const namedFields = new Map<string, string[]>();
  for (const [objectName, fields] of Object.entries((parsed as Snapshot).objects)) {
    if (!objectName || !fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error(`Invalid object metadata in ${filePath}: ${objectName}`);
    }
    for (const [fieldName, permissionable] of Object.entries(fields)) {
      if (!fieldName || typeof permissionable !== "boolean") {
        throw new Error(`Invalid IsPermissionable value in ${filePath}: ${objectName}.${fieldName}`);
      }
      const key = `${objectName}.${fieldName}`.toLowerCase();
      if (entries.has(key)) throw new Error(`Duplicate field in ${filePath}: ${objectName}.${fieldName}`);
      entries.set(key, permissionable);
      const objectFields = namedFields.get(objectName) ?? [];
      objectFields.push(fieldName);
      namedFields.set(objectName, objectFields);
    }
  }
  cachedNamedFields = namedFields;
  cached = entries;
  return entries;
}

export function getFieldPermissionability(objectName: string, fieldName: string): FieldPermissionability {
  if (!objectName.trim() || !fieldName.trim()) return undefined;
  return load().get(`${objectName.trim()}.${fieldName.trim()}`.toLowerCase());
}

/** Field names available in the existing org snapshot, for conservative relationship inference. */
export function listPermissionabilitySnapshotFields(): Map<string, string[]> {
  load();
  return new Map([...cachedNamedFields!].map(([name, fields]) => [name, [...fields]]));
}
