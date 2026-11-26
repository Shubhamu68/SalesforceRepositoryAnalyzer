export interface SoqlFieldReference {
  object: string;
  field: string;
  queryFieldPath: string;
  filePath: string;
  /** Actual field/subquery line in Apex. */
  lineNumber: number;
  /** Parent SOQL line for execution-mode lookup. */
  queryLineNumber?: number;
  /** Internal exact query identity for same-line variants. */
  queryVariantId?: string;
  relationshipPath?: string;
  /** SELECT versus filter/group/order usage matters for legacy SECURITY_ENFORCED. */
  usageContext?: "SELECT" | "WHERE" | "GROUP_BY" | "HAVING" | "ORDER_BY";
  /** Function that supplied this field operand, if applicable. */
  functionName?: string;
}
export interface SoqlFieldInventory extends Map<string, Map<string, SoqlFieldReference[]>> {
  /** Object Read references, independent of field/FLS (covers COUNT() too). */
  objectReferences: Map<string, SoqlFieldReference[]>;
}
