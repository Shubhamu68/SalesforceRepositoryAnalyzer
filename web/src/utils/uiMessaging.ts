/**
 * Concise, state-aware UI copy. Salesforce connectivity describes whether org
 * verification is available; it does not imply that any individual grant passed.
 */
export type SalesforceConnectionState = "connected" | "connecting" | "unavailable" | "not-configured";

export const WORKFLOW_COPY = {
  access: {
    heading: "Check object or field access",
    description: "Review effective permissions for a persona.",
  },
  soql: {
    heading: "Run SOQL security analysis",
    description: "Scan Apex queries and save one Excel workbook.",
  },
  matrix: {
    heading: "Compare object access",
    description: "Check one object across all personas.",
  },
  stack: {
    heading: "Trace Apex SOQL impact",
    description: "Follow Apex methods and check reachable SOQL queries.",
  },
} as const;

export function salesforceConnectionLabel(state: SalesforceConnectionState): string {
  switch (state) {
    case "connected": return "Salesforce connected";
    case "connecting": return "Salesforce connecting…";
    case "not-configured": return "Salesforce not configured";
    case "unavailable": return "Salesforce unavailable";
  }
}

/** Availability, never a blanket claim that every permission was verified. */
export function analysisModeHint(
  kind: "access" | "soql" | "matrix" | "stack",
  connection: SalesforceConnectionState,
): string {
  const prefix = "Repository first";
  if (connection === "connected") return prefix + " · Salesforce verification available";
  if (connection === "connecting") return prefix + " · Salesforce connecting";
  if (connection === "unavailable") {
    return kind === "soql" || kind === "stack"
      ? prefix + " · Salesforce connection required"
      : prefix + " · Salesforce verification unavailable";
  }
  return prefix + " · Salesforce not configured";
}

/** Avoid repeating the generic folder prompt inside the setup modal. */
export function reportOutputHint(reason: string | undefined, message: string): string {
  return reason === "MISSING" || message === "Choose a folder to save the Excel report."
    ? "" : message;
}

/** A missing repository path is already explained by the setup dialog. */
export function repositorySetupMessage(reason: string | undefined, message: string): string {
  return reason === "MISSING" ? "" : message;
}

/** Acknowledge repository-only mode without repeating backend technical guidance. */
export function orgPreflightMessage(missing: readonly string[] | undefined): string {
  return missing?.length
    ? "No Salesforce org is selected. Run repository-only analysis?"
    : "Salesforce org verification is not connected. Run repository-only analysis?";
}
