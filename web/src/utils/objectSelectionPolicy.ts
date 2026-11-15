/** Mirror the backend Platform Event selection rule for immediate UI feedback.
 * The API also filters and rejects events, so this is not a security boundary.
 */
export const PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON =
  "Platform Event objects are excluded from object/field Access Checker and Matrix analysis; use Salesforce event permissions to evaluate publish/subscribe access.";

export function isDataAccessAnalysisObject(objectApiName: string): boolean {
  return !objectApiName.trim().toLowerCase().endsWith("__e");
}
