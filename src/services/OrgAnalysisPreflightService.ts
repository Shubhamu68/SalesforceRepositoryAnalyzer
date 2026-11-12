import type { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";

export const ORG_CREDENTIAL_KEYS = ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"] as const;

export class OrgAnalysisGuardError extends Error {
  constructor(message: string, public readonly code = "SALESFORCE_CREDENTIALS_INVALID") {
    super(message);
  }
}

export type OrgAnalysisPreflightResult = {
  mode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY";
  missing: string[];
  warning?: string;
};

export class OrgAnalysisPreflightService {
  constructor(
    private readonly connection: Pick<SalesforceOrgConnection, "connect">,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async check(): Promise<OrgAnalysisPreflightResult> {
    const missing = ORG_CREDENTIAL_KEYS.filter(key => !this.environment[key]?.trim());
    if (missing.length) {
      return {
        mode: "REPOSITORY_ONLY",
        missing,
        warning: "Salesforce org verification will not run. Missing " + missing.join(", ") +
          ". This analysis will check repository metadata only. Add the missing Client Credentials to the project's .env file and restart the API to enable org verification.",
      };
    }
    try {
      await this.connection.connect();
    } catch (error) {
      // Do not expose access tokens, client secrets or OAuth responses.
      const reason = error instanceof Error ? error.message : "Salesforce authentication failed.";
      throw new OrgAnalysisGuardError(
        "Invalid Salesforce credentials or unavailable org connection. Verify SALESFORCE_CLIENT_ID, " +
        "SALESFORCE_CLIENT_SECRET, SALESFORCE_LOGIN_URL and network access, then restart or retry the API. " +
        reason.slice(0, 250),
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
