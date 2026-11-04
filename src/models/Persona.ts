export interface Persona {
  name: string;
  /** Optional Salesforce Profile metadata basename (not the persona display name). */
  profile?: string;
  permissionSetGroups: string[];
  permissionSets: string[];
  mutingPermissionSets: string[];
}

export interface PersonaConfig {
  personas: Persona[];
}