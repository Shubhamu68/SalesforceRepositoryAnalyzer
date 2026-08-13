import { SoqlQuery } from "../models/SoqlQuery.js";
import {
  SoqlFieldInventory,
  SoqlFieldReference,
} from "../models/SoqlFieldInventory.js";
import {
  RelationshipMap,
} from "./salesforceRelationshipResolver.js";
import {
  isIgnoredField,
  isAggregateExpression,
} from "./soqlSystemFields.js";

export function buildSoqlFieldInventory(
  queries: SoqlQuery[],
  relationshipMap: RelationshipMap
): SoqlFieldInventory {
  const inventory: SoqlFieldInventory =
    new Map();

  for (const query of queries) {
    for (const queryField of query.fields) {
      if (isAggregateExpression(queryField)) {
        continue;
      }
      const resolved =
        resolveFieldPath(
          query.object,
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

      if (isIgnoredField(field)) {
        continue;
      }

      if (!inventory.has(object)) {
        inventory.set(
          object,
          new Map()
        );
      }

      const fields =
        inventory.get(object)!;

      const normalizedField =
        field.trim().toLowerCase();

      if (!fields.has(normalizedField)) {
        fields.set(
          normalizedField,
          []
        );
      }

      const references = fields.get(normalizedField)!;

      const reference: SoqlFieldReference = {
        object,
        field: field,
        queryFieldPath: queryField,
        filePath: query.filePath,
        lineNumber: query.lineNumber,
      };

      references.push(reference);
    }
  }

  return inventory;
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
    fieldPath.split(".").filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  if (parts.length === 1) {
  return {
    object: baseObject,
    field: parts[0].trim(),
  };
}

  let currentObject =
    baseObject;

  for (
    let index = 0;
    index < parts.length - 1;
    index++
  ) {
    const relationshipName =
      parts[index];

    const relationships =
      relationshipMap.get(
        currentObject
      );

    const relationship =
      findRelationshipIgnoreCase(
        relationships,
        relationshipName
      );

    if (!relationship) {
      return undefined;
    }

    // For polymorphic lookups there can be
    // multiple referenceTo values. We will
    // handle those explicitly later.
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
      parts[parts.length - 1],
  };

  function findRelationshipIgnoreCase(
  relationships:
    | Map<string, any>
    | undefined,
  relationshipName: string
) {
  if (!relationships) {
    return undefined;
  }

  const normalized =
    relationshipName
      .trim()
      .toLowerCase();

  for (
    const [name, relationship] of
      relationships.entries()
  ) {
    if (
      name.toLowerCase() ===
      normalized
    ) {
      return relationship;
    }
  }

  return undefined;
}
}