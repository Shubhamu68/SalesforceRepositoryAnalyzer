import { FieldPermission } from "../models/FieldPermission.js";
import { PermissionSetGrant } from "../models/PermissionSetGrant.js";
import { PermissionSource } from "./permissionAggregator.js";

export interface EffectiveFieldPermission {
  field: string;

  readable: boolean;
  editable: boolean;
  /** Salesforce EntityParticle.IsPermissionable; undefined if not in snapshot. */
  permissionable?: boolean;
  /** CustomField.required from the repository field-definition XML. */
  schemaRequired?: boolean;

  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];

  mutedBy: string[];
}

export function aggregateFieldPermissions(
  grants: PermissionSetGrant[]
): EffectiveFieldPermission[] {
  const permissionsByField = new Map<
    string,
    EffectiveFieldPermission
  >();

  for (const grant of grants) {
    for (const permission of grant.permissionSet.fieldPermissions) {
      const source: PermissionSource = {
        permissionSet: grant.permissionSet.name,
        type: grant.type,
        permissionSetGroup: grant.permissionSetGroup,
      };

      const existing = permissionsByField.get(permission.field);

      if (!existing) {
        permissionsByField.set(permission.field, {
          field: permission.field,
          readable: permission.readable,
          editable: permission.editable,

          readGrantedBy: permission.readable ? [source] : [],
          editGrantedBy: permission.editable ? [source] : [],

          mutedBy: [],
        });

        continue;
      }

      if (permission.readable) {
        existing.readable = true;
        existing.readGrantedBy.push(source);
      }

      if (permission.editable) {
        existing.editable = true;
        existing.editGrantedBy.push(source);
      }
    }
  }

  return Array.from(permissionsByField.values()).sort((a, b) =>
    a.field.localeCompare(b.field)
  );
}