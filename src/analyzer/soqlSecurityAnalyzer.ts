import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { Persona } from "../models/Persona.js";
import { PersonaPermissionResolver } from "./PersonaPermissionResolver.js";
import { buildEffectiveAccess } from "./effectiveAccessAnalyzer.js";
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
    // 2. Build effective permissions once
    // --------------------------------------------------

    const effectiveAccess =
      buildEffectiveAccess({
        permissionSetGrants:
          resolved.permissionSetGrants,

        mutingPermissionSets:
          resolved.mutingPermissionSets,
      });

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
    // 5. Build object + field access maps
    // --------------------------------------------------

    const objectAccessMap = new Map<
      string,
      {
        read: boolean;
        viewAllFields: boolean;
      }
    >();

    const fieldAccessMap = new Map<
      string,
      boolean
    >();

    for (
      const objectAccess of effectiveAccess
    ) {
      const objectKey =
        objectAccess.object
          .trim()
          .toLowerCase();

      objectAccessMap.set(
        objectKey,
        {
          read: objectAccess.read,
          viewAllFields:
            objectAccess.viewAllFields,
        }
      );

      for (
        const field of objectAccess.fields
      ) {
        fieldAccessMap.set(
          field.field
            .trim()
            .toLowerCase(),
          field.readable
        );
      }
    }

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

      const objectAccess =
        objectAccessMap.get(
          objectKey
        );

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

        if (!objectAccess) {
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

        const fieldRead =
          fieldAccessMap.get(
            fieldKey
          ) ?? false;

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