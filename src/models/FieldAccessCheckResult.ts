import { PermissionSource } from "../analyzer/permissionAggregator.js";

export interface FieldAccessCheckResult {
  field: string;

  read: boolean;
  edit: boolean;

  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];

  mutedBy: string[];
}