import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver, type ResolvedPersonaPermissions } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";
import type { PermissionSet } from "../models/PermissionSet.js";
import type { ObjectAccessMatrixPersona, ObjectAccessMatrixResult } from "../models/ObjectAccessMatrixResult.js";

const equal = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Shared with Stack Trace Impact: no separate permission calculation here. */
export function calculateMatrixPersona(
  objectName: string,
  resolved: ResolvedPersonaPermissions,
  mutesByGroup: ReadonlyMap<string, readonly PermissionSet[]> = resolved.mutesByGroup ?? new Map(),
  warnings: string[] = []
): ObjectAccessMatrixPersona {
  const { access, sources } = createPersonaAccessEvaluator(resolved, mutesByGroup).evaluateObject(objectName);
  return { personaName: resolved.persona.name, access, sources, warnings };
}

export class ObjectAccessMatrixService {
  constructor(
    private readonly personaConfigLoader: PersonaConfigLoader,
    private readonly personaPermissionResolver: PersonaPermissionResolver
  ) {}

  async analyze(objectName: string): Promise<ObjectAccessMatrixResult> {
    const object = objectName.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object) || object.length > 255) {
      throw new Error("Invalid object API name. Enter an object API name such as Account or OrderSummary.");
    }
    const personas = await this.personaConfigLoader.getAllPersonas();
    const results: ObjectAccessMatrixPersona[] = [];

    for (let start = 0; start < personas.length; start += 5) {
      const chunk = personas.slice(start, start + 5);
      const chunkResults = await Promise.all(chunk.map(async (persona) => {
        const resolved = await this.personaPermissionResolver.resolve(persona);
        const warnings: string[] = [];
        for (const groupName of persona.permissionSetGroups) {
          if (!resolved.permissionSetGroups.some((group) => equal(group.name, groupName))) {
            warnings.push(`Permission Set Group metadata unavailable: ${groupName}`);
          }
        }
        for (const name of persona.permissionSets) {
          if (!resolved.directPermissionSets.some((ps) => equal(ps.name, name))) {
            warnings.push(`Direct Permission Set metadata unavailable: ${name}`);
          }
        }
        for (const group of resolved.permissionSetGroups) {
          for (const name of group.permissionSetNames) {
            if (!group.permissionSets.some((ps) => equal(ps.name, name))) {
              warnings.push(`Permission Set metadata unavailable: ${name} (PSG: ${group.name})`);
            }
          }
          const muteNames = group.mutingPermissionSetNames.length
            ? group.mutingPermissionSetNames
            : resolved.permissionSetGroups.length === 1 ? persona.mutingPermissionSets : [];
          for (const name of muteNames) {
            if (!(resolved.mutesByGroup.get(group.name) ?? []).some((mute) => equal(mute.name, name))) {
              warnings.push(`Muting Permission Set metadata unavailable: ${name} (PSG: ${group.name})`);
            }
          }
        }
        if (resolved.permissionSetGroups.length > 1) {
          const linked = resolved.permissionSetGroups.flatMap((group) => group.mutingPermissionSetNames);
          for (const name of persona.mutingPermissionSets) {
            if (!linked.some((linkedName) => equal(linkedName, name))) {
              warnings.push(`Cannot associate configured muting set ${name} to a PSG; add it to the correct PSG metadata.`);
            }
          }
        }
        return calculateMatrixPersona(object, resolved, resolved.mutesByGroup, warnings);
      }));
      results.push(...chunkResults);
    }

    return {
      object,
      personas: results,
      totalPersonas: results.length,
      personasWithRead: results.filter((result) => result.access.read).length,
      warnings: [...new Set(results.flatMap((result) => result.warnings))],
    };
  }
}
