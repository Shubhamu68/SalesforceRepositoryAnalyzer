/** Repository-external Salesforce-owned Permission Sets (known exceptions only).
 * This is NOT a substitute for their effective permissions in the org.
 */
const KNOWN_SALESFORCE_PERMISSION_SETS = new Set([
  "force_lightningordermanagementoperationsmanager",
]);

export function isKnownSalesforcePermissionSet(name: string): boolean {
  return KNOWN_SALESFORCE_PERMISSION_SETS.has(name.trim().toLowerCase());
}
