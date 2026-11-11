export interface SoqlFieldReference {
  object: string;
  field: string;
  queryFieldPath: string;
  filePath: string;
  /** Actual field/subquery line in Apex. */
  lineNumber: number;
  /** Parent SOQL line for execution-mode lookup. */
  queryLineNumber?: number;
  relationshipPath?: string;
}
export interface SoqlFieldInventory extends Map<string, Map<string, SoqlFieldReference[]>> {
  /** Object Read references, independent of field/FLS (covers COUNT() too). */
  objectReferences: Map<string, SoqlFieldReference[]>;
}
