import type { Profile } from "../models/Profile.js";
import { parsePermissionMetadata } from "./permissionMetadataParser.js";

export async function parseProfile(filePath: string): Promise<Profile> {
  return parsePermissionMetadata(filePath, "Profile", ".profile-meta.xml");
}
