import {
  SoqlQuery,
  SoqlSubquery,
} from "../models/SoqlQuery.js";

import {
  SoqlFieldInventory,
  SoqlFieldReference,
} from "../models/SoqlFieldInventory.js";

import {
  RelationshipMap,
} from "./salesforceRelationshipResolver.js";

import {
  isIgnoredField,
  isAggregateExpression
} from "./soqlSystemFields.js";

export interface UnresolvedSoqlField { baseObject: string; fieldPath: string; query: SoqlQuery }

export function buildSoqlFieldInventory(
  queries: SoqlQuery[],
  relationshipMap: RelationshipMap,
  onUnresolved?: (field: UnresolvedSoqlField) => void
): SoqlFieldInventory {
  const inventory: SoqlFieldInventory =
    new Map();

  for (const query of queries) {
    /*
     * Process fields selected directly from
     * the root object.
     */
    addFieldsToInventory(
      inventory,
      query.object,
      query.fields,
      query,
      relationshipMap,
      onUnresolved
    );

    /*
     * Recursively process child subqueries.
     */
    processSubqueries(
      inventory,
      query.object,
      query.subqueries,
      query,
      relationshipMap,
      onUnresolved
    );
  }

  return inventory;
}

function processSubqueries(
  inventory: SoqlFieldInventory,
  parentObject: string,
  subqueries: SoqlSubquery[],
  rootQuery: SoqlQuery,
  relationshipMap: RelationshipMap,
  onUnresolved?: (field: UnresolvedSoqlField) => void
): void {
  for (const subquery of subqueries) {
    const childObject = relationshipMap.childObject(parentObject, subquery.relationshipName);
    if (!childObject) {
      onUnresolved?.({ baseObject: parentObject, fieldPath: `(SELECT ... FROM ${subquery.relationshipName})`, query: rootQuery });
      continue;
    }

    /*
     * Process fields directly selected from
     * the resolved child object.
     */
    addFieldsToInventory(
      inventory,
      childObject,
      subquery.fields,
      rootQuery,
      relationshipMap,
      onUnresolved
    );

    /*
     * Resolve further nesting from the child
     * object.
     *
     * Example:
     *
     * Account
     *   -> Contacts
     *   -> Contact
     *        -> Custom_Children__r
     *        -> Custom_Child__c
     */
    processSubqueries(
      inventory,
      childObject,
      subquery.subqueries,
      rootQuery,
      relationshipMap,
      onUnresolved
    );
  }
}

function addFieldsToInventory(
  inventory: SoqlFieldInventory,
  baseObject: string,
  fieldsToProcess: string[],
  query: SoqlQuery,
  relationshipMap: RelationshipMap,
  onUnresolved?: (field: UnresolvedSoqlField) => void
): void {
  for (const queryField of fieldsToProcess) {
    if (
      isAggregateExpression(
        queryField
      )
    ) {
      continue;
    }

    const resolved = relationshipMap.resolveField(baseObject, queryField);

    if (!resolved) {
      onUnresolved?.({ baseObject, fieldPath: queryField, query });
      continue;
    }

    const {
      object,
      field,
    } = resolved;

    if (
      isIgnoredField(field, object)
    ) {
      continue;
    }

    if (
      !inventory.has(object)
    ) {
      inventory.set(
        object,
        new Map()
      );
    }

    const fields =
      inventory.get(object)!;

    const normalizedField =
      field
        .trim()
        .toLowerCase();

    if (
      !fields.has(
        normalizedField
      )
    ) {
      fields.set(
        normalizedField,
        []
      );
    }

    const references =
      fields.get(
        normalizedField
      )!;

    const reference:
      SoqlFieldReference = {
        object,
        field,

        queryFieldPath:
          queryField,

        filePath:
          query.filePath,

        lineNumber:
          query.lineNumber,
      };

    references.push(
      reference
    );
  }
}

