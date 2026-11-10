import path from "node:path";
import { access } from "node:fs/promises";
import { ApexExecutionSecurityModeResolver } from "./ApexExecutionSecurityModeResolver.js";
import { classifySoqlMode, type DeclaredSoqlMode } from "../analyzer/soqlExecutionMode.js";
import { isKnownSalesforcePermissionSet } from "../config/knownSalesforcePermissionSets.js";
import { isStatusNeutralOrgObjectRead, type OrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import type { Persona } from "../models/Persona.js";
import type {
  StackTraceImpactResult, StackQueryImpact, QueryPersonaImpact, StackPersonaImpact,
  MissingReadPermission, ImpactStatus, ReachableMethod, OrgCheckedUser,
} from "../models/StackTraceImpact.js";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver, type ResolvedPersonaPermissions } from "../analyzer/PersonaPermissionResolver.js";
import { createPersonaAccessEvaluator } from "../analyzer/personaAccessEvaluator.js";
import { buildRelationshipMap } from "../analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../analyzer/soqlQueryFieldResolver.js";
import { OrgObjectReadVerificationService } from "./OrgObjectReadVerificationService.js";
import type { OrgObjectAccessEvidence } from "../salesforce/SalesforcePersonaAccessVerifier.js";
import { SalesforceRelationshipMetadataService } from "../salesforce/SalesforceRelationshipMetadataService.js";
import {
  createApexMethodIndex, parseApexStackTrace, resolveMethodCalls, type ApexMethod,
} from "../scanner/apexMethodScanner.js";

const MAX_METHODS = 150;
const MAX_DEPTH = 12;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unique = <T>(items: T[]) => [...new Set(items)];

// Retained for existing callers; both analyzers now use the shared classifier.
export type StackSoqlSecurityMode = DeclaredSoqlMode;
export function classifyStackSoqlMode(source: string): StackSoqlSecurityMode {
  return classifySoqlMode(source);
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
  private readonly executionModeResolver = new ApexExecutionSecurityModeResolver();

  constructor(
    private readonly repositoryPath: string,
    private readonly objectsDirectory: string,
    private readonly personaConfigLoader: PersonaConfigLoader,
    private readonly resolver: PersonaPermissionResolver,
    private readonly mutingDirectory: string,
    private readonly orgVerifier?: OrgObjectReadVerificationService,
    private readonly orgRelationshipMetadata?: SalesforceRelationshipMetadataService,
    private readonly orgVerificationStatusPolicy?: OrgVerificationStatusPolicy
  ) {}

  async analyze(stackTrace: string): Promise<StackTraceImpactResult> {
    this.executionModeResolver.clearCache();
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
    const orgRelationshipHydrator = this.orgRelationshipMetadata?.createHydrator(relationshipMap);
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
        const mode = await this.executionModeResolver.resolve(query.query, method.filePath);
        const securityMode = mode.declaredMode;
        let inventory = collectQueryFields(query, relationshipMap);
        if (inventory.unresolved.length && orgRelationshipHydrator) {
          // Describe metadata is consulted only when local relationship metadata
          // was insufficient. This includes standard polymorphic Owner links.
          const describeWarnings = await orgRelationshipHydrator.hydrateQuery(query, inventory.unresolved);
          warnings.push(...describeWarnings);
          inventory = collectQueryFields(query, relationshipMap);
        }
        const impacts: QueryPersonaImpact[] = prepared.map((person) => {
          const missing: MissingReadPermission[] = [];
          const notes: string[] = [];
          const evaluator = createPersonaAccessEvaluator(person.resolved);
          // Object Read findings are scoped to explicit FROM objects, not every
          // parent traversed by a dotted field path (e.g. OriginalOrderItem.Order).
          // This restores the pre-deep-resolution reporting scope without losing
          // recursive field-level analysis on the final related object.
          const objects = unique([...inventory.objects, ...inventory.fields.map((field) => field.object)]);
          const grants = new Map(objects.map((name) => [name.toLowerCase(),
            evaluator.evaluateObject(name)
          ]));
          for (const objectName of inventory.queriedObjects) {
            if (!grants.get(objectName.toLowerCase())!.access.read) {
              missing.push({ object: objectName, reason: "OBJECT_READ" });
            }
          }
          for (const field of inventory.fields) {
            if (securityMode === "SECURITY_ENFORCED" && /^(WHERE|ORDER BY) /i.test(field.source)) continue;
            const objectAccess = grants.get(field.object.toLowerCase())?.access;
            if (objectAccess?.viewAllFields) continue;
            const fieldGrant = evaluator.evaluateField(`${field.object}.${field.field}`);
            // evaluateField.readable includes object Read. For related objects,
            // check FLS separately: absence of the object grant must not turn an
            // explicitly granted or schema-required field into a false FLS error.
            const hasFieldRead = fieldGrant.schemaRequired === true || fieldGrant.permissionable === false || fieldGrant.readGrantedBy.length > 0;
            // Keep field security independent of the FROM object's permission.
            // A later org-verified object Read must not turn unchecked FLS green.
            if (!hasFieldRead) {
              missing.push({ object: field.object, field: field.field, reason: "FIELD_READ" });
            }
          }
          notes.push(mode.description);
          if (mode.enforcement === "NONE") notes.push("Missing Read access is an advisory for this system-mode query, not a confirmed runtime permission failure.");
          if (mode.enforcement === "INVALID") notes.push("This query clause is unsupported at this Apex API version.");
          if (person.incomplete) notes.push("Some assigned Permission Set metadata is missing; absence of grants is not conclusive.");
          if (person.externalSkipped) notes.push("Salesforce-owned Order Management Permission Set was excluded because its metadata is absent. A missing grant is a potential gap, not a confirmed runtime failure.");
          if (inventory.unresolved.length) notes.push("Some relationship fields could not be resolved.");
          if (inventory.limitations.length) notes.push("Some filter/sort expressions could not be fully evaluated.");
          // Repository missing grants are NOT confirmed denials. Defer final status
          // until Salesforce has had the opportunity to verify them.
          const status: ImpactStatus = missing.length || inventory.unresolved.length || inventory.limitations.length
            ? "REVIEW" : "NO_GAPS";
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
          effectiveMode: mode.effectiveMode,
          permissionEnforcement: mode.enforcement,
          ...(mode.apiVersion !== undefined ? { apiVersion: mode.apiVersion } : {}),
          checkedFields: inventory.fields,
          unresolvedFields: inventory.unresolved,
          limitations: inventory.limitations,
          personas: impacts,
        });
      }
    }
    // XML first, Salesforce second, for BOTH object and field Read.
    // Cache identical requests across methods and queries. The verifier itself
    // caches per-user/per-object UserFieldAccess queries to prevent excessive API calls.
    const verifyRequests = new Map<string, {
      persona: Persona; object: string; field?: string
    }>();
    const requestKey = (persona: string, object: string, field?: string) =>
      `${persona.toLowerCase()}|${object.toLowerCase()}|${(field ?? "").toLowerCase()}`;
    for (const query of allQueries) for (const impact of query.personas) {
      const persona = prepared.find((person) => person.persona.name === impact.personaName)?.persona;
      if (!persona) continue;
      for (const missing of impact.missing) {
        verifyRequests.set(requestKey(persona.name, missing.object, missing.field), {
          persona, object: missing.object, ...(missing.field ? { field: missing.field } : {})
        });
      }
    }
    const orgResults = new Map<string, OrgObjectAccessEvidence>();
    if (this.orgVerifier) {
      const requests = [...verifyRequests.entries()];
      // Bound concurrency at the persona/field level; per-object FLS lookups are
      // also coalesced inside SalesforcePersonaAccessVerifier.
      for (let i = 0; i < requests.length; i += 3) {
        const batch = requests.slice(i, i + 3);
        const results = await Promise.all(batch.map(async ([key, request]) => {
          const evidence = request.field
            ? await this.orgVerifier!.resolveField(request.persona, request.object, request.field)
            : await this.orgVerifier!.verifyObject(request.persona, request.object);
          return [key, evidence] as const;
        }));
        for (const [key, result] of results) if (result) orgResults.set(key, result);
      }
    }

    for (const query of allQueries) for (const impact of query.personas) {
      const verified = [] as NonNullable<typeof impact.verifiedFromOrg>;
      const remaining: MissingReadPermission[] = [];
      const checkedUsers = new Map<string, OrgCheckedUser>();
      for (const missing of impact.missing) {
        const result = orgResults.get(requestKey(impact.personaName, missing.object, missing.field));
        // Keep checked identities even when Salesforce denies access or cannot
        // return a field permission. These are the users actually queried.
        for (const user of result?.checkedUserDetails ?? []) {
          checkedUsers.set(user.id.slice(0, 15), user);
        }
        if (result?.outcome === "VERIFIED") {
          verified.push({ object: result.object, ...(result.field ? { field: result.field } : {}),
            checkedUsers: result.checkedUsers, matchedUsers: result.matchedUsers,
            sampled: result.sampled, message: result.message });
        } else {
          remaining.push({ ...missing, orgOutcome: result?.outcome ?? "UNVERIFIED",
            orgMessage: result?.message ?? "Salesforce org verification is unavailable.",
            ...(result?.unverifiedReason ? { orgReason: result.unverifiedReason } : {}) });
        }
      }
      impact.missing = remaining;
      if (verified.length) impact.verifiedFromOrg = verified;
      if (checkedUsers.size) impact.orgCheckedUsers = [...checkedUsers.values()];
      const denied = remaining.some((item) => item.orgOutcome === "DENIED");
      // General static-analysis limitations remain visible in the query details,
      // but should not overwrite a completed object/field permission assessment.
      // Unresolved FIELD paths are different: their access was never evaluated.
      const unableToVerifyAccess = remaining.length > 0 || query.unresolvedFields.length > 0;
      // A verified object Read may be status-neutral (e.g. OrderItemSummary),
      // but this does not hide the Salesforce evidence or exempt any field Read.
      // All other org-verified permissions still make the result ORG_VERIFIED.
      const hasNonNeutralOrgVerification = verified.some((grant) =>
        !this.orgVerificationStatusPolicy || !isStatusNeutralOrgObjectRead(
          this.orgVerificationStatusPolicy, grant.object, grant.field
        )
      );
      const permissionEnforced = query.permissionEnforcement === "FULL" || query.permissionEnforcement === "SELECT_ONLY";
      // A denied grant is still recorded in missing[], but SYSTEM_MODE does not
      // enforce it as a runtime query failure. Unknown/invalid modes remain REVIEW.
      impact.status = denied && permissionEnforced ? "AT_RISK"
        : denied && query.permissionEnforcement === "NONE" ? "ADVISORY"
        : unableToVerifyAccess || query.permissionEnforcement === "INVALID" ? "REVIEW"
        : hasNonNeutralOrgVerification ? "ORG_VERIFIED" : "NO_GAPS";
    }
    allQueries.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);
    const traversalIncomplete = warnings.some((warning) =>
      warning.startsWith("Ambiguous overload") || warning.startsWith("Traversal limit")
    );
    const personas: StackPersonaImpact[] = prepared.map((p) => {
      const impacts = allQueries.map((query) => query.personas.find((item) => item.personaName === p.persona.name)!);
      const status: ImpactStatus = impacts.some((r) => r.status === "AT_RISK") ? "AT_RISK"
        : (!impacts.length || traversalIncomplete || impacts.some((r) => r.status === "REVIEW")) ? "REVIEW"
        : impacts.some((r) => r.status === "ADVISORY") ? "ADVISORY"
        : impacts.some((r) => r.status === "ORG_VERIFIED") ? "ORG_VERIFIED" : "NO_GAPS";
      const found = new Map<string, MissingReadPermission>();
      const checkedUsers = new Map<string, OrgCheckedUser>();
      for (const impact of impacts) {
        for (const missing of impact.missing) found.set(
          `${missing.object}.${missing.field ?? ""}.${missing.reason}`.toLowerCase(), missing
        );
        for (const user of impact.orgCheckedUsers ?? []) checkedUsers.set(user.id.slice(0, 15), user);
      }
      return {
        personaName: p.persona.name, status,
        atRiskQueries: impacts.filter((r) => r.status === "AT_RISK").length,
        reviewQueries: impacts.filter((r) => r.status === "REVIEW").length,
        advisoryQueries: impacts.filter((r) => r.status === "ADVISORY").length,
        missing: [...found.values()],
        ...(checkedUsers.size ? { orgCheckedUsers: [...checkedUsers.values()] } : {}),
        verifiedFromOrg: impacts.flatMap((impact) => impact.verifiedFromOrg ?? [])
          .filter((value, index, list) => list.findIndex((other) =>
            other.object.toLowerCase() === value.object.toLowerCase() &&
            (other.field ?? "").toLowerCase() === (value.field ?? "").toLowerCase()) === index),
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
        advisory: personas.filter((p) => p.status === "ADVISORY").length,
        noGaps: personas.filter((p) => p.status === "NO_GAPS").length,
        orgVerified: personas.filter((p) => p.status === "ORG_VERIFIED").length,
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

