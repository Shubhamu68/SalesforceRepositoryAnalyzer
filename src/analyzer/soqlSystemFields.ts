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
  // Id is intrinsic to every SObject and does not require an independent
  // FLS grant. Other fields, including compound components and standard
  // fields, need actual Salesforce/declared repository evidence.
  void objectName;
  return fieldName.trim().toLowerCase() === "id";
}
