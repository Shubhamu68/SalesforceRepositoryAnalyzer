import type { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";

export class OrgAnalysisGuardError extends Error {
  constructor(message: string, public readonly code = "SALESFORCE_SESSION_INVALID") {
    super(message);
  }
}

export type OrgAnalysisPreflightResult = {
  mode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY";
  missing: string[];
  warning?: string;
};

export class OrgAnalysisPreflightService {
  constructor(private readonly connection: Pick<SalesforceOrgConnection, "connect" | "status">) {}

  async check(): Promise<OrgAnalysisPreflightResult> {
    if (!this.connection.status.configured) {
      return {
        mode: "REPOSITORY_ONLY",
        missing: [],
        warning: "No Salesforce org selected. Connect through Salesforce CLI for live verification, or explicitly continue with repository-only analysis.",
      };
    }
    try {
      await this.connection.connect();
    } catch {
      // No token, CLI error detail or confidential org data is exposed.
      throw new OrgAnalysisGuardError(
        "The selected Salesforce CLI session is unavailable or expired. Reauthenticate in your browser, choose a different org, or disconnect to use repository-only mode.",
      );
    }
    return { mode: "ORG_AND_REPOSITORY", missing: [] };
  }

  async authorize(acknowledgedRepositoryOnly: boolean): Promise<OrgAnalysisPreflightResult> {
    const status = await this.check();
    if (status.mode === "REPOSITORY_ONLY" && !acknowledgedRepositoryOnly) {
      throw new OrgAnalysisGuardError(
        status.warning ?? "Confirm repository-only analysis before proceeding.",
        "ORG_REPOSITORY_ONLY_CONFIRMATION_REQUIRED",
      );
    }
    return status;
  }
}
