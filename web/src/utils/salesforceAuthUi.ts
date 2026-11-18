/** Shared, testable policy for first-run login and manual org switching. */
export type OrgChooserMode = "startup" | "manual";

export type CliLoginAvailability = {
  busy: boolean;
};

/** First-run auto-entry must not close an explicitly opened Change org screen. */
export function shouldShowOrgChooser(
  dismissed: boolean,
  mode: OrgChooserMode,
  connected: boolean,
): boolean {
  return !dismissed && (mode === "manual" || !connected);
}

/**
 * Existing Salesforce orgs are never a reason to disable another login.
 * Saved-org discovery may take time on Windows and is not an auth gate.
 * Disable new browser login only while a conflicting action is in flight.
 * The backend independently validates CLI version and authentication.
 */
export function canStartBrowserLogin(state: CliLoginAvailability): boolean {
  return !state.busy;
}
