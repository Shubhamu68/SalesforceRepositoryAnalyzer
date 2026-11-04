import type { Persona } from "../models/Persona.js";
import type { AccessCheckResult } from "../models/AccessCheckResult.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";

export class PersonaAccessService {
  constructor(private readonly resolver: PersonaPermissionResolver) {}

  async getObjectAccess(persona: Persona, objectName: string): Promise<AccessCheckResult | null> {
    const resolved = await this.resolver.resolve(persona);
    const evaluator = createPersonaAccessEvaluator(resolved);
    const { access, sources } = evaluator.evaluateObject(objectName);
    // Preserve the former 404 for names not represented in metadata, unless
    // a global permission genuinely grants object access without an XML entry.
    if (!evaluator.knownObjects().some((name) => name.toLowerCase() === objectName.toLowerCase()) &&
        !Object.values(access).some(Boolean)) return null;
    return {
      object: objectName, ...access,
      readGrantedBy: sources.read.grantedBy,
      createGrantedBy: sources.create.grantedBy,
      editGrantedBy: sources.edit.grantedBy,
      deleteGrantedBy: sources.delete.grantedBy,
      readMutedBy: sources.read.mutedBy.map((m) => m.mutingPermissionSet),
      createMutedBy: sources.create.mutedBy.map((m) => m.mutingPermissionSet),
      editMutedBy: sources.edit.mutedBy.map((m) => m.mutingPermissionSet),
      deleteMutedBy: sources.delete.mutedBy.map((m) => m.mutingPermissionSet),
    };
  }
}
