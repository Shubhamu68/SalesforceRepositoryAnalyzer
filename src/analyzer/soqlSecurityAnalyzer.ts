import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { Persona } from "../models/Persona.js";
import { PersonaPermissionResolver } from "./PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "./personaAccessEvaluator.js";
import {
  buildRelationshipMap,
} from "./salesforceRelationshipResolver.js";
import {
  buildSoqlFieldInventory,
} from "./soqlFieldInventoryBuilder.js";

export class SoqlSecurityAnalyzer {
  constructor(
    private readonly personaPermissionResolver:
      PersonaPermissionResolver,
    private readonly objectsDirectory: string
  ) {}

  async analyze(
    persona: Persona,
    queries: SoqlQuery[]
  ): Promise<SoqlSecurityFinding[]> {
    // --------------------------------------------------
    // 1. Resolve persona once
    // --------------------------------------------------

    const resolved =
      await this.personaPermissionResolver.resolve(
        persona
      );

    // --------------------------------------------------
    // 2. Use the same centralized access evaluator as the matrix and stack trace.
    // --------------------------------------------------
    const evaluator = createPersonaAccessEvaluator(resolved);
    const knownObjects = new Set(evaluator.knownObjects().map((name) => name.toLowerCase()));

    // --------------------------------------------------
    // 3. Build relationship metadata once
    // --------------------------------------------------

    const relationshipMap =
      await buildRelationshipMap(
        this.objectsDirectory
      );

    // --------------------------------------------------
    // 4. Build normalized SOQL inventory
    // --------------------------------------------------

    const inventory =
      buildSoqlFieldInventory(
        queries,
        relationshipMap
      );

    // --------------------------------------------------
    // 6. Check unique object/field combinations
    // --------------------------------------------------

    const findings: SoqlSecurityFinding[] = [];

    for (
      const [
        objectName,
        fields,
      ] of inventory
    ) {
      const objectKey =
        objectName
          .trim()
          .toLowerCase();

      const objectAccess = evaluator.evaluateObject(objectName).access;

      for (
        const [
          fieldName,
          references,
        ] of fields
      ) {
        const fieldKey =
          `${objectName}.${fieldName}`
            .trim()
            .toLowerCase();

        // --------------------------------------------
        // No object permission information
        // --------------------------------------------

        if (!objectAccess.read && !knownObjects.has(objectKey)) {
          for (const reference of references) {
            findings.push({
              severity: "REVIEW",

              filePath:
                reference.filePath,

              lineNumber:
                reference.lineNumber,

              object:
                reference.object,

              field:
                reference.field,

              query:
                findOriginalQuery(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              withUserMode:
                findSecurityMode(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              reason:
                `Could not establish effective object ` +
                `access for ${objectName}. ` +
                `Manual review required.`,
            });
          }

          continue;
        }

        // --------------------------------------------
        // Object itself is not readable
        // --------------------------------------------

        if (!objectAccess.read) {
          for (
            const reference of references
          ) {
            findings.push({
              severity: "ERROR",

              filePath:
                reference.filePath,

              lineNumber:
                reference.lineNumber,

              object:
                reference.object,

              field:
                reference.field,

              query:
                findOriginalQuery(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              withUserMode:
                findSecurityMode(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              reason:
                `Persona "${persona.name}" does not ` +
                `have READ access to object ` +
                `${objectName}.`,
            });
          }

          continue;
        }

        // --------------------------------------------
        // View All Fields means field-level read
        // is effectively available.
        // --------------------------------------------

        if (
          objectAccess.viewAllFields
        ) {
          continue;
        }

        // --------------------------------------------
        // Look for explicit field FLS.
        //
        // Missing entry means no READ grant.
        // It is NOT an unresolved field.
        // --------------------------------------------

        const fieldRead = evaluator.evaluateField(fieldKey).readable;

        if (!fieldRead) {
          for (
            const reference of references
          ) {
            findings.push({
              severity: "ERROR",

              filePath:
                reference.filePath,

              lineNumber:
                reference.lineNumber,

              object:
                reference.object,

              field:
                reference.field,

              query:
                findOriginalQuery(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              withUserMode:
                findSecurityMode(
                  queries,
                  reference.filePath,
                  reference.lineNumber
                ),

              reason:
                `Persona "${persona.name}" does not ` +
                `have READ access to ` +
                `${reference.object}.${reference.field}.`,
            });
          }
        }
      }
    }

    return findings;
  }
}

function findOriginalQuery(
  queries: SoqlQuery[],
  filePath: string,
  lineNumber: number
): string {
  return (
    queries.find(
      (query) =>
        query.filePath === filePath &&
        query.lineNumber === lineNumber
    )?.query ?? ""
  );
}

function findSecurityMode(
  queries: SoqlQuery[],
  filePath: string,
  lineNumber: number
): boolean {
  return (
    queries.find(
      (query) =>
        query.filePath === filePath &&
        query.lineNumber === lineNumber
    )?.withUserMode ?? false
  );
}