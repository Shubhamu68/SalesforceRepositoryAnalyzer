import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rm, stat, writeFile } from "node:fs/promises";
import { saveLocalEnvEntry } from "./LocalEnvFileService.js";
import path from "node:path";
import { chooseWindowsReportFolder } from "./windowsReportFolderPicker.js";

export const REPORT_OUTPUT_ENV_KEY = "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY";

export type ReportOutputStatus = {
  configured: boolean;
  directory: string | null;
  reason: "READY" | "MISSING" | "INVALID_DIRECTORY" | "NOT_WRITABLE";
  message: string;
};

export class ReportOutputConfigurationError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ReportOutputConfigurationError";
  }
}

type DirectoryPicker = () => Promise<string | null>;

/**
 * This manages ONLY the report output path. It never edits Salesforce credentials
 * or exposes arbitrary file-system writes through the HTTP API.
 *
 * The app is currently local-only. An Electron build can later replace the native
 * picker and configuration location without changing the analysis engine.
 */
export class ReportOutputConfigurationService {
  private choiceInProgress = false;

  constructor(
    private readonly envFilePath = path.resolve(process.env.SALESFORCE_ANALYZER_ENV_PATH?.trim() || path.join(process.cwd(), ".env")),
    private readonly picker: DirectoryPicker = chooseWindowsReportFolder,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  configuredDirectory(): string | null {
    const value = this.environment[REPORT_OUTPUT_ENV_KEY]?.trim();
    return value ? path.resolve(value) : null;
  }

  requireConfiguredDirectory(): string {
    const directory = this.configuredDirectory();
    if (!directory) {
      throw new ReportOutputConfigurationError("Choose a report output folder before running SOQL analysis.", 409);
    }
    return directory;
  }

  async getStatus(): Promise<ReportOutputStatus> {
    const directory = this.configuredDirectory();
    if (!directory) return {
      configured: false, directory: null, reason: "MISSING",
      message: "Choose a folder to save the Excel report.",
    };
    try {
      const details = await stat(directory);
      if (!details.isDirectory()) return {
        configured: false, directory, reason: "INVALID_DIRECTORY",
        message: "The configured report output path is not a folder. Choose another folder.",
      };
      await access(directory, constants.W_OK);
      return {
        configured: true, directory, reason: "READY", message: "Report output directory is configured.",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        configured: false, directory,
        reason: code === "ENOENT" || code === "ENOTDIR" ? "INVALID_DIRECTORY" : "NOT_WRITABLE",
        message: code === "ENOENT" || code === "ENOTDIR"
          ? "The previously configured folder no longer exists. Choose a new folder."
          : "The configured folder is not accessible or writable. Choose another folder.",
      };
    }
  }

  /**
   * The path comes exclusively from the server-side native folder dialog.
   * Cancellation never modifies .env or the active configuration.
   */
  async chooseAndSave(): Promise<{ saved: boolean; cancelled: boolean; directory: string | null }> {
    if (this.choiceInProgress) {
      throw new ReportOutputConfigurationError("The folder selection dialog is already open.", 409);
    }
    this.choiceInProgress = true;
    try {
      const selection = await this.picker();
      if (!selection) return { saved: false, cancelled: true, directory: null };
      if (selection.includes("\0") || !path.isAbsolute(selection)) {
        throw new ReportOutputConfigurationError("The selected report folder must be an absolute local path.");
      }
      const directory = path.resolve(selection);
      await this.assertWritableDirectory(directory);
      await this.persistEnvEntry(directory);
      // process.loadEnvFile() does not reload changed values. Apply the choice
      // immediately so the ongoing API process can generate reports without restart.
      this.environment[REPORT_OUTPUT_ENV_KEY] = directory;
      return { saved: true, cancelled: false, directory };
    } finally {
      this.choiceInProgress = false;
    }
  }

  private async assertWritableDirectory(directory: string): Promise<void> {
    try {
      const details = await stat(directory);
      if (!details.isDirectory()) {
        throw new ReportOutputConfigurationError("Select a folder, not an individual file.");
      }
      // A write probe is stronger than checking filesystem permissions alone,
      // especially for Windows ACLs and shared drives.
      const probe = path.join(directory, ".sf-analyzer-write-" + randomUUID());
      try {
        await writeFile(probe, "", { flag: "wx" });
      } finally {
        await rm(probe, { force: true });
      }
    } catch (error) {
      if (error instanceof ReportOutputConfigurationError) throw error;
      throw new ReportOutputConfigurationError(
        "The selected directory is unavailable or not writable. Choose a folder where you have write access.",
      );
    }
  }

  private async persistEnvEntry(directory: string): Promise<void> {
    try {
      await saveLocalEnvEntry(this.envFilePath, REPORT_OUTPUT_ENV_KEY, directory);
    } catch {
      throw new ReportOutputConfigurationError(
        "Unable to save the report directory in the project .env file. Check folder permissions.",
      );
    }
  }
}

/** CLI scripts have no folder picker; retain a portable default. */
export function cliReportOutputDirectory(): string {
  return path.resolve(process.env[REPORT_OUTPUT_ENV_KEY]?.trim() || "reports");
}
