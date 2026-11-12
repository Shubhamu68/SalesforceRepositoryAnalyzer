import type { Persona } from "../models/Persona.js";
import { MATRIX_PERMISSION_KEYS, type MatrixAccess, type MatrixPermission } from "../models/ObjectAccessMatrixResult.js";
import type { SalesforceEffectivePermissionVerifier, OrgPermissionEvidence } from "../salesforce/SalesforceEffectivePermissionVerifier.js";

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
      // A verified denial of either prerequisite is an effective denial.
      const denied = [objectEvidence, flsEvidence].find((e) => e?.source === "ORG_DENIED");
      const unresolved = [objectEvidence, flsEvidence].find((e) => e?.source === "UNVERIFIED");
      if (denied && !objectAllowed || denied && !fieldAllowed) {
        evidence[permission] = { ...denied, message: `Effective field ${permission} unavailable: ${denied.message}` };
      } else if (unresolved) {
        evidence[permission] = {
          ...unresolved,
          message: `Field ${permission} needs Review. ${objectEvidence?.source === "UNVERIFIED" ? "Object permission: " + objectEvidence.message + " " : ""}${flsEvidence?.source === "UNVERIFIED" ? "Field permission: " + flsEvidence.message : ""}`,
        };
      } else if (access[permission] && (objectEvidence?.source === "ORG_VERIFIED" || flsEvidence?.source === "ORG_VERIFIED")) {
        const verified = objectEvidence?.source === "ORG_VERIFIED" ? objectEvidence : flsEvidence!;
        evidence[permission] = {
          ...verified,
          message: `Grant not established completely in repository metadata. Effective field ${permission} verified in Salesforce org for matching active users. ${objectEvidence?.source === "ORG_VERIFIED" ? "Object grant verified. " : ""}${flsEvidence?.source === "ORG_VERIFIED" ? "Field grant verified." : ""}`,
        };
      }
    }
    return { access, evidence };
  }
}
