import { getFieldPermissionability } from "./fieldPermissionability.js";

export const SOQL_SYSTEM_FIELDS = new Set([
  "id",
  "ownerid",
  "isdeleted",
  "name",
  "recordtypeid",
  "createddate",
  "createdbyid",
  "lastmodifieddate",
  "lastmodifiedbyid",
  "systemmodstamp",
  "lastvieweddate",
  "lastreferenceddate",
]);

export function isSystemField(
  fieldName: string
): boolean {
  return SOQL_SYSTEM_FIELDS.has(
    fieldName.trim().toLowerCase()
  );
}

/** Compatibility classifier for aggregate expressions; do NOT use this to
 * skip fields. The syntax-aware extractor must walk their operands. */
export function isAggregateExpression(value: string): boolean {
  return /^(?:COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(/i.test(value.trim());
}

export function isIgnoredField(
  fieldName: string,
  objectName?: string
): boolean {
  // Snapshot-backed fields are checked centrally by the effective-access
  // evaluator. In particular, do not skip a field marked permissionable=true.
  if (objectName && getFieldPermissionability(objectName, fieldName) !== undefined) {
    return false;
  }

  // Legacy fallback for fields outside the current snapshot.
  const normalized = fieldName.trim().toLowerCase();
  return isSystemField(normalized) || normalized.endsWith("__s");
}
