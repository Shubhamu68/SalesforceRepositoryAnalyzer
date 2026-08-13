import { Persona } from "../models/Persona.js";
import { PersonaAccessService } from "./PersonaAccessService.js";
import { PersonaFieldAccessService } from "./PersonaFieldAccessService.js";

export class AccessQueryService {
  constructor(
    private readonly personaAccessService: PersonaAccessService,
    private readonly personaFieldAccessService: PersonaFieldAccessService
  ) {}

  async checkObject(
    persona: Persona,
    objectName: string
  ) {
    return this.personaAccessService.getObjectAccess(
      persona,
      objectName
    );
  }

  async checkField(
    persona: Persona,
    objectName: string,
    fieldName: string
  ) {
    return this.personaFieldAccessService.getFieldAccess(
      persona,
      objectName,
      fieldName
    );
  }
}