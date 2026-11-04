import path from "node:path";
import { access } from "node:fs/promises";
import { isKnownSalesforcePermissionSet } from "../config/knownSalesforcePermissionSets.js";
import type { Persona } from "../models/Persona.js";
import type {
  StackTraceImpactResult, StackQueryImpact, QueryPersonaImpact, StackPersonaImpact,
  MissingReadPermission, ImpactStatus, ReachableMethod,
} from "../models/StackTraceImpact.js";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver, type ResolvedPersonaPermissions } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";
import { buildRelationshipMap } from "../analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../analyzer/soqlQueryFieldResolver.js";
import {
  createApexMethodIndex, parseApexStackTrace, resolveMethodCalls, maskApex, type ApexMethod,
} from "../scanner/apexMethodScanner.js";

const MAX_METHODS = 150;
const MAX_DEPTH = 12;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unique = <T>(items: T[]) => [...new Set(items)];

// Same risk category for SELECT permissions; the clauses do not have identical
// enforcement semantics (SECURITY_ENFORCED does not enforce WHERE-only FLS).
export type StackSoqlSecurityMode = "USER_MODE" | "SECURITY_ENFORCED" | "SYSTEM_MODE" | "UNSPECIFIED";
export function classifyStackSoqlMode(source: string): StackSoqlSecurityMode {
  const cleaned = maskApex(source);
  if (/\bWITH\s+USER_MODE\b/i.test(cleaned)) return "USER_MODE";
  if (/\bWITH\s+SECURITY_ENFORCED\b/i.test(cleaned)) return "SECURITY_ENFORCED";
  if (/\bWITH\s+SYSTEM_MODE\b/i.test(cleaned)) return "SYSTEM_MODE";
  return "UNSPECIFIED";
}

async function isKnownMissingPermissionSet(name: string, directory: string): Promise<boolean> {
  if (!isKnownSalesforcePermissionSet(name)) return false;
  try {
    await access(path.join(directory, `${name}.permissionset-meta.xml`));
    return false; // An existing but malformed file must not be silently bypassed.
  } catch {
    return true;
  }
}

export class StackTraceImpactService {
  constructor(
    private readonly repositoryPath: string,
    private readonly objectsDirectory: string,
    private readonly personaConfigLoader: PersonaConfigLoader,
    private readonly resolver: PersonaPermissionResolver,
    private readonly mutingDirectory: string
  ) {}

  async analyze(stackTrace: string): Promise<StackTraceImpactResult> {
    if (!stackTrace.trim() || stackTrace.length > 15000) {
      throw new Error("Enter an Apex stack trace (maximum 15,000 characters).");
    }
    const frames = parseApexStackTrace(stackTrace);
    const classFrames = frames.filter((frame) => frame.kind === "Class");
    if (!classFrames.length) throw new Error("No Apex Class frames with line numbers were found in the stack trace.");
    const index = await createApexMethodIndex(this.repositoryPath);
    const warnings: string[] = [];

    // The first Class frame is the nearest available Apex execution location.
    // Validate both the method name and source line so we don't pick an unrelated overload.
    let entry: ApexMethod | undefined;
    for (const frame of classFrames) {
      const className = frame.className.split(".").at(-1)!;
      const matches = (index.classes.get(className.toLowerCase()) ?? [])
        .filter((method) => equal(method.methodName, frame.methodName ?? "")
          && frame.line >= method.startLine && frame.line <= method.endLine);
      if (matches.length === 1) { entry = matches[0]; break; }
      if (matches.length > 1) {
        warnings.push(`Ambiguous stack frame ${frame.raw}; multiple methods match its line. Skipped.`);
      }
    }
    if (!entry) throw new Error(
      "No unique Apex method matched the stack trace's class, method, and line. " +
      "Check that the repository version matches the version that produced the trace."
    );

    const reached = new Map<string, ReachableMethod>();
    const sourceMethods = new Map<string, ApexMethod>();
    function walk(method: ApexMethod, callPath: string[], depth: number): void {
      const existing = reached.get(method.id);
      if (existing) {
        if (existing.callPaths.length < 8 && !existing.callPaths.some((path) => path.join("|") === callPath.join("|"))) {
          existing.callPaths.push(callPath);
        }
        return;
      }
      if (depth > MAX_DEPTH || reached.size >= MAX_METHODS) {
        warnings.push("Traversal limit reached; not all possible methods could be evaluated.");
        return;
      }
      const info: ReachableMethod = {
        id: method.id, className: method.className, methodName: method.methodName,
        filePath: path.relative(thisService.repositoryPath, method.filePath),
        startLine: method.startLine, endLine: method.endLine, depth, callPaths: [callPath],
      };
      reached.set(method.id, info);
      sourceMethods.set(method.id, method);
      for (const callee of resolveMethodCalls(method, index, warnings)) {
        walk(callee, [...callPath, `${callee.className}.${callee.methodName}`], depth + 1);
      }
    }
    const thisService = this;
    walk(entry, [`${entry.className}.${entry.methodName}`], 0);

    const persons = await this.personaConfigLoader.getAllPersonas();
    const relationshipMap = await buildRelationshipMap(this.objectsDirectory);
    const prepared: {
      persona: Persona;
      resolved: ResolvedPersonaPermissions;
      incomplete: boolean;
      externalSkipped: boolean;
    }[] = [];
    const missingKnownSets = new Map<string, Promise<boolean>>();
    const ignoreMissingKnown = (name: string, directory: string) => {
      const cacheKey = `${directory}:${name.toLowerCase()}`;
      if (!missingKnownSets.has(cacheKey)) missingKnownSets.set(cacheKey, isKnownMissingPermissionSet(name, directory));
      return missingKnownSets.get(cacheKey)!;
    };
    for (const persona of persons) {
      const resolved = await this.resolver.resolve(persona);
      let incomplete = persona.permissionSetGroups.some((psg) =>
        !resolved.permissionSetGroups.some((found) => equal(psg, found.name)));
      let externalSkipped = false;
      for (const ps of persona.permissionSets) {
        if (resolved.directPermissionSets.some((found) => equal(ps, found.name))) continue;
        if (await ignoreMissingKnown(ps, path.join(path.dirname(this.mutingDirectory), "permissionsets"))) externalSkipped = true;
        else incomplete = true;
      }
      for (const group of resolved.permissionSetGroups) {
        for (const ps of group.permissionSetNames) {
          if (group.permissionSets.some((found) => equal(ps, found.name))) continue;
          if (await ignoreMissingKnown(ps, path.join(path.dirname(this.mutingDirectory), "permissionsets"))) externalSkipped = true;
          else incomplete = true;
        }
        const muteNames = group.mutingPermissionSetNames.length
          ? group.mutingPermissionSetNames
          : resolved.permissionSetGroups.length === 1 ? persona.mutingPermissionSets : [];
        for (const name of unique(muteNames)) {
          if (!(resolved.mutesByGroup.get(group.name) ?? []).some((mute) => equal(mute.name, name))) incomplete = true;
        }
      }
      if (resolved.permissionSetGroups.length > 1 && persona.mutingPermissionSets.some((mute) =>
        !resolved.permissionSetGroups.some((group) => group.mutingPermissionSetNames.some((name) => equal(name, mute))))) incomplete = true;
      prepared.push({ persona, resolved, incomplete, externalSkipped });
    }

    const allQueries: StackQueryImpact[] = [];
    for (const methodInfo of reached.values()) {
      const method = sourceMethods.get(methodInfo.id)!;
      for (const query of method.queries) {
        const securityMode = classifyStackSoqlMode(query.query);
        const enforcesSelectedFls = securityMode === "USER_MODE" || securityMode === "SECURITY_ENFORCED";
        const inventory = collectQueryFields(query, relationshipMap);
        const impacts: QueryPersonaImpact[] = prepared.map((person) => {
          const missing: MissingReadPermission[] = [];
          const notes: string[] = [];
          const evaluator = createPersonaAccessEvaluator(person.resolved);
          // Object Read findings are scoped to explicit FROM objects, not every
          // parent traversed by a dotted field path (e.g. OriginalOrderItem.Order).
          // This restores the pre-deep-resolution reporting scope without losing
          // recursive field-level analysis on the final related object.
          const fromObjects = new Set(inventory.queriedObjects.map((name) => name.toLowerCase()));
          const objects = unique([...inventory.objects, ...inventory.fields.map((field) => field.object)]);
          const grants = new Map(objects.map((name) => [name.toLowerCase(),
            evaluator.evaluateObject(name)
          ]));
          for (const objectName of inventory.queriedObjects) {
            if (!grants.get(objectName.toLowerCase())!.access.read) {
              missing.push({ object: objectName, reason: "OBJECT_READ" });
            }
          }
          const uncheckedRelatedObjectRead = new Set<string>();
          for (const field of inventory.fields) {
            if (securityMode === "SECURITY_ENFORCED" && /^(WHERE|ORDER BY) /i.test(field.source)) continue;
            const objectAccess = grants.get(field.object.toLowerCase())?.access;
            if (objectAccess?.viewAllFields) continue;
            const fieldGrant = evaluator.evaluateField(`${field.object}.${field.field}`);
            // evaluateField.readable includes object Read. For related objects,
            // check FLS separately: absence of the object grant must not turn an
            // explicitly granted or schema-required field into a false FLS error.
            const hasFieldRead = fieldGrant.schemaRequired === true || fieldGrant.permissionable === false || fieldGrant.readGrantedBy.length > 0;
            if (fromObjects.has(field.object.toLowerCase()) && !objectAccess?.read) continue;
            if (!hasFieldRead) {
              missing.push({ object: field.object, field: field.field, reason: "FIELD_READ" });
            }
            if (!fromObjects.has(field.object.toLowerCase()) && !objectAccess?.read) {
              uncheckedRelatedObjectRead.add(field.object);
            }
          }
          if (uncheckedRelatedObjectRead.size) {
            notes.push(`Object Read for related objects (${[...uncheckedRelatedObjectRead].join(", ")}) was not assessed as a separate finding; field FLS was still checked. Runtime access may require further review.`);
          }
          if (securityMode === "UNSPECIFIED") notes.push("No explicit query mode; access enforcement depends on the Apex API version and context.");
          if (securityMode === "SYSTEM_MODE") notes.push("WITH SYSTEM_MODE does not enforce FLS at query execution.");
          if (securityMode === "SECURITY_ENFORCED") notes.push("WITH SECURITY_ENFORCED checks selected fields (including relationships), but not WHERE-only fields; it is unsupported in Apex API 67.0+.");
          if (person.incomplete) notes.push("Some assigned Permission Set metadata is missing; absence of grants is not conclusive.");
          if (person.externalSkipped) notes.push("Salesforce-owned Order Management Permission Set was excluded because its metadata is absent. A missing grant is a potential gap, not a confirmed runtime failure.");
          if (inventory.unresolved.length) notes.push("Some relationship fields could not be resolved.");
          if (inventory.limitations.length) notes.push("Some filter/sort expressions could not be fully evaluated.");
          const unverified = person.incomplete || person.externalSkipped || inventory.unresolved.length > 0 || inventory.limitations.length > 0 || uncheckedRelatedObjectRead.size > 0;
          let status: ImpactStatus;
          if (missing.length) status = enforcesSelectedFls ? "AT_RISK" : "REVIEW";
          else if (unverified) status = "REVIEW"; // Incomplete evidence must not become "No gaps".
          else status = "NO_GAPS";
          return { personaName: person.persona.name, status, missing, notes };
        });
        allQueries.push({
          id: `${method.id}:${query.lineNumber}`,
          methodId: method.id,
          className: method.className,
          methodName: method.methodName,
          filePath: methodInfo.filePath,
          lineNumber: query.lineNumber,
          object: query.object,
          query: query.query,
          withUserMode: securityMode === "USER_MODE",
          securityMode,
          checkedFields: inventory.fields,
          unresolvedFields: inventory.unresolved,
          limitations: inventory.limitations,
          personas: impacts,
        });
      }
    }
    allQueries.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);
    const traversalIncomplete = warnings.some((warning) =>
      warning.startsWith("Ambiguous overload") || warning.startsWith("Traversal limit")
    );
    const personas: StackPersonaImpact[] = prepared.map((p) => {
      const impacts = allQueries.map((query) => query.personas.find((item) => item.personaName === p.persona.name)!);
      const status: ImpactStatus = impacts.some((r) => r.status === "AT_RISK") ? "AT_RISK"
        : (!impacts.length || traversalIncomplete || impacts.some((r) => r.status === "REVIEW")) ? "REVIEW" : "NO_GAPS";
      const found = new Map<string, MissingReadPermission>();
      for (const impact of impacts) for (const missing of impact.missing) found.set(
        `${missing.object}.${missing.field ?? ""}.${missing.reason}`.toLowerCase(), missing
      );
      return {
        personaName: p.persona.name, status,
        atRiskQueries: impacts.filter((r) => r.status === "AT_RISK").length,
        reviewQueries: impacts.filter((r) => r.status === "REVIEW").length,
        missing: [...found.values()],
      };
    });
    return {
      entryMethod: reached.get(entry.id)!,
      frames, methods: [...reached.values()], queries: allQueries, personas,
      summary: {
        methodsVisited: reached.size,
        queriesFound: allQueries.length,
        personasChecked: prepared.length,
        atRisk: personas.filter((p) => p.status === "AT_RISK").length,
        review: personas.filter((p) => p.status === "REVIEW").length,
        noGaps: personas.filter((p) => p.status === "NO_GAPS").length,
      },
      warnings: unique([
        ...warnings,
        ...(allQueries.length === 0 ? ["No static SOQL was found in the reachable methods; this is not proof of safe access."] : []),
        "Static analysis follows unambiguous same-class, class-qualified, and typed-instance calls; dynamic dispatch and reflection are not resolved.",
        ...(prepared.some((person) => person.incomplete)
          ? ["Some personas have incomplete metadata other than the known excluded Salesforce-owned Permission Set; Review results may not be conclusive."] : []),
      ]),
    };
  }
}

