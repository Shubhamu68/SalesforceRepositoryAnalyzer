import { readFile } from "node:fs/promises";
import path from "node:path";
import { Persona, PersonaConfig } from "../models/Persona.js";

export class PersonaConfigLoader {
  private readonly configPath: string;
  private config: PersonaConfig | null = null;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  async load(): Promise<PersonaConfig> {
    if (this.config) {
      return this.config;
    }

    const fileContent = await readFile(
      this.configPath,
      "utf-8"
    );

    let parsed: unknown;

    try {
      parsed = JSON.parse(fileContent);
    } catch {
      throw new Error(
        `Invalid JSON in persona configuration: ${this.configPath}`
      );
    }

    this.validate(parsed);

    this.config = parsed as PersonaConfig;

    return this.config;
  }

  async getPersona(
    personaName: string
  ): Promise<Persona> {
    const config = await this.load();

    const persona = config.personas.find(
      (item) =>
        item.name.toLowerCase() ===
        personaName.toLowerCase()
    );

    if (!persona) {
      throw new Error(
        `Persona not found: ${personaName}`
      );
    }

    return persona;
  }

  async getAllPersonas(): Promise<Persona[]> {
    const config = await this.load();

    return config.personas;
  }

  private validate(data: unknown): void {
    if (
      typeof data !== "object" ||
      data === null ||
      !("personas" in data)
    ) {
      throw new Error(
        "Persona configuration must contain a 'personas' array."
      );
    }

    const config = data as {
      personas?: unknown;
    };

    if (!Array.isArray(config.personas)) {
      throw new Error(
        "'personas' must be an array."
      );
    }

    for (const persona of config.personas) {
      if (
        typeof persona !== "object" ||
        persona === null
      ) {
        throw new Error(
          "Each persona must be an object."
        );
      }

      const item = persona as Record<string, unknown>;

      if (
        typeof item.name !== "string" ||
        item.name.trim() === ""
      ) {
        throw new Error(
          "Each persona must have a non-empty 'name'."
        );
      }

      this.validateStringArray(
        item.permissionSetGroups,
        "permissionSetGroups",
        item.name
      );

      this.validateStringArray(
        item.permissionSets,
        "permissionSets",
        item.name
      );

      this.validateStringArray(
        item.mutingPermissionSets,
        "mutingPermissionSets",
        item.name
      );
    }
  }

  private validateStringArray(
    value: unknown,
    propertyName: string,
    personaName: string
  ): void {
    if (!Array.isArray(value)) {
      throw new Error(
        `Persona '${personaName}' must have '${propertyName}' as an array.`
      );
    }

    for (const item of value) {
      if (typeof item !== "string") {
        throw new Error(
          `Persona '${personaName}' contains a non-string value in '${propertyName}'.`
        );
      }
    }
  }
}