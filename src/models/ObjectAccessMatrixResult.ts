import type { ObjectReadDecision } from "../services/OrgObjectReadVerificationService.js";
import type { ObjectPermissionEvidence } from "../services/OrgPermissionFallbackService.js";

import type { ObjectPermissionKey, ObjectPrivilegeAccess, ObjectPermissionSources } from "./ObjectPrivilegeAccess.js";
// Preserve the existing matrix/API names as aliases of the shared contract.
export { OBJECT_PERMISSION_KEYS as MATRIX_PERMISSION_KEYS } from "./ObjectPrivilegeAccess.js";
export type { ObjectPermissionKey as MatrixPermission, ObjectPrivilegeAccess as MatrixAccess,
  ObjectPermissionSources as MatrixPermissionSources, MutedPermissionSource } from "./ObjectPrivilegeAccess.js";
type MatrixPermission=ObjectPermissionKey;
type MatrixAccess=ObjectPrivilegeAccess;
type MatrixPermissionSources=ObjectPermissionSources;

export interface ObjectAccessMatrixPersona {
  readEvidence?: ObjectReadDecision;
  permissionEvidence?: ObjectPermissionEvidence;
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
