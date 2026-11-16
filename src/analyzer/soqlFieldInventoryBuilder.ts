import type { SoqlQuery } from "../models/SoqlQuery.js";
import type { SoqlFieldInventory, SoqlFieldReference } from "../models/SoqlFieldInventory.js";
import type { RelationshipMap } from "./salesforceRelationshipResolver.js";
import { collectQueryFields } from "./soqlQueryFieldResolver.js";

export interface UnresolvedSoqlField {
  baseObject: string;
  fieldPath: string;
  query: SoqlQuery;
  kind?: "FIELD" | "RELATIONSHIP";
  lineNumber?: number;
  relationshipPath?: string;
}

/** One shared collector for SOQL Security, Stack Trace, and future consumers. */
export function buildSoqlFieldInventory(
  queries: SoqlQuery[],
  relationshipMap: RelationshipMap,
  onUnresolved?: (field: UnresolvedSoqlField) => void,
  onLimitation?: (query: SoqlQuery, message: string) => void,
): SoqlFieldInventory {
  const inventory = new Map() as SoqlFieldInventory;
  inventory.objectReferences = new Map();
  for (const query of queries) {
    const collection = collectQueryFields(query, relationshipMap);
    for (const field of collection.references) {
      const fields = inventory.get(field.object) ?? new Map<string, SoqlFieldReference[]>();
      const fieldKey = field.field.toLowerCase();
      const references = fields.get(fieldKey) ?? [];
      references.push({
        object: field.object, field: field.field, queryFieldPath: field.source,
        filePath: query.filePath, lineNumber: field.lineNumber,
        queryLineNumber: field.queryLineNumber, relationshipPath: field.relationshipPath,
        ...(field.usageContext ? { usageContext: field.usageContext } : {}),
        ...(field.functionName ? { functionName: field.functionName } : {}),
      });
      fields.set(fieldKey, references);
      inventory.set(field.object, fields);
    }
    for (const scoped of collection.scopes) {
      // Preserve SELECT COUNT() or a nested object with no permissionable fields.
      if (!inventory.has(scoped.object)) inventory.set(scoped.object, new Map());
      const list = inventory.objectReferences.get(scoped.object) ?? [];
      const key = [query.filePath, query.lineNumber, scoped.relationshipPath].join("|");
      if (!list.some(ref => [ref.filePath, ref.queryLineNumber, ref.relationshipPath].join("|") === key)) {
        list.push({
          object: scoped.object, field: "", queryFieldPath: "",
          filePath: query.filePath, lineNumber: scoped.lineNumber,
          queryLineNumber: query.lineNumber, relationshipPath: scoped.relationshipPath,
        });
      }
      inventory.objectReferences.set(scoped.object, list);
    }
    for (const limitation of collection.limitations) onLimitation?.(query, limitation);
    for (const missing of collection.unresolvedEntries) {
      onUnresolved?.({
        baseObject: missing.baseObject, fieldPath: missing.fieldPath, kind: missing.kind,
        lineNumber: missing.lineNumber, relationshipPath: missing.relationshipPath, query,
      });
    }
  }
  return inventory;
}
