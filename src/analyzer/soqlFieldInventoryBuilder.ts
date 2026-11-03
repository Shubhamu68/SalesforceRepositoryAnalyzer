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
  RelationshipMetadata,
} from "./salesforceRelationshipResolver.js";

import {
  isIgnoredField,
  isAggregateExpression,
  isExcludedObjectField
} from "./soqlSystemFields.js";

export function buildSoqlFieldInventory(
  queries: SoqlQuery[],
  relationshipMap: RelationshipMap
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
      relationshipMap
    );

    /*
     * Recursively process child subqueries.
     */
    processSubqueries(
      inventory,
      query.object,
      query.subqueries,
      query,
      relationshipMap
    );
  }

  return inventory;
}

function processSubqueries(
  inventory: SoqlFieldInventory,
  parentObject: string,
  subqueries: SoqlSubquery[],
  rootQuery: SoqlQuery,
  relationshipMap: RelationshipMap
): void {
  for (const subquery of subqueries) {
    const relationship =
      findRelationshipIgnoreCase(
        relationshipMap.get(
          parentObject
        ),
        subquery.relationshipName
      );

    /*
     * We could not resolve:
     *
     * Parent Object
     *   +
     * Child Relationship Name
     *   ->
     * Actual Child Object
     *
     * In this case, skip this subquery rather
     * than incorrectly assigning its fields to
     * the parent object.
     */
    if (!relationship) {
      continue;
    }

    const childObject =
      relationship.childObject;

    /*
     * Process fields directly selected from
     * the resolved child object.
     */
    addFieldsToInventory(
      inventory,
      childObject,
      subquery.fields,
      rootQuery,
      relationshipMap
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
      relationshipMap
    );
  }
}

function addFieldsToInventory(
  inventory: SoqlFieldInventory,
  baseObject: string,
  fieldsToProcess: string[],
  query: SoqlQuery,
  relationshipMap: RelationshipMap
): void {
  for (const queryField of fieldsToProcess) {
    if (
      isAggregateExpression(
        queryField
      )
    ) {
      continue;
    }

    const resolved =
      resolveFieldPath(
        baseObject,
        queryField,
        relationshipMap
      );

    if (!resolved) {
      continue;
    }

    const {
      object,
      field,
    } = resolved;

    if (
      isIgnoredField(field) ||
      isExcludedObjectField(object, field)
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

interface ResolvedField {
  object: string;
  field: string;
}

function resolveFieldPath(
  baseObject: string,
  fieldPath: string,
  relationshipMap: RelationshipMap
): ResolvedField | undefined {
  const parts =
    fieldPath
      .split(".")
      .map(
        (part) => part.trim()
      )
      .filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  /*
   * Simple field.
   *
   * Example:
   *
   * Name
   */
  if (parts.length === 1) {
    return {
      object: baseObject,
      field: parts[0],
    };
  }

  /*
   * Parent relationship traversal.
   *
   * Example:
   *
   * Account.Owner.Name
   *
   * The existing relationship metadata map
   * is used to walk each relationship.
   */
  let currentObject =
    baseObject;

  for (
    let index = 0;
    index < parts.length - 1;
    index++
  ) {
    const relationshipName =
      parts[index];

    const relationship =
      findRelationshipIgnoreCase(
        relationshipMap.get(
          currentObject
        ),
        relationshipName
      );

    if (!relationship) {
      return undefined;
    }

    /*
     * A relationship field can theoretically
     * reference multiple objects.
     *
     * We cannot safely determine one field
     * object for polymorphic relationships,
     * so leave those for future explicit
     * handling.
     */
    if (
      relationship.targetObjects.length !==
      1
    ) {
      return undefined;
    }

    currentObject =
      relationship.targetObjects[0];
  }

  return {
    object: currentObject,
    field:
      parts[
        parts.length - 1
      ],
  };
}

function findRelationshipIgnoreCase(
  relationships:
    | Map<
        string,
        RelationshipMetadata
      >
    | undefined,
  relationshipName: string
): RelationshipMetadata | undefined {
  if (!relationships) {
    return undefined;
  }

  const normalized =
    relationshipName
      .trim()
      .toLowerCase();

  for (
    const [
      name,
      relationship,
    ] of relationships.entries()
  ) {
    if (
      name
        .trim()
        .toLowerCase() ===
      normalized
    ) {
      return relationship;
    }
  }

  return undefined;
}