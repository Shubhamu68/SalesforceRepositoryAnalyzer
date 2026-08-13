export type SoqlFindingSeverity =
  | "ERROR"
  | "REVIEW";

export interface SoqlSecurityFinding {
  severity: SoqlFindingSeverity;

  filePath: string;
  lineNumber: number;

  object: string;
  field: string;

  query: string;

  withUserMode: boolean;

  reason: string;
}