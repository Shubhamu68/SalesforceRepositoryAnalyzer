import path from "node:path";
import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import type { PermissionSet } from "../models/PermissionSet.js";
import type { ObjectPermission } from "../models/ObjectPermission.js";
import type { FieldPermission } from "../models/FieldPermission.js";

const parser = new XMLParser({ ignoreAttributes: true });
const records = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const enabled = (value: unknown): boolean => value === true || value === "true";

/** All three Salesforce Metadata API components use compatible permission sections. */
export async function parsePermissionMetadata(
  filePath: string,
  rootTag: "Profile" | "PermissionSet" | "MutingPermissionSet",
  suffix: string
): Promise<PermissionSet> {
  const xml = await readFile(filePath, "utf-8");
  const root = parser.parse(xml)?.[rootTag] as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object") {
    throw new Error(`Invalid ${rootTag} XML: ${filePath}`);
  }

  const objectPermissions = records(root.objectPermissions as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .map((entry): ObjectPermission => ({
      object: String(entry.object ?? ""),
      allowCreate: enabled(entry.allowCreate),
      allowRead: enabled(entry.allowRead),
      allowEdit: enabled(entry.allowEdit),
      allowDelete: enabled(entry.allowDelete),
      viewAllRecords: enabled(entry.viewAllRecords),
      modifyAllRecords: enabled(entry.modifyAllRecords),
      viewAllFields: enabled(entry.viewAllFields),
    })).filter((entry) => entry.object.length > 0);

  const fieldPermissions = records(root.fieldPermissions as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .map((entry): FieldPermission => ({
      field: String(entry.field ?? ""),
      readable: enabled(entry.readable),
      editable: enabled(entry.editable),
    })).filter((entry) => entry.field.length > 0);

  const userPermissions: Record<string, boolean> = {};
  for (const entry of records(root.userPermissions as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const name = String(entry.name ?? "").trim().toLowerCase();
    if (name) userPermissions[name] = enabled(entry.enabled);
  }

  return {
    name: path.basename(filePath).replace(suffix, ""),
    label: String(root.label ?? ""),
    objectPermissions,
    fieldPermissions,
    userPermissions,
  };
}
