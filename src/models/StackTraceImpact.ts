export type ImpactStatus = "AT_RISK" | "REVIEW" | "NO_GAPS" | "ORG_VERIFIED";

export interface ApexStackFrame {
  kind: "Class" | "Trigger";
  className: string;
  methodName?: string;
  line: number;
  raw: string;
}

export interface ReachableMethod {
  id: string;
  className: string;
  methodName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  depth: number;
  callPaths: string[][];
}

export interface ResolvedQueryField {
  object: string;
  field: string;
  source: string;
}

/** Actual active users whose Salesforce permissions were queried for this persona. */
export interface OrgCheckedUser {
  id: string;
  name: string;
  username: string;
}

export interface MissingReadPermission {
  object: string;
  field?: string;
  reason: "OBJECT_READ" | "FIELD_READ";
  /** Live verification status for either object or field Read. */
  orgOutcome?: "DENIED" | "UNVERIFIED";
  orgMessage?: string;
}

export interface VerifiedOrgObject {
  object: string;
  field?: string;
  checkedUsers: number;
  matchedUsers: number;
  sampled: boolean;
  message: string;
}

export interface QueryPersonaImpact {
  personaName: string;
  status: ImpactStatus;
  missing: MissingReadPermission[];
  verifiedFromOrg?: VerifiedOrgObject[];
  /** Only users who were actually queried; absent for repository-only results. */
  orgCheckedUsers?: OrgCheckedUser[];
  notes: string[];
}

export interface StackQueryImpact {
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
  checkedFields: ResolvedQueryField[];
  unresolvedFields: string[];
  limitations: string[];
  personas: QueryPersonaImpact[];
}

export interface StackPersonaImpact {
  personaName: string;
  status: ImpactStatus;
  atRiskQueries: number;
  reviewQueries: number;
  missing: MissingReadPermission[];
  verifiedFromOrg?: VerifiedOrgObject[];
  /** Deduplicated users checked across the persona's SOQL queries. */
  orgCheckedUsers?: OrgCheckedUser[];
}

export interface StackTraceImpactResult {
  entryMethod: ReachableMethod;
  frames: ApexStackFrame[];
  methods: ReachableMethod[];
  queries: StackQueryImpact[];
  personas: StackPersonaImpact[];
  summary: {
    methodsVisited: number;
    queriesFound: number;
    personasChecked: number;
    atRisk: number;
    review: number;
    noGaps: number;
    orgVerified?: number;
  };
  warnings: string[];
}
