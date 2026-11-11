import type { SoqlQuery } from "../models/SoqlQuery.js";
import type { SoqlSecurityFinding, SoqlFindingCriticality, SoqlVerificationSource } from "../models/SoqlSecurityFinding.js";
import type { Persona } from "../models/Persona.js";
import { PersonaPermissionResolver } from "./PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "./personaAccessEvaluator.js";
import type { OrgObjectReadVerificationService, ReadDecisionSource } from "../services/OrgObjectReadVerificationService.js";
import { buildRelationshipMap } from "./salesforceRelationshipResolver.js";
import { buildSoqlFieldInventory, type UnresolvedSoqlField } from "./soqlFieldInventoryBuilder.js";
import { collectQueryFields } from "./soqlQueryFieldResolver.js";
import type { SalesforceRelationshipMetadataService } from "../salesforce/SalesforceRelationshipMetadataService.js";
import type { SoqlFieldReference } from "../models/SoqlFieldInventory.js";
import { ApexExecutionSecurityModeResolver } from "../services/ApexExecutionSecurityModeResolver.js";
import { runtimeImpactForFinding, type SoqlExecutionMode } from "./soqlExecutionMode.js";

/** Prevent hundreds of simultaneous Salesforce requests on large repositories. */
const CONCURRENCY = 4;
const OBJECT_READ_FIELD = "(Object Read Missing)";

type Decision = { source: ReadDecisionSource; message: string; readable: boolean };

/**
 * Severity describes SOQL enforcement, while verificationSource retains the
 * actual Salesforce permission decision. A system-mode query may still expose
 * data: Low is an advisory, not proof of safe application behavior.
 */
export function findingOutcome(source: ReadDecisionSource, execution?: SoqlExecutionMode): {
  severity: SoqlSecurityFinding["severity"];
  criticality: SoqlFindingCriticality;
  verificationSource: SoqlVerificationSource;
} {
  if (source === "ORG_VERIFIED") return {
    severity: "INFO", criticality: "Low", verificationSource: "ORG_VERIFIED",
  };
  if (source === "ORG_DENIED") {
    const enforcesUserRead = execution?.enforcement === "FULL" || execution?.enforcement === "SELECT_ONLY";
    return {
      severity: enforcesUserRead ? "ERROR" : "INFO",
      criticality: enforcesUserRead ? "High" : "Low",
      verificationSource: "ORG_DENIED",
    };
  }
  return { severity: "REVIEW", criticality: "Unable to verify", verificationSource: "UNVERIFIED" };
}

/** Maximum four independent checks at a time, with deterministic report order. */
async function boundedMap<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await task(current);
    }
  });
  await Promise.all(workers);
}

export class SoqlSecurityAnalyzer {
  constructor(
    private readonly personaPermissionResolver: PersonaPermissionResolver,
    private readonly objectsDirectory: string,
    private readonly readVerification?: OrgObjectReadVerificationService,
    private readonly executionModeResolver = new ApexExecutionSecurityModeResolver(),
    private readonly orgRelationshipMetadata?: SalesforceRelationshipMetadataService,
  ) {}

  async analyze(persona: Persona, queries: SoqlQuery[]): Promise<SoqlSecurityFinding[]> {
    const resolved = await this.personaPermissionResolver.resolve(persona);
    const evaluator = createPersonaAccessEvaluator(resolved);
    const relationshipMap = await buildRelationshipMap(this.objectsDirectory);
    // The same scoped collector and Describe hydrator are used by Stack Trace.
    // Only queries with unresolved paths trigger optional Salesforce Describe.
    if (this.orgRelationshipMetadata) {
      const hydrator = this.orgRelationshipMetadata.createHydrator(relationshipMap);
      await boundedMap(queries, async (query) => {
        const firstPass = collectQueryFields(query, relationshipMap);
        if (firstPass.unresolved.length) {
          await hydrator.hydrateQuery(query, firstPass.unresolved);
        }
      });
    }
    const unresolvedFields: UnresolvedSoqlField[] = [];
    const inventory = buildSoqlFieldInventory(queries, relationshipMap, (entry) => unresolvedFields.push(entry));
    this.executionModeResolver.clearCache();
    // Version lookup is cached per class, so hundreds of queries do not trigger
    // hundreds of metadata reads. The same resolver serves Stack Trace analysis.
    const modeResults = await Promise.all(queries.map((query) =>
      this.executionModeResolver.resolve(query.query, query.filePath)
    ));
    const queryByLocation = new Map<string, { query: SoqlQuery; execution: SoqlExecutionMode }>(queries.map((query, index) => [
      `${query.filePath}|${query.lineNumber}`, { query, execution: modeResults[index] },
    ]));
    const findings: SoqlSecurityFinding[] = [];

    function queryInfo(filePath: string, lineNumber: number) {
      const data = queryByLocation.get(`${filePath}|${lineNumber}`);
      return {
        query: data?.query.query ?? "",
        withUserMode: data?.query.withUserMode ?? false,
        ...(data?.execution.apiVersion !== undefined ? { apiVersion: data.execution.apiVersion } : {}),
        declaredMode: data?.execution.declaredMode ?? "UNSPECIFIED",
        effectiveMode: data?.execution.effectiveMode ?? "UNKNOWN",
      };
    }

    function findingFor(
      refs: readonly SoqlFieldReference[],
      object: string,
      field: string,
      type: "OBJECT_READ" | "FIELD_READ",
      decision: Decision,
    ): SoqlSecurityFinding[] {
      const subject = type === "OBJECT_READ" ? `Object ${object}` : `Field ${object}.${field}`;
      const detail = decision.source === "ORG_VERIFIED"
        ? `${subject}: Read permission wasn't established in repository metadata, but Salesforce confirmed access.`
        : decision.source === "ORG_DENIED"
          ? `${subject}: Repository metadata did not establish Read access; Salesforce confirmed it is missing for the selected user.`
          : `${subject}: Read permission wasn't established in repository metadata, and Salesforce couldn't verify access.`;
      return refs.map((ref) => {
        const parentLine = ref.queryLineNumber ?? ref.lineNumber;
        const queryDetails = queryInfo(ref.filePath, parentLine);
        const execution = queryByLocation.get(`${ref.filePath}|${parentLine}`)?.execution;
        const outcome = findingOutcome(decision.source, execution);
        const advisory = decision.source === "ORG_DENIED" && outcome.criticality === "Low"
          ? execution?.enforcement === "NONE"
            ? " This SOQL query runs in system mode, so it does not enforce the user's Read permission. Review potential data exposure in application logic."
            : " User-level Read access is missing, but query enforcement could not be confirmed; review the Apex execution mode."
          : "";
        return {
          ...outcome, findingType: type, filePath: ref.filePath, lineNumber: ref.lineNumber,
          object, field, ...queryDetails,
          ...(ref.relationshipPath ? { relationshipPath: ref.relationshipPath, queryLevel: ref.relationshipPath.split(" -> ").length } : {}),
          runtimeImpact: execution
            ? runtimeImpactForFinding(execution, decision.source === "ORG_VERIFIED" ? "VERIFIED" :
                decision.source === "ORG_DENIED" ? "DENIED" : "UNVERIFIED")
            : "Undetermined" as const,
          // Preserve diagnostic details for inconclusive checks without repeating confirmed denials.
          reason: `${detail}${decision.source === "UNVERIFIED" ? ` ${decision.message}` : ""}${advisory}`.trim(),
        };
      });
    }

    // Resolve each distinct object only once. One object failure is represented
    // once per referencing SOQL query, NOT duplicated across all fields.
    const objects = [...inventory.entries()];
    const results = new Map<string, SoqlSecurityFinding[]>();
    await boundedMap(objects, async ([object, fields]) => {
      const repositoryObject = evaluator.evaluateObject(object).access;
      const objectDecision = this.readVerification
        ? await this.readVerification.resolve(persona, object, repositoryObject.read)
        : repositoryObject.read
          ? { source: "REPOSITORY" as const, readable: true, message: "Read permission established in repository." }
          : { source: "UNVERIFIED" as const, readable: false, message: "Salesforce verification unavailable." };

      const objectFindings: SoqlSecurityFinding[] = [];
      if (objectDecision.source !== "REPOSITORY") {
        // Produce one object Read row per SOQL reference (dedupe source location).
        const references = inventory.objectReferences.get(object) ?? [];
        const distinct = new Map<string, SoqlFieldReference>();
        for (const ref of references) {
          distinct.set(`${ref.filePath}|${ref.queryLineNumber ?? ref.lineNumber}`, ref);
        }
        objectFindings.push(...findingFor([...distinct.values()], object, OBJECT_READ_FIELD,
          "OBJECT_READ", objectDecision));
      }

      // If object Read is denied or uncertain, all fields depend on that result;
      // do NOT fabricate individual FLS errors. Keep the object finding only.
      if (!objectDecision.readable) {
        results.set(object, objectFindings);
        return;
      }
      if (repositoryObject.read && repositoryObject.viewAllFields) {
        results.set(object, objectFindings);
        return;
      }

      const uniqueFields = [...fields.entries()];
      const fieldFindings = new Map<string, SoqlSecurityFinding[]>();
      await boundedMap(uniqueFields, async ([fieldKey, references]) => {
        const fieldName = references[0]?.field ?? fieldKey;
        const grant = evaluator.evaluateField(`${object}.${fieldName}`);
        // FLS is independent of object Read. Non-permissionable or schema-
        // required fields do not require explicit FLS; neither does ViewAllFields.
        const repositoryFieldRead = grant.schemaRequired === true ||
          grant.permissionable === false || grant.readGrantedBy.length > 0 ||
          repositoryObject.viewAllFields;
        if (repositoryFieldRead) return;

        const fieldDecision = this.readVerification
          ? await this.readVerification.resolveFieldRead(persona, object, fieldName, false)
          : { source: "UNVERIFIED" as const, readable: false, message: "Salesforce verification unavailable." };
        fieldFindings.set(fieldKey,
          findingFor(references, object, fieldName, "FIELD_READ", fieldDecision));
      });
      for (const [key] of uniqueFields) objectFindings.push(...(fieldFindings.get(key) ?? []));
      results.set(object, objectFindings);
    });

    for (const [object] of objects) findings.push(...(results.get(object) ?? []));

    // Relationship resolution gaps are also inconclusive, not access denials.
    const reported = new Set<string>();
    for (const unresolved of unresolvedFields) {
      const id = `${unresolved.query.filePath}:${unresolved.lineNumber ?? unresolved.query.lineNumber}:${unresolved.baseObject}:${unresolved.fieldPath}`.toLowerCase();
      if (reported.has(id)) continue;
      reported.add(id);
      findings.push({
        severity: "REVIEW", criticality: "Unable to verify", verificationSource: "UNVERIFIED",
        findingType: "RELATIONSHIP", filePath: unresolved.query.filePath,
        lineNumber: unresolved.lineNumber ?? unresolved.query.lineNumber, object: unresolved.baseObject,
        field: unresolved.kind === "RELATIONSHIP" ? `Child relationship: ${unresolved.fieldPath}` : unresolved.fieldPath,
        ...queryInfo(unresolved.query.filePath, unresolved.query.lineNumber),
        ...(unresolved.relationshipPath ? {
          relationshipPath: unresolved.relationshipPath,
          queryLevel: unresolved.relationshipPath.split(" -> ").length
        } : {}),
        runtimeImpact: "Not assessed",
        reason: unresolved.kind === "RELATIONSHIP"
          ? `Unable to resolve child relationship ${unresolved.baseObject}.${unresolved.fieldPath}; access was not assessed.`
          : `Could not resolve ${unresolved.baseObject}.${unresolved.fieldPath} from relationship metadata. Field access wasn't assessed.`,
      });
    }
    // API 67.0+ rejects WITH SECURITY_ENFORCED at compile time, regardless
    // of the user's access. Surface this separately from any CRUD/FLS gap.
    queries.forEach((query, index) => {
      const mode = modeResults[index];
      if (mode.enforcement !== "INVALID") return;
      findings.push({
        severity: "REVIEW", criticality: "Unable to verify", verificationSource: "UNVERIFIED",
        findingType: "QUERY_MODE", filePath: query.filePath, lineNumber: query.lineNumber,
        object: query.object, field: "(Unsupported Query Clause)", query: query.query,
        withUserMode: query.withUserMode, apiVersion: mode.apiVersion,
        declaredMode: mode.declaredMode, effectiveMode: mode.effectiveMode, runtimeImpact: "Unsupported query clause",
        reason: mode.description,
      });
    });
    return findings;
  }
}
