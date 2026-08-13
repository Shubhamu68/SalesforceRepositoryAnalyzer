import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";

import { FieldPermission } from "../models/FieldPermission.js";
import { ObjectPermission } from "../models/ObjectPermission.js";
import { PermissionSet } from "../models/PermissionSet.js";

const parser = new XMLParser({
  ignoreAttributes: true,
});

export async function parsePermissionSet(
  filePath: string
): Promise<PermissionSet> {
  const xml = await readFile(filePath, "utf-8");

  const parsed = parser.parse(xml);
  const permissionSet = parsed.PermissionSet;

  return {
    name: filePath.split(/[\\/]/).pop()?.replace(".permissionset-meta.xml", "") ?? "",
    label: permissionSet.label ?? "",
    objectPermissions: normalizeArray(
      permissionSet.objectPermissions
    ).map(parseObjectPermission),
    fieldPermissions: normalizeArray(
      permissionSet.fieldPermissions
    ).map(parseFieldPermission),
  };
}

function parseObjectPermission(
  permission: Record<string, unknown>
): ObjectPermission {
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
): FieldPermission {
  return {
    field: String(permission.field),
    readable: permission.readable === true,
    editable: permission.editable === true,
  };
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}