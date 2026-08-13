import { access } from "node:fs/promises";
import path from "node:path";

export interface SalesforceMetadataPaths {
  repositoryPath: string;
  defaultPath: string;
  permissionSetsPath: string;
  permissionSetGroupsPath: string;
  mutingPermissionSetsPath: string;
}

export async function scanRepository(
  repositoryPath: string
): Promise<SalesforceMetadataPaths> {
  const defaultPath = path.join(
    repositoryPath,
    "force-app",
    "main",
    "default"
  );

  const permissionSetsPath = path.join(
    defaultPath,
    "permissionsets"
  );

  const permissionSetGroupsPath = path.join(
    defaultPath,
    "permissionsetgroups"
  );

  const mutingPermissionSetsPath = path.join(
    defaultPath,
    "mutingpermissionsets"
  );

  await ensureDirectory(defaultPath);
  await ensureDirectory(permissionSetsPath);
  await ensureDirectory(permissionSetGroupsPath);
  await ensureDirectory(mutingPermissionSetsPath);

  return {
    repositoryPath,
    defaultPath,
    permissionSetsPath,
    permissionSetGroupsPath,
    mutingPermissionSetsPath,
  };
}

async function ensureDirectory(
  directoryPath: string
): Promise<void> {
  try {
    await access(directoryPath);
  } catch {
    throw new Error(
      `Required Salesforce metadata directory not found: ${directoryPath}`
    );
  }
}