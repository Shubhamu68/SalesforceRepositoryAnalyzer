import { PermissionSet } from "./PermissionSet.js";

export type PermissionGrantType =
  | "permissionSetGroup"
  | "directPermissionSet"
  | "profile";

export interface PermissionSetGrant {
  permissionSet: PermissionSet;
  type: PermissionGrantType;
  permissionSetGroup?: string;
}