/** Shared, testable UI policy for Salesforce CLI login and workspace entry. */
export type OrgChooserMode = "startup" | "manual";

export type CliLoginAvailability = {
  checking: boolean;
  busy: boolean;
  hasError: boolean;
  connected: boolean;
  hasActiveCliOrgs: boolean;
};

/** Automatic entry applies only on app startup, never after explicitly choosing Change org. */
export function shouldShowOrgChooser(
  dismissed: boolean,
  mode: OrgChooserMode,
  connected: boolean,
): boolean {
  return !dismissed && (mode === "manual" || !connected);
}

/**
 * Browser login is a fallback when no working CLI authorization is available.
 * Unknown status (checking/error), an ongoing action, and active sessions all
 * keep the buttons disabled. The UI explains why; no silent disabled controls.
 */
export function canStartBrowserLogin(state: CliLoginAvailability): boolean {
  return !state.checking && !state.busy && !state.hasError &&
    !state.connected && !state.hasActiveCliOrgs;
}
