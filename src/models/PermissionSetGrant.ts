import { PermissionSet } from "./PermissionSet.js";

export type PermissionGrantType =
  | "permissionSetGroup"
  | "directPermissionSet";

export interface PermissionSetGrant {
  permissionSet: PermissionSet;
  type: PermissionGrantType;
  permissionSetGroup?: string;
}