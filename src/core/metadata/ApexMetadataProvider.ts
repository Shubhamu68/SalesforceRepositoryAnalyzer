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
export interface ApexMetadataProvider {
  /** Cache scope must include org identity and connection epoch when live. */
  readonly scopeKey: string;
  getObjectFieldNames(objectApiName: string): Promise<MetadataResult<string[]>>;
  /** Custom Label master value from the connected org; not a guessed local fixture. */
  getCustomLabelValue?(labelApiName: string): Promise<MetadataResult<string>>;
  /** For future record-driven loops; callers must supply proven filters. */
  getCustomMetadataRecords(
    objectApiName: string, fields: readonly string[],
  ): Promise<MetadataResult<Array<Record<string, unknown>>>>;
}
