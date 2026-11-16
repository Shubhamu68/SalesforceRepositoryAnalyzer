import type { Persona } from "../models/Persona.js";
import { MATRIX_PERMISSION_KEYS, type MatrixAccess, type MatrixPermission } from "../models/ObjectAccessMatrixResult.js";
import type { SalesforceEffectivePermissionVerifier, OrgPermissionEvidence } from "../salesforce/SalesforceEffectivePermissionVerifier.js";
import { isFieldLevelSecurityApplicable } from "../config/fieldSecurityPolicy.js";

export type PermissionEvidence = OrgPermissionEvidence;

/** UI and API use a single interpretation for all seven object privileges. */
export type ObjectPermissionEvidence = Partial<Record<MatrixPermission, PermissionEvidence>>;
export type FieldPermissionEvidence = Partial<Record<"read" | "edit", PermissionEvidence>>;

function unavailable(permission: string): PermissionEvidence {
  return {
    source: "UNVERIFIED", outcome: "UNVERIFIED", matchedUsers: 0, checkedUsers: 0,
    message: `Repository does not establish ${permission}. Salesforce org verification failed or is not configured; needs Review.`,
  };
}

export class OrgPermissionFallbackService {
  constructor(private readonly verifier?: Pick<SalesforceEffectivePermissionVerifier, "verifyObject" | "verifyField">) {}

  async resolveObject(persona: Persona, object: string, repository: MatrixAccess): Promise<{
    access: MatrixAccess;
    evidence: ObjectPermissionEvidence;
  }> {
    const access = { ...repository };
    const evidence: ObjectPermissionEvidence = {};
    const missing = MATRIX_PERMISSION_KEYS.filter((permission) => !repository[permission]);
    if (!missing.length) return { access, evidence };
    let org: Awaited<ReturnType<NonNullable<typeof this.verifier>["verifyObject"]>> | undefined;
    let failure: string | undefined;
    try { org = await this.verifier?.verifyObject(persona, object); }
    catch (error) { failure = error instanceof Error ? error.message : "Unexpected Salesforce verification failure."; }
    for (const permission of missing) {
      evidence[permission] = org?.[permission] ?? {
        ...unavailable(`${object} ${permission}`),
        ...(failure ? { message: `Salesforce org verification failed for ${object} ${permission}; needs Review. ${failure}` } : {}),
      };
      if (evidence[permission]?.source === "ORG_VERIFIED") access[permission] = true;
    }
    return { access, evidence };
  }

  async resolveField(
    persona: Persona, object: string, field: string,
    objectPermissions: { access: MatrixAccess; evidence: ObjectPermissionEvidence },
    repositoryFls: { read: boolean; edit: boolean },
  ): Promise<{ access: { read: boolean; edit: boolean }; evidence: FieldPermissionEvidence }> {
    // Defensively enforce N/A for future callers; no org FLS lookup.
    if (!isFieldLevelSecurityApplicable(object)) {
      return { access: { read: false, edit: false }, evidence: {} };
    }
    const evidence: FieldPermissionEvidence = {};
    const access = { read: false, edit: false };
    let org: Awaited<ReturnType<NonNullable<typeof this.verifier>["verifyField"]>> | undefined;
    let failure: string | undefined;
    if (!repositoryFls.read || !repositoryFls.edit) {
      try { org = await this.verifier?.verifyField(persona, object, field); }
      catch (error) { failure = error instanceof Error ? error.message : "Unexpected Salesforce verification failure."; }
    }
    for (const permission of ["read", "edit"] as const) {
      const objectAllowed = objectPermissions.access[permission];
      const objectEvidence = objectPermissions.evidence[permission];
      const flsEvidence = repositoryFls[permission] ? undefined :
        org?.[permission] ?? {
          ...unavailable(`${object}.${field} field ${permission}`),
          ...(failure ? { message: `Salesforce org field verification failed; needs Review. ${failure}` } : {}),
        };
      const fieldAllowed = repositoryFls[permission] || flsEvidence?.source === "ORG_VERIFIED";
      access[permission] = objectAllowed && fieldAllowed;
      // Each permission requires BOTH object CRUD and field FLS. Denial
      // of either prerequisite is conclusive; missing metadata is not.
      const objectDenied = !objectAllowed && objectEvidence?.source === "ORG_DENIED";
      const fieldDenied = !fieldAllowed && flsEvidence?.source === "ORG_DENIED";
      const objectUnverified = !objectAllowed && objectEvidence?.source !== "ORG_DENIED";
      const fieldUnverified = !fieldAllowed && flsEvidence?.source !== "ORG_DENIED";
      const objectOrgVerified = objectEvidence?.source === "ORG_VERIFIED";
      const fieldOrgVerified = flsEvidence?.source === "ORG_VERIFIED";
      if (objectDenied || fieldDenied) {
        const denied = objectDenied ? objectEvidence! : flsEvidence!;
        const origin = objectDenied ? "object" : "field";
        evidence[permission] = {
          ...denied,
          message: `Effective ${object}.${field} ${permission} denied: Salesforce confirmed missing ${origin} ${permission}. ${denied.message}`,
        };
      } else if (objectUnverified || fieldUnverified) {
        const unresolved = objectUnverified ? objectEvidence : flsEvidence;
        evidence[permission] = {
          ...(unresolved ?? unavailable(`${object}.${field} ${permission}`)),
          source: "UNVERIFIED", outcome: "UNVERIFIED",
          message: `Effective ${object}.${field} ${permission} needs Review. ${objectUnverified
            ? "Object " + permission + " not established: " + (objectEvidence?.message ?? "No repository grant or conclusive Salesforce verification.") + " "
            : ""}${fieldUnverified
            ? "Field " + permission + " not established: " + (flsEvidence?.message ?? "No repository grant or conclusive Salesforce verification.")
            : ""}`.trim(),
        };
      } else if (access[permission] && (objectOrgVerified || fieldOrgVerified)) {
        const verified = objectOrgVerified ? objectEvidence! : flsEvidence!;
        const objectSource = objectOrgVerified ? "Salesforce" : "repository metadata";
        const fieldSource = fieldOrgVerified ? "Salesforce" : "repository metadata";
        evidence[permission] = {
          ...verified,
          message: `Effective ${object}.${field} ${permission} established. Object ${permission}: ${objectSource}. Field ${permission}: ${fieldSource}.`,
        };
      }
    }
    return { access, evidence };
  }
}
