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

export function isAggregateExpression(
  field: string
): boolean {
  return /^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(
    field.trim()
  );
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
