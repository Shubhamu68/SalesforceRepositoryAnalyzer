import type { Persona } from "../models/Persona.js";
import type { FieldAccessCheckResult } from "../models/FieldAccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";

export class PersonaFieldAccessService {
  constructor(private readonly resolver: PersonaPermissionResolver) {}

  async getFieldAccess(persona: Persona, objectName: string, fieldName: string): Promise<FieldAccessCheckResult> {
    const resolved = await this.resolver.resolve(persona);
    const field = createPersonaAccessEvaluator(resolved).evaluateField(`${objectName}.${fieldName}`);
    return {
      field: field.field,
      read: field.readable,
      edit: field.editable,
      permissionable: field.permissionable,
      schemaRequired: field.schemaRequired,
      readGrantedBy: field.readGrantedBy,
      editGrantedBy: field.editGrantedBy,
      mutedBy: field.mutedBy,
    };
  }
}
