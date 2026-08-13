export interface ObjectPermission {
  object: string;
  allowCreate: boolean;
  allowRead: boolean;
  allowEdit: boolean;
  allowDelete: boolean;
  viewAllRecords: boolean;
  modifyAllRecords: boolean;
  viewAllFields: boolean;
}