import type { Impact, Missing, OrgVerified, Persona, Query } from "./stackTraceTypes";

/** Never interpolate raw verification messages into the primary UI: they can be verbose and misleading. */
export const permissionLabel = (item: { object: string; field?: string }) =>
  `${item.object}${item.field ? `.${item.field}` : ""}`;

export const orgVerifiedSummary = (item: OrgVerified) =>
  `Verified from Org: ${permissionLabel(item)} Read — Access verified from Salesforce`;

export function partitionFindings(items: Missing[]) {
  const byName = (a: Missing, b: Missing) =>
    permissionLabel(a).localeCompare(permissionLabel(b));
  return {
    denied: items.filter((item) => item.orgOutcome === "DENIED").sort(byName),
    unverified: items.filter((item) => item.orgOutcome !== "DENIED").sort(byName),
  };
}

/** Do not confuse an unavailable Salesforce connection with zero persona matches. */
export function hasNoMatchingUsers(persona: Persona): boolean {
  const { unverified, denied } = partitionFindings(persona.missing);
  return persona.status === "REVIEW" && denied.length === 0 && unverified.length > 0 &&
    !persona.orgCheckedUsers?.length && unverified.every((item) => item.orgReason === "NO_MATCHING_USERS");
}

/** Limit all query displays to the selected persona, instead of rendering every persona per query. */
export function focusedQueries(queries: Query[], name: string, onlyIssues: boolean) {
  if (!name) return [];
  const focused: Array<{ query: Query; impact: Impact }> = [];
  for (const query of queries) {
    const impact = query.personas.find((persona) => persona.personaName === name);
    if (!impact || (onlyIssues && impact.status !== "AT_RISK" && impact.status !== "REVIEW")) continue;
    focused.push({ query, impact });
  }
  return focused;
}
