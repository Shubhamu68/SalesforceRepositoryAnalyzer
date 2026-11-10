import type { Persona } from "../models/Persona.js";
import type { FieldAccessCheckResult } from "../models/FieldAccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";
import { OrgObjectReadVerificationService } from "./OrgObjectReadVerificationService.js";

export class PersonaFieldAccessService {
  constructor(
    private readonly resolver: PersonaPermissionResolver,
    private readonly orgReadVerification?: OrgObjectReadVerificationService
  ) {}

  async getFieldAccess(persona: Persona, objectName: string, fieldName: string): Promise<FieldAccessCheckResult> {
    const resolved = await this.resolver.resolve(persona);
    const evaluator = createPersonaAccessEvaluator(resolved);
    const field = evaluator.evaluateField(`${objectName}.${fieldName}`);
    const objectRead = evaluator.evaluateObject(objectName).access.read;
    const special = !objectRead && this.orgReadVerification?.isConfigured(objectName);
    const objectReadEvidence = special
      ? await this.orgReadVerification!.resolve(persona, objectName, false)
      : undefined;
    const independentFls = field.schemaRequired === true || field.permissionable === false || field.readGrantedBy.length > 0;
    let readable = field.readable;
    let fieldReadEvidence;
    if (objectReadEvidence?.readable) {
      readable = independentFls;
      if (!readable) {
        fieldReadEvidence = await this.orgReadVerification!.resolveField(persona, objectName, fieldName);
        readable = fieldReadEvidence?.outcome === "VERIFIED";
      }
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
