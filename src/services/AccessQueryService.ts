import { assertDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
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
    assertDataAccessAnalysisObject(objectName);
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
    assertDataAccessAnalysisObject(objectName);
    return this.personaFieldAccessService.getFieldAccess(
      persona,
      objectName,
      fieldName
    );
  }
}