/**
 * Shared field-security policy for Access Checker, SOQL, Stack Trace and
 * future analyzers. Platform Event message fields (__e, namespaced included)
 * have no configurable FLS; object-level access remains separately relevant.
 * Change Data Capture types (*ChangeEvent) are NOT custom Platform Events.
 */
export const PLATFORM_EVENT_FLS_REASON =
  "Field-level security does not apply to Platform Event fields. Check event object permissions separately.";

export const PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON =
  "Platform Event objects are excluded from object/field Access Checker and Matrix analysis; use Salesforce event permissions to evaluate publish/subscribe access.";

export function isPlatformEventObject(objectApiName: string): boolean {
  return objectApiName.trim().toLowerCase().endsWith("__e");
}

/** Shared selection/analysis rule: Platform Events are not data-access objects. */
export function isDataAccessAnalysisObject(objectApiName: string): boolean {
  return !isPlatformEventObject(objectApiName);
}

export function assertDataAccessAnalysisObject(objectApiName: string): void {
  if (!isDataAccessAnalysisObject(objectApiName)) {
    throw new Error(PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON);
  }
}

export function isFieldLevelSecurityApplicable(objectApiName: string): boolean {
  return !isPlatformEventObject(objectApiName);
}
