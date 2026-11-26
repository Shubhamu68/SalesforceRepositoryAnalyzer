import type { PermissionSource } from "../analyzer/permissionAggregator.js";

/** Shared object privileges used by repository and org effective access,
 * independent of feature result/report models. */
export const OBJECT_PERMISSION_KEYS = [
  "read",
  "create",
  "edit",
  "delete",
  "viewAllRecords",
  "modifyAllRecords",
  "viewAllFields",
] as const;

export type ObjectPermissionKey = (typeof OBJECT_PERMISSION_KEYS)[number];

export type ObjectPrivilegeAccess = Record<ObjectPermissionKey, boolean>;

export interface MutedPermissionSource {
  permissionSetGroup: string;
  mutingPermissionSet: string;
  /** Granting permission sets suppressed by this group's mute. */
  affectedPermissionSets: string[];
}

export interface ObjectPermissionSources {
  /** Effective contributing permission sets, AFTER group-scoped muting. */
  grantedBy: PermissionSource[];
  /** Relevant group-scoped mutes, even if other grants restore access. */
  mutedBy: MutedPermissionSource[];
}

