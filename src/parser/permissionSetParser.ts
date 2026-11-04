import { parsePermissionMetadata } from "./permissionMetadataParser.js";

export function parsePermissionSet(filePath: string) {
  return parsePermissionMetadata(filePath, "PermissionSet", ".permissionset-meta.xml");
}
