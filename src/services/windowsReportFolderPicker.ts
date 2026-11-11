import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReportOutputConfigurationError } from "./ReportOutputConfigurationService.js";

const execFileAsync = promisify(execFile);

/**
 * On localhost the browser cannot supply an unrestricted Windows file path.
 * Use a real, server-side Windows Forms folder chooser instead; do not accept
 * user-supplied paths over HTTP. This intentionally requires a local Windows
 * desktop session, and is not intended for remotely hosted servers.
 */
export async function chooseWindowsReportFolder(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new ReportOutputConfigurationError(
      "Native folder selection is currently available only when the Analyzer API runs on a Windows desktop.",
      501,
    );
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a folder for Salesforce Analyzer Excel and TXT reports'",
    "$dialog.ShowNewFolderButton = $true",
    "try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } } finally { $dialog.Dispose() }",
  ].join("; ");
  try {
    // execFile does NOT use a command shell; the script contains no user input.
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 });
    const directory = stdout.trim();
    return directory || null;
  } catch {
    throw new ReportOutputConfigurationError(
      "Unable to open the Windows folder picker. Check that Windows PowerShell and an interactive desktop session are available.",
      503,
    );
  }
}
