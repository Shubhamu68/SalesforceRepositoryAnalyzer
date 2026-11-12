import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
    private readonly envFilePath = path.resolve(process.cwd(), ".env"),
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
    let previous = "";
    let fileMode = 0o600;
    try {
      previous = await readFile(this.envFilePath, "utf8");
      fileMode = (await stat(this.envFilePath)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ReportOutputConfigurationError("Unable to read the project's .env file.");
      }
    }
    const newline = previous.includes("\r\n") ? "\r\n" : "\n";
    // Forward slashes avoid Windows .env double-quote/backslash escaping ambiguity.
    // Quoting preserves spaces, #, and other valid Windows folder name characters.
    const entry = REPORT_OUTPUT_ENV_KEY + "=" + JSON.stringify(directory.replaceAll("\\", "/"));
    const matchingLine = /^\s*(?:export\s+)?SALESFORCE_ANALYZER_OUTPUT_DIRECTORY\s*=/;
    const originalLines = previous ? previous.split(/\r?\n/) : [];
    const replacement: string[] = [];
    let replaced = false;
    for (const line of originalLines) {
      if (matchingLine.test(line)) {
        if (!replaced) replacement.push(entry);
        replaced = true; // Deduplicate active entries, leave commented lines alone.
      } else {
        replacement.push(line);
      }
    }
    if (!replaced) {
      // Preserve all existing lines, including trailing newlines/comments.
      if (replacement.length && replacement[replacement.length - 1] !== "") replacement.push("");
      replacement.push(entry);
    }
    const content = replacement.join(newline).replace(new RegExp(newline === "\r\n" ? "(?:\\r\\n)*$" : "\\n*$"), "") + newline;
    const tempFile = this.envFilePath + ".tmp-" + randomUUID();
    try {
      await writeFile(tempFile, content, { flag: "wx", mode: fileMode });
      await rename(tempFile, this.envFilePath);
    } catch {
      throw new ReportOutputConfigurationError(
        "Unable to save the report directory in the project .env file. Check folder permissions.",
      );
    } finally {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
  }
}

/** CLI scripts have no folder picker; retain a portable default. */
export function cliReportOutputDirectory(): string {
  return path.resolve(process.env[REPORT_OUTPUT_ENV_KEY]?.trim() || "reports");
}
