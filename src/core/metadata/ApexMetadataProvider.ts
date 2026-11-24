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
export interface ApexMetadataProvider {
  /** Cache scope must include org identity and connection epoch when live. */
  readonly scopeKey: string;
  getObjectFieldNames(objectApiName: string): Promise<MetadataResult<string[]>>;
  /** Custom Label master value from the connected org; not a guessed local fixture. */
  getCustomLabelValue?(labelApiName: string): Promise<MetadataResult<string>>;
  /** Ordered SOQL-ready field paths from a uniquely identified Field Set. */
  getFieldSetFields?(objectApiName:string,fieldSetDeveloperName:string):Promise<MetadataResult<string[]>>;
  /** Complete matching records for proven equality filters; no partial results. */
  getCustomMetadataRecords(
    objectApiName: string, fields: readonly string[], filters?: readonly CustomMetadataFilter[],
  ): Promise<CustomMetadataResult>;
}
