import { Persona } from "../models/Persona.js";
import { PermissionSet } from "../models/PermissionSet.js";
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
  ): Promise<FieldAccessCheckResult | null> {
    const resolved =
      await this.personaPermissionResolver.resolve(persona);

    const groupPermissionSets =
      resolved.permissionSetGroups.flatMap(
        (group) => group.permissionSets
      );

    const allPermissionSets: PermissionSet[] = [
      ...groupPermissionSets,
      ...resolved.directPermissionSets,
    ];

    const effectiveAccess = buildEffectiveAccess({
  permissionSetGrants:
    resolved.permissionSetGrants,
  mutingPermissionSets:
    resolved.mutingPermissionSets,
});

    const objectAccess = effectiveAccess.find(
      (access) =>
        access.object.toLowerCase() ===
        objectName.toLowerCase()
    );

    if (!objectAccess) {
      return null;
    }

    const fullFieldName = `${objectAccess.object}.${fieldName}`;

    const fieldAccess = objectAccess.fields.find(
      (field) =>
        field.field.toLowerCase() ===
        fullFieldName.toLowerCase()
    );

    if (!fieldAccess) {
      return null;
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