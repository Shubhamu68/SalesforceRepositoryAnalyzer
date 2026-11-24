import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
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
import type { SalesforceFieldMetadataService } from "../salesforce/SalesforceFieldMetadataService.js";
import type { SoqlFieldInventory, SoqlFieldReference } from "../models/SoqlFieldInventory.js";
import { ApexExecutionSecurityModeResolver } from "../services/ApexExecutionSecurityModeResolver.js";
import { resolveSoqlExecutionMode, runtimeImpactForFinding, type SoqlExecutionMode } from "./soqlExecutionMode.js";
import { recordSoqlCount, timeSoqlPhase, timeSoqlSync } from "../services/SoqlPerformanceMetrics.js";

/** Prevent hundreds of simultaneous Salesforce requests on large repositories. */
const CONCURRENCY = 4;
const OBJECT_READ_FIELD = "(Object Read Missing)";

type Decision = { source: ReadDecisionSource; message: string; readable: boolean; deniedCompoundParent?: string };

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

/**
 * Persona-independent prepared SOQL work. The inventory and query execution
 * modes can be shared by the upcoming all-personas high-priority report;
 * object and field access decisions must be evaluated separately per persona.
 */
export interface PreparedSoqlSecurityAnalysis {
  queries: SoqlQuery[];
  inventory: SoqlFieldInventory;
  unresolvedFields: UnresolvedSoqlField[];
  parserLimitations: Array<{ query: SoqlQuery; message: string }>;
  modeResults: SoqlExecutionMode[];
}

export class SoqlSecurityAnalyzer {
  constructor(
    private readonly personaPermissionResolver: PersonaPermissionResolver,
    private readonly objectsDirectory: string,
    private readonly readVerification?: OrgObjectReadVerificationService,
    private readonly executionModeResolver = new ApexExecutionSecurityModeResolver(),
    private readonly orgRelationshipMetadata?: SalesforceRelationshipMetadataService,
    private readonly fieldMetadata?: SalesforceFieldMetadataService,
  ) {}

  async analyze(persona: Persona, inputQueries: SoqlQuery[]): Promise<SoqlSecurityFinding[]> {
    const prepared = await this.prepare(inputQueries);
    return this.analyzePrepared(persona, prepared);
  }

  /** Expensive, persona-independent work that callers may reuse within a run. */
  async prepare(inputQueries: SoqlQuery[]): Promise<PreparedSoqlSecurityAnalysis> {
    // Direct callers may bypass SoqlAnalysisService; skip event queries here too.
    const queries = inputQueries.filter((query) => isDataAccessAnalysisObject(query.object));
    const relationshipMap = await timeSoqlPhase("relationships.local", () => buildRelationshipMap(this.objectsDirectory,
      { connected: Boolean(this.orgRelationshipMetadata),
        organizationId: this.orgRelationshipMetadata?.getOrganizationId?.() }));
    // The same scoped collector and Describe hydrator are used by Stack Trace.
    // Only queries with unresolved paths trigger optional Salesforce Describe.
    if (this.orgRelationshipMetadata) {
      await timeSoqlPhase("relationships.org", async () => {
        const hydrator = this.orgRelationshipMetadata!.createHydrator(relationshipMap);
        await boundedMap(queries, async (query) => {
          // No dotted reference or subquery can require relationship hydration.
          // Avoid parsing the full SOQL expression twice on this safe fast path.
          if (!query.query.includes(".") && query.subqueries.length === 0) {
            recordSoqlCount("relationships.simple_queries");
            return;
          }
          const firstPass = collectQueryFields(query, relationshipMap);
          if (firstPass.unresolved.length) {
            await hydrator.hydrateQuery(query,
              firstPass.unresolvedEntries.map((item) => `${item.baseObject}.${item.fieldPath}`));
          }
        });
      });
    }
    const unresolvedFields: UnresolvedSoqlField[] = [];
    const parserLimitations: Array<{ query: SoqlQuery; message: string }> = [];
    const inventory = timeSoqlSync("fields.inventory", () => buildSoqlFieldInventory(queries, relationshipMap,
      (entry) => unresolvedFields.push(entry),
      (query, message) => parserLimitations.push({ query, message })));
    this.executionModeResolver.clearCache();
    // Version lookup is cached per class, so hundreds of queries do not trigger
    // hundreds of metadata reads. The same resolver serves Stack Trace analysis.
    const modeResults = await timeSoqlPhase("execution.modes", () => Promise.all(queries.map((query) =>
      this.executionModeResolver.resolve(query.query, query.filePath).then(mode =>
        query.dynamicAccessLevel && mode.declaredMode === "UNSPECIFIED"
          ? resolveSoqlExecutionMode(query.dynamicAccessLevel, mode.apiVersion)
          : mode)
    )));
    return { queries, inventory, unresolvedFields, parserLimitations, modeResults };
  }

  /** Persona-specific verification. Never reuse another persona's access decisions. */
  async analyzePrepared(
    persona: Persona, prepared: PreparedSoqlSecurityAnalysis,
    onObjectProgress?: (completed: number, total: number) => void,
  ): Promise<SoqlSecurityFinding[]> {
    const { queries, inventory, unresolvedFields, parserLimitations, modeResults } = prepared;
    const resolved = await timeSoqlPhase("permissions.resolve", () => this.personaPermissionResolver.resolve(persona));
    const evaluator = createPersonaAccessEvaluator(resolved);
    const queryByLocation = new Map<string, { query: SoqlQuery; execution: SoqlExecutionMode }>(queries.map((query, index) => [
      query.queryVariantId ?? `${query.filePath}|${query.lineNumber}`, { query, execution: modeResults[index] },
    ]));
    const findings: SoqlSecurityFinding[] = [];

    function queryInfo(filePath: string, lineNumber: number, variantId?: string) {
      const data = queryByLocation.get(variantId ?? `${filePath}|${lineNumber}`);
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
      const detail = decision.deniedCompoundParent
        ? `${subject}: Salesforce confirmed missing Read on compound parent ${object}.${decision.deniedCompoundParent}. The requested address/location component had no conclusive direct UserFieldAccess decision; this finding is attributed to the denied parent, not an independently proven component denial.`
        : decision.source === "ORG_VERIFIED"
        ? `${subject}: Read permission wasn't established in repository metadata, but Salesforce confirmed access.${decision.message.includes("via compound parent") ? " " + decision.message : ""}`
        : decision.source === "ORG_DENIED"
          ? `${subject}: Repository metadata did not establish Read access; Salesforce confirmed it is missing for the selected user.`
          : `${subject}: Read permission wasn't established in repository metadata, and Salesforce couldn't verify access.`;
      return refs.map((ref) => {
        const parentLine = ref.queryLineNumber ?? ref.lineNumber;
        const queryDetails = queryInfo(ref.filePath, parentLine, ref.queryVariantId);
        const execution = queryByLocation.get(ref.queryVariantId ?? `${ref.filePath}|${parentLine}`)?.execution;
        // WITH SECURITY_ENFORCED checks SELECT fields, not automatically
        // every filtering/grouping/sorting expression. Never fabricate a
        // High-severity enforced failure for a non-SELECT-only field use.
        const unenforcedClause = execution?.enforcement === "SELECT_ONLY" &&
          ref.usageContext !== undefined && ref.usageContext !== "SELECT";
        const scopedExecution = unenforcedClause
          ? { ...execution, enforcement: "UNKNOWN" as const } : execution;
        const outcome = findingOutcome(decision.source, scopedExecution);
        const advisory = decision.source === "ORG_DENIED" && outcome.criticality === "Low"
          ? execution?.enforcement === "NONE"
            ? " This SOQL query runs in system mode, so it does not enforce the user's Read permission. Review potential data exposure in application logic."
            : " User-level Read access is missing, but query enforcement could not be confirmed; review the Apex execution mode."
          : "";
        return {
          ...outcome, findingType: type, filePath: ref.filePath, lineNumber: ref.lineNumber,
          object, field, ...queryDetails,
          ...(ref.queryVariantId ? { queryVariantId: ref.queryVariantId } : {}),
          ...(ref.relationshipPath ? { relationshipPath: ref.relationshipPath, queryLevel: ref.relationshipPath.split(" -> ").length } : {}),
          runtimeImpact: scopedExecution
            ? runtimeImpactForFinding(scopedExecution, decision.source === "ORG_VERIFIED" ? "VERIFIED" :
                decision.source === "ORG_DENIED" ? "DENIED" : "UNVERIFIED")
            : "Undetermined" as const,
          // Preserve diagnostic details for inconclusive checks without repeating confirmed denials.
          reason: `${detail}${decision.source === "UNVERIFIED" ? ` ${decision.message}` : ""}${advisory}${unenforcedClause
            ? " This field is referenced outside SELECT; legacy SECURITY_ENFORCED does not establish enforcement for this clause."
            : ""}${ref.functionName
            ? ` Field is referenced by ${ref.functionName}() in ${ref.usageContext ?? "SELECT"}.`
            : ""}`.trim(),
        };
      });
    }

    // Resolve each distinct object only once. One object failure is represented
    // once per referencing SOQL query, NOT duplicated across all fields.
    const objects = [...inventory.entries()];
    let completedObjects = 0;
    onObjectProgress?.(0, objects.length);
    recordSoqlCount("inventory.objects", objects.length);
    recordSoqlCount("inventory.unique_fields", objects.reduce((total, [, fields]) => total + fields.size, 0));
    const results = new Map<string, SoqlSecurityFinding[]>();
    await timeSoqlPhase("access.evaluate", () => boundedMap(objects, async ([object, fields]) => {
      try {
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
          distinct.set(ref.queryVariantId ?? `${ref.filePath}|${ref.queryLineNumber ?? ref.lineNumber}`, ref);
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
      const deniedParentKeys = new Set<string>();
      await boundedMap(uniqueFields, async ([fieldKey, references]) => {
        const fieldName = references[0]?.field ?? fieldKey;
        const grant = evaluator.evaluateField(`${object}.${fieldName}`);
        // An explicit repository grant (or schema-required Read) has already
        // established FLS. EntityParticle metadata cannot change that verdict;
        // avoid an unnecessary live-org lookup when all fields are granted.
        if (grant.schemaRequired === true || grant.readGrantedBy.length > 0) return;
        // Current-org metadata overrides any explicitly selected offline cache. Never
        // infer a grant from an unknown field in a successful live lookup.
        const metadata = await this.fieldMetadata?.getField(object, fieldName);
        const permissionable = this.fieldMetadata ? metadata?.permissionable : grant.permissionable;
        // A non-permissionable component needs object Read, not separate FLS.
        const repositoryFieldRead = permissionable === false;
        if (repositoryFieldRead) return;

        const fieldDecision: Decision = this.readVerification
          ? await this.readVerification.resolveFieldRead(persona, object, fieldName, false)
          : { source: "UNVERIFIED", readable: false, message: "Salesforce verification unavailable." };
        // The confirmed permission gap belongs to the parent, not the
        // component with no direct access row. Report under the parent so the
        // Excel writer groups repeated components with the existing High row.
        const reportedField = fieldDecision.deniedCompoundParent ?? fieldName;
        if (fieldDecision.deniedCompoundParent) deniedParentKeys.add(reportedField.toLowerCase());
        fieldFindings.set(fieldKey,
          findingFor(references, object, reportedField, "FIELD_READ", fieldDecision));
      });
      // Multiple components of one inaccessible compound parent can occur
      // on the same Apex line. Keep one reference per denied parent/location;
      // distinct source lines still appear in the Excel occurrence list.
      const groupedFieldFindings = new Map<string, SoqlSecurityFinding>();
      for (const [key] of uniqueFields) {
        for (const [index, finding] of (fieldFindings.get(key) ?? []).entries()) {
          // Deduplicate ONLY confirmed compound-parent dependencies; unrelated
          // field references can differ in clause/enforcement at one line.
          const id = deniedParentKeys.has(finding.field.toLowerCase())
            ? [finding.object, finding.field, finding.filePath,
                finding.lineNumber, finding.queryVariantId ?? "", finding.relationshipPath ?? ""].join("|").toLowerCase()
            : `direct|${key}|${index}`;
          if (!groupedFieldFindings.has(id)) groupedFieldFindings.set(id, finding);
        }
      }
      objectFindings.push(...groupedFieldFindings.values());
      results.set(object, objectFindings);
      } finally {
        // A unit finishes only after all of its relevant field decisions.
        completedObjects++;
        onObjectProgress?.(completedObjects, objects.length);
      }
    }));

    for (const [object] of objects) findings.push(...(results.get(object) ?? []));

    // Relationship resolution gaps are also inconclusive, not access denials.
    const reported = new Set<string>();
    for (const unresolved of unresolvedFields) {
      const id = `${unresolved.query.queryVariantId ?? unresolved.query.filePath}:${unresolved.lineNumber ?? unresolved.query.lineNumber}:${unresolved.baseObject}:${unresolved.fieldPath}`.toLowerCase();
      if (reported.has(id)) continue;
      reported.add(id);
      findings.push({
        severity: "REVIEW", criticality: "Unable to verify", verificationSource: "UNVERIFIED",
        findingType: "RELATIONSHIP", filePath: unresolved.query.filePath,
        lineNumber: unresolved.lineNumber ?? unresolved.query.lineNumber, object: unresolved.baseObject,
        field: unresolved.kind === "RELATIONSHIP" ? `Child relationship: ${unresolved.fieldPath}` : unresolved.fieldPath,
        ...queryInfo(unresolved.query.filePath, unresolved.query.lineNumber, unresolved.query.queryVariantId),
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
    // A parser/semantic limitation is a review finding, not a missing FLS
    // permission. Never allow unsupported SOQL expressions to look clean.
    const parseSeen = new Set<string>();
    for (const { query, message } of parserLimitations) {
      const key = `${query.queryVariantId ?? (query.filePath+"|"+query.lineNumber)}|${message}`;
      if (parseSeen.has(key)) continue;
      parseSeen.add(key);
      findings.push({
        severity: "REVIEW", criticality: "Unable to verify",
        verificationSource: "UNVERIFIED", findingType: "PARSER",
        filePath: query.filePath, lineNumber: query.lineNumber,
        object: query.object, field: "(SOQL syntax review)",
        ...queryInfo(query.filePath, query.lineNumber, query.queryVariantId),
        runtimeImpact: "Not assessed",
        reason: `SOQL field extraction was incomplete: ${message} No access decision was inferred from this expression.`,
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
        ...(query.queryVariantId ? { queryVariantId: query.queryVariantId } : {}),
        withUserMode: query.withUserMode, apiVersion: mode.apiVersion,
        declaredMode: mode.declaredMode, effectiveMode: mode.effectiveMode, runtimeImpact: "Unsupported query clause",
        reason: mode.description,
      });
    });
    // Tag every finding from a partial caller variant (including relationship
    // and parser diagnostics). The distinct site-level REVIEW remains.
    for(const finding of findings){
      const variant=finding.queryVariantId;
      if(variant&&queryByLocation.get(variant)?.query.coverage==="KNOWN_CALLER_CONTEXT")
        finding.reason += " Coverage: known repository caller variant only; other execution contexts remain unverified.";
    }
    return findings;
  }
}
