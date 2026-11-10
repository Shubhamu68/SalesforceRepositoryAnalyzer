import type { Persona } from "../models/Persona.js";

export interface OrgProfile {
  id: string;
  name: string;
  developerName?: string;
}

export interface OrgUser {
  id: string;
  profileId: string;
}

export interface OrgAssignment {
  userId: string;
  /** Direct assignments only; profile-backed and PSG-generated entries are excluded. */
  permissionSets: Set<string>;
  permissionSetGroups: Set<string>;
}

export type MatchedPersona = {
  /** Eligible active users, ordered exact first, then fewest extra assignments. */
  users: string[];
  /** Users matching Profile and ALL persona-required PSs/PSGs, extras allowed. */
  eligibleCount: number;
  /** Of the eligible users, those with no extra direct PS/PSG assignments. */
  exactCount: number;
  /** Eligible users who have additional direct assignments not listed in personas.json. */
  extraAssignmentCount: number;
  reason?: string;
};

const norm = (name: string): string => name.trim().toLowerCase();
const asSet = (values: string[]): Set<string> => new Set(values.map(norm));
const containsAll = (present: Set<string>, required: Set<string>): boolean =>
  [...required].every((name) => present.has(name));

/**
 * personas.json describes the MINIMUM assignments relevant to this analyzer,
 * not a complete inventory of a Salesforce user's access. Users can also have
 * additional unrelated Permission Sets or Groups.
 *
 * Extra assignments are not ignored for evidence: we count and disclose them,
 * since they could contribute to the effective access Salesforce reports.
 */
export function matchPersonaUsers(
  persona: Persona,
  profiles: OrgProfile[],
  users: OrgUser[],
  assignments: Map<string, OrgAssignment>
): MatchedPersona {
  const empty = { users: [], eligibleCount: 0, exactCount: 0, extraAssignmentCount: 0 };
  if (!persona.profile?.trim()) return { ...empty,
    reason: "Persona has no configured Profile; an org user cannot be matched safely." };

  const profileName = norm(persona.profile);
  const profilesForPersona = profiles.filter((profile) =>
    norm(profile.name) === profileName || norm(profile.developerName ?? "") === profileName ||
    // The standard Admin profile is named System Administrator in the UI.
    (profileName === "admin" && norm(profile.name) === "system administrator")
  );
  if (!profilesForPersona.length) return { ...empty,
    reason: `Profile ${persona.profile} was not found in the connected org.` };

  const profileIds = new Set(profilesForPersona.map((profile) => profile.id));
  const requiredPS = asSet(persona.permissionSets ?? []);
  const requiredPSG = asSet(persona.permissionSetGroups ?? []);
  const eligible: Array<{ userId: string; extra: number }> = [];
  let exactCount = 0;

  for (const user of users) {
    if (!profileIds.has(user.profileId)) continue;
    const found = assignments.get(user.id) ?? {
      userId: user.id, permissionSets: new Set<string>(), permissionSetGroups: new Set<string>()
    };
    // Configured assignments are minimum requirements, not exhaustive lists.
    if (!containsAll(found.permissionSets, requiredPS) ||
        !containsAll(found.permissionSetGroups, requiredPSG)) continue;

    const extra = [...found.permissionSets].filter((ps) => !requiredPS.has(ps)).length +
      [...found.permissionSetGroups].filter((psg) => !requiredPSG.has(psg)).length;
    if (extra === 0) exactCount++;
    eligible.push({ userId: user.id, extra });
  }

  // Prefer least-extra-grant examples first. Stable ID tie-break for repeatability.
  eligible.sort((a, b) => a.extra - b.extra || a.userId.localeCompare(b.userId));
  return {
    users: eligible.map((entry) => entry.userId),
    eligibleCount: eligible.length,
    exactCount,
    extraAssignmentCount: eligible.length - exactCount,
    ...(eligible.length === 0 ? {
      reason: "No active user has this persona's Profile and all required Permission Sets/PSGs."
    } : {})
  };
}
