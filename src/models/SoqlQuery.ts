export type SoqlSecurityMode =
  | "USER_MODE"
  | "NO_USER_MODE";

export interface SoqlQuery {
  filePath: string;
  lineNumber: number;
  query: string;
  object: string;
  fields: string[];
  withUserMode: boolean;
  securityMode: SoqlSecurityMode;
}