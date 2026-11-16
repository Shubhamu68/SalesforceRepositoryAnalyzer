export type PermissionEvidence = {
  source: "REPOSITORY" | "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
  message: string;
  matchedUsers?: number;
  checkedUsers?: number;
};

export type PermissionDisplay = {
  label: "Yes" | "No" | "Review";
  tone: "allowed" | "denied" | "review";
  /** Successful org verification is provenance, not a warning. */
  orgVerified: boolean;
  title: string;
};

/**
 * Repository grant -> Yes. Salesforce VERIFIED -> Yes, DENIED -> No.
 * A missing repository grant is not a Salesforce denial; without explicit
 * negative evidence the only safe label is Review.
 */
export function permissionPresentation(granted: boolean, evidence?: PermissionEvidence): PermissionDisplay {
  if (evidence?.source === "UNVERIFIED") return {
    label: "Review", tone: "review", orgVerified: false, title: evidence.message,
  };
  if (evidence?.source === "ORG_DENIED") return {
    label: "No", tone: "denied", orgVerified: false, title: evidence.message,
  };
  if (evidence?.source === "ORG_VERIFIED") return granted ? {
    label: "Yes", tone: "allowed", orgVerified: true, title: evidence.message,
  } : {
    label: "Review", tone: "review", orgVerified: false,
    title: "Conflicting evidence: Salesforce reports a grant but effective access is not established. " + evidence.message,
  };
  if (granted) return {
    label: "Yes", tone: "allowed", orgVerified: false,
    title: evidence?.message || "Access established from repository metadata.",
  };
  return {
    label: "Review", tone: "review", orgVerified: false,
    title: evidence?.message ||
      "Repository metadata did not establish this permission. Salesforce verification is unavailable or inconclusive; this is not a confirmed denial.",
  };
}
