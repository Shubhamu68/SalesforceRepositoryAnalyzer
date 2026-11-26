import type { DeclaredSoqlMode, EffectiveSoqlMode, SoqlRuntimeImpact } from "../analyzer/soqlExecutionMode.js";

/** Internal outcome. INFO means missing repository permission was confirmed in Salesforce. */
export type SoqlFindingSeverity = "ERROR" | "REVIEW" | "INFO";

/** Excel-facing criticality. Unknown is never presented as a denial. */
export type SoqlFindingCriticality = "High" | "Low" | "Unable to verify";
export type SoqlVerificationSource = "ORG_DENIED" | "ORG_VERIFIED" | "UNVERIFIED";
export type SoqlFindingType = "OBJECT_READ" | "FIELD_READ" | "RELATIONSHIP" | "QUERY_MODE" | "PARSER";

export interface SoqlSecurityFinding {
  severity: SoqlFindingSeverity;
  criticality?: SoqlFindingCriticality;
  verificationSource?: SoqlVerificationSource;
  findingType?: SoqlFindingType;
  filePath: string;
  lineNumber: number;
  /** Internal query identity; Excel layout remains unchanged. */
  queryVariantId?: string;
  /** Reporting-only caveat for a source-proven sample, not complete coverage. */
  limitedVariantCoverage?: boolean;
  /** Recovered permission references, not necessarily an executable query or complete coverage. */
  limitedPartialCoverage?: boolean;
  object: string;
  field: string;
  query: string;
  withUserMode: boolean;
  /** Runtime enforcement is distinct from persona permission severity. */
  declaredMode?: DeclaredSoqlMode;
  effectiveMode?: EffectiveSoqlMode;
  runtimeImpact?: SoqlRuntimeImpact;
  apiVersion?: number;
  /** Resolved nested query scope, e.g. Account -> Contacts. */
  relationshipPath?: string;
  queryLevel?: number;
  reason: string;
}
