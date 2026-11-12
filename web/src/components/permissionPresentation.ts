export type PermissionEvidence = {
  source: "REPOSITORY" | "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
  message: string;
  matchedUsers?: number;
  checkedUsers?: number;
};

export function permissionPresentation(granted: boolean, evidence?: PermissionEvidence): {
  label: "Yes" | "No" | "Review";
  tone: "allowed" | "denied" | "review";
  orgWarning: boolean;
  title: string;
} {
  if (evidence?.source === "UNVERIFIED") return {
    label: "Review", tone: "review", orgWarning: false, title: evidence.message,
  };
  if (evidence?.source === "ORG_DENIED") return {
    label: "No", tone: "denied", orgWarning: false, title: evidence.message,
  };
  if (evidence?.source === "ORG_VERIFIED") return {
    label: "Yes", tone: "allowed", orgWarning: true, title: evidence.message,
  };
  return {
    label: granted ? "Yes" : "No",
    tone: granted ? "allowed" : "denied",
    orgWarning: false,
    title: granted ? "Access established from repository metadata." :
      "No repository grant established; Salesforce org verification has not confirmed this permission.",
  };
}
