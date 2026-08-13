import { ObjectPermission } from "../models/ObjectPermission.js";
import { PermissionSetGrant } from "../models/PermissionSetGrant.js";

export interface PermissionSource {
  permissionSet: string;
  type: "permissionSetGroup" | "directPermissionSet";
  permissionSetGroup?: string;
}

export interface EffectiveObjectPermission {
  object: string;

  allowCreate: boolean;
  allowRead: boolean;
  allowEdit: boolean;
  allowDelete: boolean;

  viewAllRecords: boolean;
  modifyAllRecords: boolean;
  viewAllFields: boolean;

  createGrantedBy: PermissionSource[];
  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];
  deleteGrantedBy: PermissionSource[];
}

export function aggregateObjectPermissions(
  grants: PermissionSetGrant[]
): EffectiveObjectPermission[] {
  const permissionsByObject = new Map<
    string,
    EffectiveObjectPermission
  >();

  for (const grant of grants) {
    for (const permission of grant.permissionSet.objectPermissions) {
      const existing = permissionsByObject.get(permission.object);

      const source: PermissionSource = {
        permissionSet: grant.permissionSet.name,
        type: grant.type,
        permissionSetGroup: grant.permissionSetGroup,
      };

      if (!existing) {
        permissionsByObject.set(
          permission.object,
          createEffectivePermission(permission, source)
        );

        continue;
      }

      mergePermission(existing, permission, source);
    }
  }

  return Array.from(permissionsByObject.values()).sort((a, b) =>
    a.object.localeCompare(b.object)
  );
}

function createEffectivePermission(
  permission: ObjectPermission,
  source: PermissionSource
): EffectiveObjectPermission {
  return {
    object: permission.object,

    allowCreate: permission.allowCreate,
    allowRead: permission.allowRead,
    allowEdit: permission.allowEdit,
    allowDelete: permission.allowDelete,

    viewAllRecords: permission.viewAllRecords,
    modifyAllRecords: permission.modifyAllRecords,
    viewAllFields: permission.viewAllFields,

    createGrantedBy: permission.allowCreate ? [source] : [],
    readGrantedBy: permission.allowRead ? [source] : [],
    editGrantedBy: permission.allowEdit ? [source] : [],
    deleteGrantedBy: permission.allowDelete ? [source] : [],
  };
}

function mergePermission(
  existing: EffectiveObjectPermission,
  incoming: ObjectPermission,
  source: PermissionSource
): void {
  if (incoming.allowCreate) {
    existing.allowCreate = true;
    existing.createGrantedBy.push(source);
  }

  if (incoming.allowRead) {
    existing.allowRead = true;
    existing.readGrantedBy.push(source);
  }

  if (incoming.allowEdit) {
    existing.allowEdit = true;
    existing.editGrantedBy.push(source);
  }

  if (incoming.allowDelete) {
    existing.allowDelete = true;
    existing.deleteGrantedBy.push(source);
  }

  existing.viewAllRecords ||= incoming.viewAllRecords;
  existing.modifyAllRecords ||= incoming.modifyAllRecords;
  existing.viewAllFields ||= incoming.viewAllFields;
}