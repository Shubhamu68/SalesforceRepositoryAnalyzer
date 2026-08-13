import { PermissionSet } from "../models/PermissionSet.js";
import {
  aggregateObjectPermissions,
} from "./permissionAggregator.js";
import {
  aggregateFieldPermissions,
} from "./fieldPermissionAggregator.js";
import { EffectiveObjectAccess } from "../models/EffectiveObjectAccess.js";
import { PermissionSetGrant } from "../models/PermissionSetGrant.js";

interface EffectiveAccessInput {
  permissionSetGrants: PermissionSetGrant[];
  mutingPermissionSets: PermissionSet[];
}

export function buildEffectiveAccess(
  input: EffectiveAccessInput
): EffectiveObjectAccess[] {
  const objectPermissions =
    aggregateObjectPermissions(
      input.permissionSetGrants
    );

  const fieldPermissions =
    aggregateFieldPermissions(
      input.permissionSetGrants
    );

  const mutingGrants: PermissionSetGrant[] =
    input.mutingPermissionSets.map(
      (permissionSet) => ({
        permissionSet,
        type: "directPermissionSet",
      })
    );

  const mutedObjectPermissions =
    aggregateObjectPermissions(
      mutingGrants
    );

  const mutedFieldPermissions =
    aggregateFieldPermissions(
      mutingGrants
    );

  return objectPermissions.map(
    (objectPermission) => {
      const mutedObjectPermission =
        mutedObjectPermissions.find(
          (permission) =>
            permission.object === objectPermission.object
        );

      const fields =
        fieldPermissions.filter((field) =>
          field.field.startsWith(
            `${objectPermission.object}.`
          )
        );

      const mutedFields =
        mutedFieldPermissions.filter((field) =>
          field.field.startsWith(
            `${objectPermission.object}.`
          )
        );

      const mutedPermissionSetNames =
        input.mutingPermissionSets.map(
          (permissionSet) => permissionSet.name
        );

      return {
        object: objectPermission.object,

        read:
          objectPermission.allowRead &&
          !mutedObjectPermission?.allowRead,

        create:
          objectPermission.allowCreate &&
          !mutedObjectPermission?.allowCreate,

        edit:
          objectPermission.allowEdit &&
          !mutedObjectPermission?.allowEdit,

        delete:
          objectPermission.allowDelete &&
          !mutedObjectPermission?.allowDelete,

        viewAllRecords:
          objectPermission.viewAllRecords &&
          !mutedObjectPermission?.viewAllRecords,

        modifyAllRecords:
          objectPermission.modifyAllRecords &&
          !mutedObjectPermission?.modifyAllRecords,

        viewAllFields:
          objectPermission.viewAllFields &&
          !mutedObjectPermission?.viewAllFields,

        readGrantedBy:
          objectPermission.readGrantedBy,

        createGrantedBy:
          objectPermission.createGrantedBy,

        editGrantedBy:
          objectPermission.editGrantedBy,

        deleteGrantedBy:
          objectPermission.deleteGrantedBy,

        readMutedBy:
          mutedObjectPermission?.allowRead
            ? mutedPermissionSetNames
            : [],

        createMutedBy:
          mutedObjectPermission?.allowCreate
            ? mutedPermissionSetNames
            : [],

        editMutedBy:
          mutedObjectPermission?.allowEdit
            ? mutedPermissionSetNames
            : [],

        deleteMutedBy:
          mutedObjectPermission?.allowDelete
            ? mutedPermissionSetNames
            : [],

        fields: fields.map((field) => {
          const mutedField =
            mutedFields.find(
              (permission) =>
                permission.field === field.field
            );

          return {
            ...field,

            readable:
              field.readable &&
              !mutedField?.readable,

            editable:
              field.editable &&
              !mutedField?.editable,

            mutedBy:
              mutedField?.readable || mutedField?.editable
                ? input.mutingPermissionSets.map(
                    (permissionSet) => permissionSet.name
                  )
                : [],
          };
        }),
      };
    }
  );
}