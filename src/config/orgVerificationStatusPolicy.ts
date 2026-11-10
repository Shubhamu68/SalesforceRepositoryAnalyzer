import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Central exception policy for Salesforce-managed object Read permissions.
 * A listed object whose Read grant is missing in repository XML must be
 * verified from the org instead of being assumed inaccessible. Confirmed org
 * Read remains visible as evidence, but is neutral for the green/orange
 * overall status in Stack Trace. DENIED and UNVERIFIED are never bypassed.
 * This does not grant Read and never exempts field-level security.
 */
export interface OrgVerificationStatusPolicy {
  readonly statusNeutralObjectRead: ReadonlySet<string>;
}

const objectApiName = /^[A-Za-z][A-Za-z0-9_]*$/;

export async function loadOrgVerificationStatusPolicy(
  filePath: string,
): Promise<OrgVerificationStatusPolicy> {
  const absolutePath = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to load org verification status policy at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Org verification status policy must be a JSON object.");
  }
  const entries = (parsed as Record<string, unknown>).statusNeutralObjectRead;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !objectApiName.test(entry))) {
    throw new Error("org-verification-status-policy.json: 'statusNeutralObjectRead' must be an array of Salesforce object API names.");
  }
  return {
    statusNeutralObjectRead: new Set<string>(entries.map((name: string) => name.toLowerCase())),
  };
}

export function isStatusNeutralOrgObjectRead(
  policy: OrgVerificationStatusPolicy,
  object: string,
  field?: string,
): boolean {
  // Do not exempt field-level access, even on an exempted object.
  return field === undefined && policy.statusNeutralObjectRead.has(object.toLowerCase());
}
