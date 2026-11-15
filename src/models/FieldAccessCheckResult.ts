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
  /** FLS isn't applicable to Platform Event fields; UI displays N/A. */
  flsApplicable?: boolean;
  flsReason?: string;
  schemaRequired?: boolean;

  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];

  mutedBy: string[];
}