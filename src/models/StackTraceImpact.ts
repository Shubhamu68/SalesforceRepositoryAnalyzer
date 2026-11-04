export type ImpactStatus = "AT_RISK" | "REVIEW" | "NO_GAPS";

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

export interface MissingReadPermission {
  object: string;
  field?: string;
  reason: "OBJECT_READ" | "FIELD_READ";
}

export interface QueryPersonaImpact {
  personaName: string;
  status: ImpactStatus;
  missing: MissingReadPermission[];
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
  };
  warnings: string[];
}
