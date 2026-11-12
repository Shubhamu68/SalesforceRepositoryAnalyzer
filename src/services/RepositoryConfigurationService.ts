import path from "node:path";
import { chooseWindowsRepositoryFolder } from "./windowsReportFolderPicker.js";
import { saveLocalEnvEntry } from "./LocalEnvFileService.js";
import { validateSalesforceRepository, RepositorySetupError } from "./SalesforceRepositoryValidator.js";
import type { SalesforceMetadataPaths } from "../scanner/repositoryScanner.js";

export const REPOSITORY_ENV_KEY = "SALESFORCE_REPOSITORY_PATH";

export interface RepositoryStatus {
  configured: boolean;
  directory: string | null;
  repositoryName: string | null;
  reason: "READY" | "MISSING" | "INVALID_REPOSITORY";
  message: string;
}

/** Local-only repository selection, used by UI/API and existing analysis paths. */
export class RepositoryConfigurationService {
  private choosing = false;

  constructor(
    private readonly envFilePath = path.resolve(process.cwd(), ".env"),
    private readonly picker: () => Promise<string | null> = chooseWindowsRepositoryFolder,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async resolvePaths(): Promise<SalesforceMetadataPaths> {
    const value = this.environment[REPOSITORY_ENV_KEY]?.trim();
    if (!value) throw new RepositorySetupError("Salesforce repository is not configured. Choose a Salesforce source repository folder.", 409);
    try {
      return await validateSalesforceRepository(path.resolve(value));
    } catch (error) {
      if (error instanceof RepositorySetupError) {
        throw new RepositorySetupError(error.message, 409);
      }
      throw error;
    }
  }

  async status(): Promise<RepositoryStatus> {
    const configuredValue = this.environment[REPOSITORY_ENV_KEY]?.trim();
    if (!configuredValue) return {
      configured: false, directory: null, repositoryName: null, reason: "MISSING",
      message: "Choose a valid Salesforce source repository root to begin using the Analyzer.",
    };
    try {
      const paths = await this.resolvePaths();
      return { configured: true, directory: paths.repositoryPath,
        repositoryName: path.basename(paths.repositoryPath), reason: "READY",
        message: "Salesforce repository is configured." };
    } catch (error) {
      return { configured: false, directory: path.resolve(configuredValue),
        repositoryName: null, reason: "INVALID_REPOSITORY",
        message: error instanceof Error ? error.message : "Invalid Salesforce repository." };
    }
  }

  async chooseAndSave(): Promise<{ saved: boolean; cancelled: boolean; directory: string | null; repositoryName: string | null }> {
    if (this.choosing) throw new RepositorySetupError("Repository folder picker is already open.", 409);
    this.choosing = true;
    try {
      const selected = await this.picker();
      if (!selected) return { saved: false, cancelled: true, directory: null, repositoryName: null };
      // Validate BEFORE writing .env or process.env. Invalid selections must be rejected.
      const paths = await validateSalesforceRepository(selected);
      try {
        await saveLocalEnvEntry(this.envFilePath, REPOSITORY_ENV_KEY, paths.repositoryPath);
      } catch {
        throw new RepositorySetupError("Unable to save repository path in the project .env file. Check folder permissions.");
      }
      this.environment[REPOSITORY_ENV_KEY] = paths.repositoryPath;
      return { saved: true, cancelled: false, directory: paths.repositoryPath,
        repositoryName: path.basename(paths.repositoryPath) };
    } finally {
      this.choosing = false;
    }
  }
}
