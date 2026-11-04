import { parsePermissionMetadata } from "./permissionMetadataParser.js";

export function parseMutingPermissionSet(filePath: string) {
  return parsePermissionMetadata(filePath, "MutingPermissionSet", ".mutingpermissionset-meta.xml");
}
