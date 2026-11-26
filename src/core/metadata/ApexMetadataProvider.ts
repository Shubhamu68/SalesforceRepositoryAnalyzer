/**
 * Read-only metadata boundary shared by Apex analyses.
 * Providers must prove completeness, never interpret absent records as grants.
 */
export interface MetadataResult<T> {
  complete: boolean;
  value?: T;
  reason?: string;
  source: "LIVE_ORG" | "REPOSITORY";
}
/** A proven equality filter, with its original scalar type preserved. */
export interface CustomMetadataFilter {
  readonly field:string;
  readonly value:string|number|boolean;
}
/** Only set this proof when the provider executed the exact requested WHERE
 * predicates and returned every matching row. Salesforce owns filter semantics. */
export interface CustomMetadataResult extends MetadataResult<Array<Record<string,unknown>>> {
  filterEvidence?: "SERVER_FILTERED";
}
/** Org schema facts, not the permissions of the persona being analyzed.
 * An absent optional property is unknown, never a negative assertion. */
export interface ApexSchemaField {
  name:string;
  type?:string;
  relationshipName?:string|null;
  referenceTo?:readonly string[];
  nameField?:boolean;
}
export interface ApexObjectSchema {
  name:string;
  fields:readonly ApexSchemaField[];
}
export interface FieldSetIdentity {
  readonly objectApiName:string;
  readonly fieldSetDeveloperName:string;
}
/** Exact spelling is preserved; full name is unambiguous for validated API names. */
export const fieldSetIdentityKey=(identity:FieldSetIdentity):string=>
  identity.objectApiName+"."+identity.fieldSetDeveloperName;

/** Exact typed filter context; a bulk provider may combine projections,
 * but must not broaden the predicates or locally approximate SOQL semantics. */
export interface CustomMetadataRead {
  readonly key:string;
  readonly type:string;
  readonly selected:readonly string[];
  readonly filters:readonly CustomMetadataFilter[];
}
export interface ApexMetadataProvider {
  /** Cache scope must include org identity and connection epoch when live. */
  readonly scopeKey: string;
  getObjectFieldNames(objectApiName: string): Promise<MetadataResult<string[]>>;
  /** Optional richer projection of the same authoritative Describe response. */
  getObjectSchema?(objectApiName:string):Promise<MetadataResult<ApexObjectSchema>>;
  /** Custom Label master value from the connected org; not a guessed local fixture. */
  getCustomLabelValue?(labelApiName: string): Promise<MetadataResult<string>>;
  /** Optional bulk reads return only complete, individually identified results.
   * Missing keys must fall back to the existing exact lookup. */
  getCustomLabelValues?(names:readonly string[]):Promise<ReadonlyMap<string,MetadataResult<string>>>;
  /** Ordered SOQL-ready field paths from a uniquely identified Field Set. */
  getFieldSetFields?(objectApiName:string,fieldSetDeveloperName:string):Promise<MetadataResult<string[]>>;
  getFieldSetFieldsBatch?(identities:readonly FieldSetIdentity[]):Promise<ReadonlyMap<string,MetadataResult<string[]>>>;
  /** Optional bulk read. Return individually complete, exact server-filtered results only. */
  getCustomMetadataRecordsBatch?(requests:readonly CustomMetadataRead[]):Promise<ReadonlyMap<string,CustomMetadataResult>>;
  /** Complete matching records for proven equality filters; no partial results. */
  getCustomMetadataRecords(
    objectApiName: string, fields: readonly string[], filters?: readonly CustomMetadataFilter[],
  ): Promise<CustomMetadataResult>;
}
