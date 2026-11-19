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
  // Only universally special identifiers / generated compound components
  // are excluded without org metadata. Other standard fields (including
  // Name, OwnerId, CreatedDate) may have org-specific permissionability and
  // must reach the shared FLS verifier rather than be silently discarded.
  void objectName;
  const normalized = fieldName.trim().toLowerCase();
  return normalized === "id" || normalized.endsWith("__s");
}
