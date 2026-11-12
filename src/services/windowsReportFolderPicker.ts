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
export const WINDOWS_FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Give FolderBrowserDialog a topmost WinForms owner so it cannot be lost behind
 * the browser/VS Code. The owner itself is transparent and removed on completion.
 * Windows may restrict stealing keyboard focus, but the topmost owned dialog
 * remains visible to the user.
 */
export function buildWindowsFolderPickerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Opacity = 0",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a folder for Salesforce Analyzer Excel reports'",
    "$dialog.ShowNewFolderButton = $true",
    "try { $owner.Show(); $owner.Activate(); $owner.BringToFront(); if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } } finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
  ].join("; ");
}

export async function chooseWindowsReportFolder(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new ReportOutputConfigurationError(
      "Native folder selection is currently available only when the Analyzer API runs on a Windows desktop.",
      501,
    );
  }
  try {
    // execFile does NOT use a command shell; the script contains no user input.
    // Hide only PowerShell's console window, not the owned Windows Forms dialog.
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-STA", "-Command", buildWindowsFolderPickerScript()],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024,
        timeout: WINDOWS_FOLDER_PICKER_TIMEOUT_MS,
      });
    const directory = stdout.trim();
    return directory || null;
  } catch (error) {
    if (error instanceof Error && "killed" in error && error.killed === true) {
      throw new ReportOutputConfigurationError(
        "The Windows folder picker timed out. Please select the folder again.",
        504,
      );
    }
    throw new ReportOutputConfigurationError(
      "Unable to open the Windows folder picker. Check that Windows PowerShell and an interactive desktop session are available.",
      503,
    );
  }
}
