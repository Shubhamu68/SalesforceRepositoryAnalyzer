import { FieldPermission } from "./FieldPermission.js";
import { ObjectPermission } from "./ObjectPermission.js";

export interface PermissionSet {
  name: string;
  label: string;
  objectPermissions: ObjectPermission[];
  fieldPermissions: FieldPermission[];
}