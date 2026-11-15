/** Repository-external Salesforce-owned Permission Sets (known exceptions only).
 * This is NOT a substitute for their effective permissions in the org.
 */
// Both force__ and force_ variants can appear in managed OM references.
// Missing XML must be silent, without inferring any effective access grant.
const KNOWN_SALESFORCE_PERMISSION_SETS = new Set([
  "forcelightningordermanagementoperationsmanager",
]);
export function isKnownSalesforcePermissionSet(name: string): boolean {
  return KNOWN_SALESFORCE_PERMISSION_SETS.has(name.trim().toLowerCase().replace(/_/g, ""));
}
