import { PermissionSet } from "./PermissionSet.js";

export interface PermissionSetGroup {
  name: string;
  label: string;
  permissionSetNames: string[];
  permissionSets: PermissionSet[];
}