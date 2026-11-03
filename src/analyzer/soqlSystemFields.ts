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
  fieldName: string
): boolean {
  const normalized =
    fieldName.trim().toLowerCase();

  if (isSystemField(normalized)) {
    return true;
  }

  // Salesforce address compound sub-fields
  // represented with the __s suffix.
  if (normalized.endsWith("__s")) {
    return true;
  }

  return false;
}

// Standard Account address fields excluded from SOQL FLS analysis.
const EXCLUDED_OBJECT_FIELDS = new Set([
  "account.billingcity",
  "account.billingcountry",
  "account.billingpostalcode",
  "account.billingstate",
  "account.billingstreet",
]);

export function isExcludedObjectField(
  objectName: string,
  fieldName: string
): boolean {
  return EXCLUDED_OBJECT_FIELDS.has(
    `${objectName.trim()}.${fieldName.trim()}`.toLowerCase()
  );
}