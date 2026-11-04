import type { ResolvedPersonaPermissions } from "./PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "./personaAccessEvaluator.js";
import type { EffectiveObjectAccess } from "../models/EffectiveObjectAccess.js";

/** Enumerated effective access; for a queried object absent in XML, evaluate it directly. */
export function buildEffectiveAccess(resolved: ResolvedPersonaPermissions): EffectiveObjectAccess[] {
  const evaluator = createPersonaAccessEvaluator(resolved);
  return evaluator.knownObjects().map((object) => {
    const { access, sources } = evaluator.evaluateObject(object);
    return {
      object,
      ...access,
      readGrantedBy: sources.read.grantedBy,
      createGrantedBy: sources.create.grantedBy,
      editGrantedBy: sources.edit.grantedBy,
      deleteGrantedBy: sources.delete.grantedBy,
      readMutedBy: sources.read.mutedBy.map((m) => m.mutingPermissionSet),
      createMutedBy: sources.create.mutedBy.map((m) => m.mutingPermissionSet),
      editMutedBy: sources.edit.mutedBy.map((m) => m.mutingPermissionSet),
      deleteMutedBy: sources.delete.mutedBy.map((m) => m.mutingPermissionSet),
      fields: [...new Set(resolved.permissionSetGrants.flatMap((g) =>
        g.permissionSet.fieldPermissions.map((f) => f.field)))]
        .filter((name) => name.toLowerCase().startsWith(`${object.toLowerCase()}.`))
        .map(evaluator.evaluateField),
    };
  });
}
