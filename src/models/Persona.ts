export interface Persona {
  name: string;
  permissionSetGroups: string[];
  permissionSets: string[];
  mutingPermissionSets: string[];
}

export interface PersonaConfig {
  personas: Persona[];
}