/**
 * Shared field-security policy for Access Checker, SOQL, Stack Trace and
 * future analyzers. Platform Event message fields (__e, namespaced included)
 * have no configurable FLS; object-level access remains separately relevant.
 * Change Data Capture types (*ChangeEvent) are NOT custom Platform Events.
 */
export const PLATFORM_EVENT_FLS_REASON =
  "Field-level security does not apply to Platform Event fields. Check event object permissions separately.";

export function isFieldLevelSecurityApplicable(objectApiName: string): boolean {
  return !objectApiName.trim().toLowerCase().endsWith("__e");
}
