import { PermissionSource } from "../analyzer/permissionAggregator.js";

export interface AccessCheckResult {
  object: string;

  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;

  viewAllRecords: boolean;
  modifyAllRecords: boolean;
  viewAllFields: boolean;

  readGrantedBy: PermissionSource[];
  createGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];
  deleteGrantedBy: PermissionSource[];

  readMutedBy: string[];
  createMutedBy: string[];
  editMutedBy: string[];
  deleteMutedBy: string[];
}