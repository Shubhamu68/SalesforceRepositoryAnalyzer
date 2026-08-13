import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: true,
});

interface RelationshipMetadata {
  relationshipName: string;
  sourceField: string;
  targetObjects: string[];
}

export type RelationshipMap =
  Map<string, Map<string, RelationshipMetadata>>;

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

    const objectName =
      objectEntry.name;

    const fieldsDirectory = path.join(
      objectsDirectory,
      objectName,
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

    const objectRelationships =
      new Map<
        string,
        RelationshipMetadata
      >();

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
        path
          .basename(
            fieldEntry.name,
            ".field-meta.xml"
          );

      objectRelationships.set(
        relationshipName,
        {
          relationshipName,
          sourceField,
          targetObjects: referenceTo,
        }
      );
    }

    relationshipMap.set(
      objectName,
      objectRelationships
    );
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
    const normalized = value.trim();

    return normalized
      ? [normalized]
      : [];
  }

  return [];
}