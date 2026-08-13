import { Persona } from "../models/Persona.js";
import { AccessCheckResult } from "../models/AccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { buildEffectiveAccess } from "../analyzer/effectiveAccessAnalyzer.js";

export class PersonaAccessService {
  constructor(
    private readonly personaPermissionResolver: PersonaPermissionResolver
  ) {}

  async getObjectAccess(
    persona: Persona,
    objectName: string
  ): Promise<AccessCheckResult | null> {
    const resolved =
      await this.personaPermissionResolver.resolve(persona);

    const effectiveAccess = buildEffectiveAccess({
      permissionSetGrants:
        resolved.permissionSetGrants,
      mutingPermissionSets:
        resolved.mutingPermissionSets,
    });

    const access = effectiveAccess.find(
      (item) =>
        item.object.toLowerCase() ===
        objectName.toLowerCase()
    );

    if (!access) {
      return null;
    }

    return {
      object: access.object,

      read: access.read,
      create: access.create,
      edit: access.edit,
      delete: access.delete,

      viewAllRecords: access.viewAllRecords,
      modifyAllRecords: access.modifyAllRecords,
      viewAllFields: access.viewAllFields,

      readGrantedBy: access.readGrantedBy,
      createGrantedBy: access.createGrantedBy,
      editGrantedBy: access.editGrantedBy,
      deleteGrantedBy: access.deleteGrantedBy,

      readMutedBy: access.readMutedBy,
      createMutedBy: access.createMutedBy,
      editMutedBy: access.editMutedBy,
      deleteMutedBy: access.deleteMutedBy,
    };
  }
}