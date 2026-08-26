import { Persona } from "../models/Persona.js";
import { FieldAccessCheckResult } from "../models/FieldAccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { buildEffectiveAccess } from "../analyzer/effectiveAccessAnalyzer.js";

export class PersonaFieldAccessService {
  constructor(
    private readonly personaPermissionResolver: PersonaPermissionResolver
  ) {}

  async getFieldAccess(
    persona: Persona,
    objectName: string,
    fieldName: string
  ): Promise<FieldAccessCheckResult> {
    const resolved =
      await this.personaPermissionResolver.resolve(persona);

    const effectiveAccess = buildEffectiveAccess({
      permissionSetGrants: resolved.permissionSetGrants,
      mutingPermissionSets: resolved.mutingPermissionSets,
    });

    const objectAccess = effectiveAccess.find(
      (access) =>
        access.object.toLowerCase() === objectName.toLowerCase()
    );

    const fullFieldName = `${
      objectAccess?.object ?? objectName
    }.${fieldName}`;

    const fieldAccess = objectAccess?.fields.find(
      (field) =>
        field.field.toLowerCase() === fullFieldName.toLowerCase()
    );

    if (!fieldAccess) {
      return {
        field: fullFieldName,
        read: false,
        edit: false,
        readGrantedBy: [],
        editGrantedBy: [],
        mutedBy: [],
      };
    }

    return {
      field: fieldAccess.field,
      read: fieldAccess.readable,
      edit: fieldAccess.editable,
      readGrantedBy: fieldAccess.readGrantedBy,
      editGrantedBy: fieldAccess.editGrantedBy,
      mutedBy: fieldAccess.mutedBy,
    };
  }
}