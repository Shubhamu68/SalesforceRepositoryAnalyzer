import type { PermissionSource } from "../analyzer/permissionAggregator.js";

export const MATRIX_PERMISSION_KEYS = [
  "read",
  "create",
  "edit",
  "delete",
  "viewAllRecords",
  "modifyAllRecords",
  "viewAllFields",
] as const;

export type MatrixPermission = (typeof MATRIX_PERMISSION_KEYS)[number];

export type MatrixAccess = Record<MatrixPermission, boolean>;

export interface MutedPermissionSource {
  permissionSetGroup: string;
  mutingPermissionSet: string;
  /** Granting permission sets suppressed by this group's mute. */
  affectedPermissionSets: string[];
}

export interface MatrixPermissionSources {
  /** Effective contributing permission sets, AFTER group-scoped muting. */
  grantedBy: PermissionSource[];
  /** Relevant group-scoped mutes, even if other grants restore access. */
  mutedBy: MutedPermissionSource[];
}

export interface ObjectAccessMatrixPersona {
  personaName: string;
  access: MatrixAccess;
  sources: Record<MatrixPermission, MatrixPermissionSources>;
  warnings: string[];
}

export interface ObjectAccessMatrixResult {
  object: string;
  personas: ObjectAccessMatrixPersona[];
  totalPersonas: number;
  personasWithRead: number;
  warnings: string[];
}
