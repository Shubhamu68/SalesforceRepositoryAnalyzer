import type { DeclaredSoqlMode, EffectiveSoqlMode, SoqlRuntimeImpact } from "../analyzer/soqlExecutionMode.js";

/** Internal outcome. INFO means missing repository permission was confirmed in Salesforce. */
export type SoqlFindingSeverity = "ERROR" | "REVIEW" | "INFO";

/** Excel-facing criticality. Unknown is never presented as a denial. */
export type SoqlFindingCriticality = "High" | "Low" | "Unable to verify";
export type SoqlVerificationSource = "ORG_DENIED" | "ORG_VERIFIED" | "UNVERIFIED";
export type SoqlFindingType = "OBJECT_READ" | "FIELD_READ" | "RELATIONSHIP" | "QUERY_MODE";

export interface SoqlSecurityFinding {
  severity: SoqlFindingSeverity;
  criticality?: SoqlFindingCriticality;
  verificationSource?: SoqlVerificationSource;
  findingType?: SoqlFindingType;
  filePath: string;
  lineNumber: number;
  object: string;
  field: string;
  query: string;
  withUserMode: boolean;
  /** Runtime enforcement is distinct from persona permission severity. */
  declaredMode?: DeclaredSoqlMode;
  effectiveMode?: EffectiveSoqlMode;
  runtimeImpact?: SoqlRuntimeImpact;
  apiVersion?: number;
  reason: string;
}
