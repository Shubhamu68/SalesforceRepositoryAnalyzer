import path from "node:path";
import { access } from "node:fs/promises";
import { isKnownSalesforcePermissionSet } from "../config/knownSalesforcePermissionSets.js";
import type { Persona } from "../models/Persona.js";
import type { Profile } from "../models/Profile.js";
import type { PermissionSet } from "../models/PermissionSet.js";
import type { PermissionSetGroup } from "../models/PermissionSetGroup.js";
import { parseProfile } from "../parser/profileParser.js";
import { parseMutingPermissionSet } from "../parser/mutingPermissionSetParser.js";
import { parsePermissionSet } from "../parser/permissionSetParser.js";
import { parsePermissionSetGroup } from "../parser/permissionSetGroupParser.js";
import type { PermissionSetGrant } from "../models/PermissionSetGrant.js";

export interface ResolvedPersonaPermissions {
  persona: Persona;
  /** A Profile is assigned to a persona only through config/personas.json. */
  profile?: Profile;
  permissionSetGroups: PermissionSetGroup[];
  directPermissionSets: PermissionSet[];
  mutingPermissionSets: PermissionSet[];
  permissionSetGrants: PermissionSetGrant[];
  /** Mutes are scoped to the PSG that owns them, never to the profile or direct PS. */
  mutesByGroup: Map<string, PermissionSet[]>;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class PersonaPermissionResolver {
  private readonly profilesDirectory: string;
  private readonly parsedProfiles = new Map<string, Promise<Profile>>();

  constructor(
    private readonly permissionSetsDirectory: string,
    private readonly permissionSetGroupsDirectory: string,
    private readonly mutingPermissionSetsDirectory: string,
    profilesDirectory?: string
  ) {
    this.profilesDirectory = profilesDirectory ?? path.join(path.dirname(permissionSetsDirectory), "profiles");
  }

  async resolve(persona: Persona): Promise<ResolvedPersonaPermissions> {
    let profile: Profile | undefined;
    if (persona.profile) {
      const profileName = persona.profile.trim();
      if (profileName.includes("..") || /[/\\]/.test(profileName)) {
        throw new Error(`Invalid profile metadata name for persona '${persona.name}'.`);
      }
      const filePath = path.join(this.profilesDirectory, `${profileName}.profile-meta.xml`);
      let parsed = this.parsedProfiles.get(filePath);
      if (!parsed) {
        parsed = parseProfile(filePath);
        this.parsedProfiles.set(filePath, parsed);
      }
      try {
        profile = await parsed;
      } catch (error) {
        this.parsedProfiles.delete(filePath);
        throw new Error(
          `Profile '${profileName}' mapped to persona '${persona.name}' could not be loaded from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const permissionSetGroups: PermissionSetGroup[] = [];
    for (const groupName of persona.permissionSetGroups) {
      const filePath = path.join(this.permissionSetGroupsDirectory, `${groupName}.permissionsetgroup-meta.xml`);
      try {
        permissionSetGroups.push(await parsePermissionSetGroup(filePath, this.permissionSetsDirectory));
      } catch (error) {
        console.warn(`Could not load Permission Set Group: ${groupName}`, error);
      }
    }

    const directPermissionSets: PermissionSet[] = [];
    for (const name of persona.permissionSets) {
      const filePath = path.join(this.permissionSetsDirectory, `${name}.permissionset-meta.xml`);
      try {
        directPermissionSets.push(await parsePermissionSet(filePath));
      } catch (error) {
        if (isKnownSalesforcePermissionSet(name)) {
          try { await access(filePath); } catch { continue; }
        }
        console.warn(`Could not load Permission Set: ${name}`, error);
      }
    }

    const mutesByGroup = new Map<string, PermissionSet[]>();
    const parsedMutes = new Map<string, Promise<PermissionSet>>();
    const allMuting = new Map<string, PermissionSet>();
    for (const group of permissionSetGroups) {
      // Legacy persona configs don't associate mutes to groups. The single-PSG
      // fallback is safe only if the persona has exactly one PSG.
      const muteNames = group.mutingPermissionSetNames.length
        ? group.mutingPermissionSetNames
        : permissionSetGroups.length === 1 ? persona.mutingPermissionSets : [];
      const members: PermissionSet[] = [];
      for (const name of new Set(muteNames)) {
        const filePath = path.join(this.mutingPermissionSetsDirectory, `${name}.mutingpermissionset-meta.xml`);
        let parsed = parsedMutes.get(filePath);
        if (!parsed) {
          parsed = parseMutingPermissionSet(filePath);
          parsedMutes.set(filePath, parsed);
        }
        try {
          const mute = await parsed;
          members.push(mute);
          allMuting.set(mute.name.toLowerCase(), mute);
        } catch (error) {
          console.warn(`Could not load Muting Permission Set: ${name} (PSG: ${group.name})`, error);
        }
      }
      mutesByGroup.set(group.name, members);
    }

    const permissionSetGrants: PermissionSetGrant[] = [];
    if (profile) permissionSetGrants.push({ permissionSet: profile, type: "profile" });
    for (const group of permissionSetGroups) {
      for (const permissionSet of group.permissionSets) {
        permissionSetGrants.push({ permissionSet, type: "permissionSetGroup", permissionSetGroup: group.name });
      }
    }
    for (const permissionSet of directPermissionSets) {
      permissionSetGrants.push({ permissionSet, type: "directPermissionSet" });
    }

    return {
      persona,
      profile,
      permissionSetGroups,
      directPermissionSets,
      mutingPermissionSets: [...allMuting.values()],
      permissionSetGrants,
      mutesByGroup,
    };
  }
}
