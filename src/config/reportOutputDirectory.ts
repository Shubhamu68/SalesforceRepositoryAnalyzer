import path from "node:path";

/**
 * All analysis entry points share one report output location.
 * Environment values are read after each entry point loads its optional .env.
 * Relative paths are resolved from the process working directory.
 */
export function resolveReportOutputDirectory(
  configuredPath: string | undefined = process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY,
  workingDirectory: string = process.cwd(),
): string {
  const location = configuredPath?.trim() || "reports";
  if (location.includes("\0")) {
    throw new Error("SALESFORCE_ANALYZER_OUTPUT_DIRECTORY contains an invalid null character.");
  }
  return path.resolve(workingDirectory, location);
}
