import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PermissionSet } from "../models/PermissionSet.js";

const parser = new XMLParser({
  ignoreAttributes: true,
});

export async function parseMutingPermissionSet(
  filePath: string
): Promise<PermissionSet> {
  const xml = await readFile(filePath, "utf-8");

  const parsed = parser.parse(xml);

  const mutingPermissionSet =
    parsed.MutingPermissionSet;

  return {
    name:
      path
        .basename(filePath)
        .replace(".mutingpermissionset-meta.xml", ""),
    label: mutingPermissionSet.label ?? "",
    objectPermissions: normalizeArray(
      mutingPermissionSet.objectPermissions
    ).map(parseObjectPermission),
    fieldPermissions: normalizeArray(
      mutingPermissionSet.fieldPermissions
    ).map(parseFieldPermission),
  };
}

function parseObjectPermission(
  permission: Record<string, unknown>
) {
  return {
    object: String(permission.object),
    allowCreate: permission.allowCreate === true,
    allowRead: permission.allowRead === true,
    allowEdit: permission.allowEdit === true,
    allowDelete: permission.allowDelete === true,
    viewAllRecords: permission.viewAllRecords === true,
    modifyAllRecords: permission.modifyAllRecords === true,
    viewAllFields: permission.viewAllFields === true,
  };
}

function parseFieldPermission(
  permission: Record<string, unknown>
) {
  return {
    field: String(permission.field),
    readable: permission.readable === true,
    editable: permission.editable === true,
  };
}

function normalizeArray<T>(
  value: T | T[] | undefined
): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}