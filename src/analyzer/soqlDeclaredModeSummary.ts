import type { SoqlQuery } from "../models/SoqlQuery.js";

/**
 * Count the mode explicitly declared by each scanned root query.
 * This is deliberately separate from the effective runtime mode, which may
 * depend on the Apex API version. Every analyzed query belongs to one bucket.
 */
export interface DeclaredSoqlModeCounts {
  userModeQueries: number;
  securityEnforcedQueries: number;
  systemModeQueries: number;
  unspecifiedModeQueries: number;
}

export function countDeclaredSoqlModes(
  queries: readonly Pick<SoqlQuery, "securityMode">[],
): DeclaredSoqlModeCounts {
  const counts: DeclaredSoqlModeCounts = {
    userModeQueries: 0,
    securityEnforcedQueries: 0,
    systemModeQueries: 0,
    unspecifiedModeQueries: 0,
  };

  for (const query of queries) {
    switch (query.securityMode) {
      case "USER_MODE":
        counts.userModeQueries++;
        break;
      case "SECURITY_ENFORCED":
        counts.securityEnforcedQueries++;
        break;
      case "SYSTEM_MODE":
        counts.systemModeQueries++;
        break;
      case "UNSPECIFIED":
        counts.unspecifiedModeQueries++;
        break;
      default: {
        // Fail closed if the classifier later adds a mode; never lose queries.
        const unsupportedMode: never = query.securityMode;
        throw new Error(`Unexpected declared SOQL mode: ${unsupportedMode}`);
      }
    }
  }

  return counts;
}
