import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PermissionSet } from "../models/PermissionSet.js";
import { PermissionSetGroup } from "../models/PermissionSetGroup.js";
import { parsePermissionSet } from "./permissionSetParser.js";

const parser = new XMLParser({
  ignoreAttributes: true,
});

export async function parsePermissionSetGroup(
  groupFilePath: string,
  permissionSetsDirectory: string
): Promise<PermissionSetGroup> {
  const xml = await readFile(groupFilePath, "utf-8");

  const parsed = parser.parse(xml);
  const group = parsed.PermissionSetGroup;

  const permissionSetNames = normalizeArray(
    group.permissionSets
  ).map(String);

  const mutingPermissionSetNames = normalizeArray(
    group.mutingPermissionSets
  ).map(String);

  const permissionSets: PermissionSet[] = [];

  for (const permissionSetName of permissionSetNames) {
    const permissionSetFilePath = path.join(
      permissionSetsDirectory,
      `${permissionSetName}.permissionset-meta.xml`
    );

    try {
      const permissionSet = await parsePermissionSet(
        permissionSetFilePath
      );

      permissionSets.push(permissionSet);
    } catch {
      console.warn(
        `Could not find or parse Permission Set: ${permissionSetName}`
      );
    }
  }

  return {
    name:
      path
        .basename(groupFilePath)
        .replace(".permissionsetgroup-meta.xml", ""),
    label: group.label ?? "",
    permissionSetNames,
    mutingPermissionSetNames,
    permissionSets,
  };
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}