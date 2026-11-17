import type { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";

export class OrgAnalysisGuardError extends Error {
  constructor(message: string, public readonly code = "SALESFORCE_CONNECTION_INVALID") {
    super(message);
  }
}

export type OrgAnalysisPreflightResult = {
  mode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY";
  missing: string[];
  warning?: string;
};

/** Central authorization policy shared by SOQL and Stack Trace analysis. */
export class OrgAnalysisPreflightService {
  constructor(private readonly connection: Pick<SalesforceOrgConnection, "connect" | "status">) {}

  async check(): Promise<OrgAnalysisPreflightResult> {
    if (!this.connection.status.configured) {
      return {
        mode: "REPOSITORY_ONLY",
        missing: ["SALESFORCE_ORG_SELECTION"],
        warning: "No Salesforce org selected. This analysis will check repository metadata only. " +
          "Choose an existing CLI authorization or sign in from the Salesforce Org page to enable live verification.",
      };
    }
    try {
      await this.connection.connect();
    } catch {
      // Do not return CLI stdout/stderr or any credential material to clients.
      throw new OrgAnalysisGuardError(
        "The selected Salesforce CLI authorization is unavailable or expired. Reauthorize the org in your browser, then retry.",
      );
    }
    return { mode: "ORG_AND_REPOSITORY", missing: [] };
  }

  async authorize(acknowledgedRepositoryOnly: boolean): Promise<OrgAnalysisPreflightResult> {
    const check = await this.check();
    if (check.mode === "REPOSITORY_ONLY" && !acknowledgedRepositoryOnly) {
      throw new OrgAnalysisGuardError(
        check.warning ?? "Confirm repository-only analysis before proceeding.",
        "ORG_REPOSITORY_ONLY_CONFIRMATION_REQUIRED",
      );
    }
    return check;
  }
}
