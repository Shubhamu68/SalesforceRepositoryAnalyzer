export interface SoqlFieldReference {
  object: string;
  field: string;

  // Original value exactly as it appeared in SOQL.
  queryFieldPath: string;

  filePath: string;
  lineNumber: number;
}

export type SoqlFieldInventory =
  Map<string, Map<string, SoqlFieldReference[]>>;