/** API response types shared by the Stack Trace view and its pure view-model helpers. */
export type Status = "AT_RISK" | "REVIEW" | "NO_GAPS" | "ORG_VERIFIED" | "ADVISORY";
export type Missing = {
  object: string;
  field?: string;
  reason: "OBJECT_READ" | "FIELD_READ";
  orgOutcome?: "DENIED" | "UNVERIFIED";
  orgMessage?: string;
  orgReason?: "NO_MATCHING_USERS" | "NO_LOGGED_IN_USERS";
};
export type OrgVerified = {
  object: string;
  field?: string;
  matchedUsers: number;
  checkedUsers: number;
  sampled: boolean;
  message: string;
};
export type OrgCheckedUser = { id: string; name: string; username: string };
export type Frame = { kind: string; className: string; methodName?: string; line: number };
export type Method = {
  id: string;
  className: string;
  methodName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  depth: number;
  callPaths: string[][];
};
export type Impact = {
  personaName: string;
  status: Status;
  missing: Missing[];
  verifiedFromOrg?: OrgVerified[];
  orgCheckedUsers?: OrgCheckedUser[];
  notes: string[];
};
export type Query = {
  id: string;
  methodId: string;
  className: string;
  methodName: string;
  filePath: string;
  lineNumber: number;
  object: string;
  query: string;
  withUserMode: boolean;
  securityMode: "USER_MODE" | "SECURITY_ENFORCED" | "SYSTEM_MODE" | "UNSPECIFIED";
  effectiveMode?: "USER_MODE" | "SYSTEM_MODE" | "SECURITY_ENFORCED" | "UNKNOWN" | "INVALID_CLAUSE";
  permissionEnforcement?: "FULL" | "SELECT_ONLY" | "NONE" | "UNKNOWN" | "INVALID";
  apiVersion?: number;
  checkedFields: { object: string; field: string; source: string }[];
  unresolvedFields: string[];
  limitations: string[];
  personas: Impact[];
};
export type Persona = {
  personaName: string;
  status: Status;
  atRiskQueries: number;
  reviewQueries: number;
  advisoryQueries?: number;
  missing: Missing[];
  verifiedFromOrg?: OrgVerified[];
  orgCheckedUsers?: OrgCheckedUser[];
};
export type Result = {
  entryMethod: Method;
  frames: Frame[];
  methods: Method[];
  queries: Query[];
  personas: Persona[];
  summary: {
    methodsVisited: number;
    queriesFound: number;
    personasChecked: number;
    atRisk: number;
    review: number;
    advisory?: number;
    noGaps: number;
    orgVerified?: number;
  };
  warnings: string[];
};
