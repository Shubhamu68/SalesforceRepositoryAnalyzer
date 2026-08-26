import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: true,
});

export interface RelationshipMetadata {
  relationshipName: string;
  sourceField: string;

  // The object on which the lookup/master-detail
  // field actually exists.
  childObject: string;

  // The parent object(s) referenced by the field.
  targetObjects: string[];
}

/*
 * Parent Object
 *   ->
 * Child Relationship Name
 *   ->
 * Relationship Metadata
 *
 * Example metadata on Contact:
 *
 * <referenceTo>Client_Customer__c</referenceTo>
 * <relationshipName>Contacts</relationshipName>
 *
 * Produces:
 *
 * Client_Customer__c
 *   ->
 * Contacts
 *   ->
 * {
 *   relationshipName: "Contacts",
 *   sourceField: "Client_Customer__c",
 *   childObject: "Contact",
 *   targetObjects: ["Client_Customer__c"]
 * }
 */
export type RelationshipMap =
  Map<
    string,
    Map<string, RelationshipMetadata>
  >;

export async function buildRelationshipMap(
  objectsDirectory: string
): Promise<RelationshipMap> {
  const relationshipMap: RelationshipMap =
    new Map();

  const objectEntries = await readdir(
    objectsDirectory,
    { withFileTypes: true }
  );

  for (const objectEntry of objectEntries) {
    if (!objectEntry.isDirectory()) {
      continue;
    }

    const childObject =
      objectEntry.name;

    const fieldsDirectory = path.join(
      objectsDirectory,
      childObject,
      "fields"
    );

    let fieldEntries;

    try {
      fieldEntries = await readdir(
        fieldsDirectory,
        { withFileTypes: true }
      );
    } catch {
      continue;
    }

    for (const fieldEntry of fieldEntries) {
      if (
        !fieldEntry.isFile() ||
        !fieldEntry.name.endsWith(
          ".field-meta.xml"
        )
      ) {
        continue;
      }

      const fieldPath = path.join(
        fieldsDirectory,
        fieldEntry.name
      );

      const xml = await readFile(
        fieldPath,
        "utf-8"
      );

      const parsed =
        parser.parse(xml);

      const field =
        parsed.CustomField;

      if (!field) {
        continue;
      }

      const relationshipName =
        normalizeString(
          field.relationshipName
        );

      if (!relationshipName) {
        continue;
      }

      const referenceTo =
        normalizeStringArray(
          field.referenceTo
        );

      if (referenceTo.length === 0) {
        continue;
      }

      const sourceField =
        path.basename(
          fieldEntry.name,
          ".field-meta.xml"
        );

      /*
       * The field exists on childObject.
       *
       * Example:
       *
       * Contact.Client_Customer__c
       *   referenceTo       = Client_Customer__c
       *   relationshipName = Contacts
       *
       * Therefore a nested query from
       * Client_Customer__c using FROM Contacts
       * resolves to Contact.
       *
       * So the map must be built in this direction:
       *
       * Parent Object + Relationship Name
       *   -> Child Object
       */
      for (const parentObject of referenceTo) {
        if (
          !relationshipMap.has(
            parentObject
          )
        ) {
          relationshipMap.set(
            parentObject,
            new Map()
          );
        }

        const parentRelationships =
          relationshipMap.get(
            parentObject
          )!;

        parentRelationships.set(
          relationshipName,
          {
            relationshipName,
            sourceField,
            childObject,
            targetObjects: referenceTo,
          }
        );
      }
    }
  }

  return relationshipMap;
}

function normalizeString(
  value: unknown
): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    return undefined;
  }

  return value.trim();
}

function normalizeStringArray(
  value: unknown
): string[] {
  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is string =>
          typeof item === "string"
      )
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const normalized =
      value.trim();

    return normalized
      ? [normalized]
      : [];
  }

  return [];
}