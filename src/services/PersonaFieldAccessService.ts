import type { Persona } from "../models/Persona.js";
import type { FieldAccessCheckResult } from "../models/FieldAccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";
import { OrgObjectReadVerificationService } from "./OrgObjectReadVerificationService.js";
import { OrgPermissionFallbackService } from "./OrgPermissionFallbackService.js";

export class PersonaFieldAccessService {
  constructor(
    private readonly resolver: PersonaPermissionResolver,
    private readonly orgReadVerification?: OrgObjectReadVerificationService,
    private readonly permissionFallback?: OrgPermissionFallbackService,
  ) {}

  async getFieldAccess(persona: Persona, objectName: string, fieldName: string): Promise<FieldAccessCheckResult> {
    const resolved = await this.resolver.resolve(persona);
    const evaluator = createPersonaAccessEvaluator(resolved);
    const field = evaluator.evaluateField(`${objectName}.${fieldName}`);
    if (this.permissionFallback) {
      const evaluatedObject = evaluator.evaluateObject(objectName);
      const objectAccess = await this.permissionFallback.resolveObject(persona, objectName, evaluatedObject.access);
      const result = await this.permissionFallback.resolveField(persona, objectName, fieldName, objectAccess, {
        read: field.schemaRequired === true || field.permissionable === false || field.readGrantedBy.length > 0,
        edit: field.schemaRequired === true || field.editGrantedBy.length > 0,
      });
      return {
        field: field.field, ...result.access,
        permissionEvidence: result.evidence,
        permissionable: field.permissionable, schemaRequired: field.schemaRequired,
        readGrantedBy: field.readGrantedBy, editGrantedBy: field.editGrantedBy,
        mutedBy: field.mutedBy,
      };
    }
    const objectRead = evaluator.evaluateObject(objectName).access.read;
    const objectReadEvidence = !objectRead && this.orgReadVerification
      ? await this.orgReadVerification.resolve(persona, objectName, false)
      : undefined;
    const effectiveObjectRead = objectRead || objectReadEvidence?.readable === true;
    const independentFls = field.schemaRequired === true || field.permissionable === false ||
      field.readGrantedBy.length > 0;
    let readable = effectiveObjectRead && independentFls;
    let fieldReadEvidence;
    if (effectiveObjectRead && !independentFls) {
      const decision = await this.orgReadVerification?.resolveFieldRead(persona, objectName, fieldName, false);
      readable = decision?.readable === true;
      fieldReadEvidence = decision?.orgEvidence ?? (decision ? {
        object: objectName, field: fieldName, outcome: "UNVERIFIED" as const,
        matchedUsers: 0, checkedUsers: 0, sampled: false, message: decision.message,
      } : undefined);
    }
    return {
      field: field.field,
      read: readable,
      ...(objectReadEvidence ? { objectReadEvidence } : {}),
      ...(fieldReadEvidence ? { fieldReadEvidence } : {}),
      edit: field.editable,
      permissionable: field.permissionable,
      schemaRequired: field.schemaRequired,
      readGrantedBy: field.readGrantedBy,
      editGrantedBy: field.editGrantedBy,
      mutedBy: field.mutedBy,
    };
  }
}
