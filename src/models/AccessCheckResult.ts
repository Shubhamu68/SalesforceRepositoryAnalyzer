import { PermissionSource } from "../analyzer/permissionAggregator.js";

import type { ObjectReadDecision } from "../services/OrgObjectReadVerificationService.js";
import type { ObjectPermissionEvidence } from "../services/OrgPermissionFallbackService.js";

export interface AccessCheckResult {
  readEvidence?: ObjectReadDecision;
  permissionEvidence?: ObjectPermissionEvidence;
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