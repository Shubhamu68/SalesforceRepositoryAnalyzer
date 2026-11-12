import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { scanRepository, type SalesforceMetadataPaths } from "../scanner/repositoryScanner.js";

export class RepositorySetupError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "RepositorySetupError";
  }
}

/**
 * Validate a Salesforce DX-style source checkout before configuring it.
 * Flows are optional because not every checkout contains Flow metadata.
 * classes, objects and the access metadata needed by permission analysis
 * are mandatory. Reuse scanRepository for the canonical metadata layout.
 */
export async function validateSalesforceRepository(directory: string): Promise<SalesforceMetadataPaths> {
  if (!directory || directory.includes("\0") || !path.isAbsolute(directory)) {
    throw new RepositorySetupError("Select an absolute Salesforce repository folder.");
  }
  const normalized = path.resolve(directory);
  let real: string;
  try {
    real = await realpath(normalized);
    if (!(await stat(real)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new RepositorySetupError("Selected folder does not exist or cannot be opened.");
  }
  const root = path.join(real, "force-app", "main", "default");
  const required = ["classes", "objects", "permissionsets", "permissionsetgroups", "mutingpermissionsets"];
  const missing: string[] = [];
  for (const part of required) {
    try {
      const dir = await stat(path.join(root, part));
      if (!dir.isDirectory()) missing.push(part);
    } catch { missing.push(part); }
  }
  if (missing.length) {
    throw new RepositorySetupError(
      "Invalid Salesforce repository. Expected force-app/main/default with these folders: " +
      required.join(", ") + ". Missing: " + missing.join(", ") +
      ". Select the repository root rather than force-app or default.",
    );
  }
  // Validate the Apex directory is actually an Apex source directory.
  const classes = await readdir(path.join(root, "classes"));
  if (!classes.some(name => name.toLowerCase().endsWith(".cls"))) {
    throw new RepositorySetupError("The classes folder has no Apex .cls files. Select a Salesforce source repository, not the Analyzer project.");
  }
  return scanRepository(real);
}
