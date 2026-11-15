import { PermissionSource } from "../analyzer/permissionAggregator.js";

import type { ObjectReadDecision } from "../services/OrgObjectReadVerificationService.js";
import type { FieldPermissionEvidence } from "../services/OrgPermissionFallbackService.js";
import type { OrgObjectAccessEvidence } from "../salesforce/SalesforcePersonaAccessVerifier.js";
export interface FieldAccessCheckResult {
  permissionEvidence?: FieldPermissionEvidence;
  objectReadEvidence?: ObjectReadDecision;
  fieldReadEvidence?: OrgObjectAccessEvidence;
  field: string;

  read: boolean;
  edit: boolean;
  permissionable?: boolean;
  schemaRequired?: boolean;

  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];

  mutedBy: string[];
}