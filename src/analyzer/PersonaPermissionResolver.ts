import path from "node:path";
import { access } from "node:fs/promises";
import { isKnownSalesforcePermissionSet } from "../config/knownSalesforcePermissionSets.js";

import { Persona } from "../models/Persona.js";
import { PermissionSet } from "../models/PermissionSet.js";
import { PermissionSetGroup } from "../models/PermissionSetGroup.js";
import { parseMutingPermissionSet } from "../parser/mutingPermissionSetParser.js";
import { parsePermissionSet } from "../parser/permissionSetParser.js";
import { parsePermissionSetGroup } from "../parser/permissionSetGroupParser.js";
import { PermissionSetGrant } from "../models/PermissionSetGrant.js";

export interface ResolvedPersonaPermissions {
  persona: Persona;

  permissionSetGroups: PermissionSetGroup[];

  directPermissionSets: PermissionSet[];

  mutingPermissionSets: PermissionSet[];

  permissionSetGrants: PermissionSetGrant[];
}

export class PersonaPermissionResolver {
  constructor(
    private readonly permissionSetsDirectory: string,
    private readonly permissionSetGroupsDirectory: string,
    private readonly mutingPermissionSetsDirectory: string
  ) {}

  async resolve(
    persona: Persona
  ): Promise<ResolvedPersonaPermissions> {
    const permissionSetGroups: PermissionSetGroup[] = [];

    // --------------------------------------------------
    // Permission Set Groups
    // --------------------------------------------------

    for (const groupName of persona.permissionSetGroups) {
      const groupFilePath = path.join(
        this.permissionSetGroupsDirectory,
        `${groupName}.permissionsetgroup-meta.xml`
      );

      try {
        const group = await parsePermissionSetGroup(
          groupFilePath,
          this.permissionSetsDirectory
        );

        permissionSetGroups.push(group);
      } catch {
        console.warn(
          `Could not find or parse Permission Set Group: ${groupName}`
        );
      }
    }

    // --------------------------------------------------
    // Direct Permission Sets
    // --------------------------------------------------

    const directPermissionSets =
      await this.parsePermissionSets(
        persona.permissionSets,
        this.permissionSetsDirectory
      );

    // --------------------------------------------------
    // Muting Permission Sets
    // --------------------------------------------------

    const mutingPermissionSets =
    await this.parseMutingPermissionSets(
    persona.mutingPermissionSets
  );
  const permissionSetGrants: PermissionSetGrant[] = [];

  for (const group of permissionSetGroups) {
    for (const permissionSet of group.permissionSets) {
      permissionSetGrants.push({
        permissionSet,
        type: "permissionSetGroup",
        permissionSetGroup: group.name,
      });
    }
  }

  for (const permissionSet of directPermissionSets) {
    permissionSetGrants.push({
      permissionSet,
      type: "directPermissionSet",
    });
  }
    return {
  persona,
  permissionSetGroups,
  directPermissionSets,
  mutingPermissionSets,
  permissionSetGrants,
};
  }

  private async parsePermissionSets(
    permissionSetNames: string[],
    directory: string
  ): Promise<PermissionSet[]> {
    const permissionSets: PermissionSet[] = [];

    for (const permissionSetName of permissionSetNames) {
      const filePath = path.join(
        directory,
        `${permissionSetName}.permissionset-meta.xml`
      );

      try {
        const permissionSet =
          await parsePermissionSet(filePath);

        permissionSets.push(permissionSet);
      } catch {
        if (isKnownSalesforcePermissionSet(permissionSetName)) {
          try {
            await access(filePath);
          } catch {
            continue; // Known Salesforce-owned Permission Set not supplied in SFDX metadata.
          }
        }
        console.warn(
          `Could not find or parse Permission Set: ${permissionSetName}`
        );
      }
    }

    return permissionSets;
  }

  private async parseMutingPermissionSets(
  permissionSetNames: string[]
): Promise<PermissionSet[]> {
  const permissionSets: PermissionSet[] = [];

  for (const permissionSetName of permissionSetNames) {
    const filePath = path.join(
      this.mutingPermissionSetsDirectory,
      `${permissionSetName}.mutingpermissionset-meta.xml`
    );

    try {
      const permissionSet =
        await parseMutingPermissionSet(filePath);

      permissionSets.push(permissionSet);
    } catch {
      console.warn(
        `Could not find or parse Muting Permission Set: ${permissionSetName}`
      );
    }
  }

  return permissionSets;
}
}