import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { SoqlQuery } from "../models/SoqlQuery.js";
import { buildRelationshipMap } from "./salesforceRelationshipResolver.js";
import { collectQueryFields } from "./soqlQueryFieldResolver.js";

export class ScopeSelectionError extends Error {}

export type SoqlRunMode = "FULL" | "SELECTIVE";

export interface SoqlScopeRequest {
  mode: SoqlRunMode;
  /** Repository-relative deployment manifest, e.g. manifest/package.xml. */
  manifestPath?: string;
  /** Salesforce metadata members, e.g. ApexClass:OrderService. */
  components?: string[];
}

export interface SoqlScopeSummary {
  mode: SoqlRunMode;
  manifestPath?: string;
  components: string[];
  totalQueriesFound: number;
  queriesSelected: number;
  warnings: string[];
  expandedToFull: boolean;
}

const TYPE_NAMES = new Set(["apexclass", "customobject", "customfield"]);
const ACCESS_TYPES = new Set(["permissionset", "permissionsetgroup", "profile", "mutingpermissionset"]);
const MAX_MEMBERS = 1000;
const MAX_MANIFEST_BYTES = 1_000_000;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const memberPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_*][A-Za-z0-9_*]*)?$/;

function mustBeString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ScopeSelectionError(field + " must be a string.");
  return value.trim();
}

export function normalizeSoqlScope(input: unknown): SoqlScopeRequest {
  if (input === undefined || input === null) return { mode: "FULL" };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ScopeSelectionError("scope must be an object.");
  const data = input as Record<string, unknown>;
  if (data.mode !== "FULL" && data.mode !== "SELECTIVE") throw new ScopeSelectionError("scope.mode must be FULL or SELECTIVE.");
  if (data.mode === "FULL") return { mode: "FULL" };
  const manifestPath = data.manifestPath === undefined ? undefined : mustBeString(data.manifestPath, "scope.manifestPath");
  const components = data.components === undefined ? [] : data.components;
  if (!Array.isArray(components) || components.length > MAX_MEMBERS ||
    components.some(value => typeof value !== "string" || value.length > 250)) {
    throw new ScopeSelectionError("scope.components must be an array of at most 1000 metadata member strings.");
  }
  if (!manifestPath && components.length === 0) {
    throw new ScopeSelectionError("Selective analysis requires a package.xml path or at least one metadata member.");
  }
  if (manifestPath && (manifestPath.length > 260 || path.isAbsolute(manifestPath) ||
    /^[A-Za-z]:/.test(manifestPath) || manifestPath.includes("\0") || manifestPath.split(/[\\/]/).includes(".."))) {
    throw new ScopeSelectionError("Manifest path must be a repository-relative file path.");
  }
  return { mode: "SELECTIVE", ...(manifestPath ? { manifestPath } : {}),
    components: components.map(value => (value as string).trim()) };
}

function normalizeMember(item: string): { type: string; name: string } {
  const match = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/.exec(item.trim());
  if (!match) throw new ScopeSelectionError("Invalid component selector: " + item + ". Use MetadataType:MemberName.");
  const [, type, rawName] = match;
  const name = rawName.trim();
  if (name !== "*" && !(type.toLowerCase() === "profile" ? /^[\w .-]+$/.test(name) : memberPattern.test(name))) {
    throw new ScopeSelectionError("Invalid Salesforce metadata member: " + item);
  }
  if (type.toLowerCase() === "customfield" && name !== "*" && !/^[A-Za-z_]\w*\.(?:[A-Za-z_]\w*|\*)$/.test(name)) {
    throw new ScopeSelectionError("CustomField must use Object.Field, Object.*, or *: " + item);
  }
  if (type.toLowerCase() === "apexclass" && name !== "*" && !identifier.test(name)) {
    throw new ScopeSelectionError("Invalid ApexClass name: " + name);
  }
  return { type, name };
}

async function readManifest(repositoryPath: string, relativePath: string): Promise<string[]> {
  const root = await realpath(repositoryPath);
  const absolute = path.resolve(repositoryPath, relativePath);
  const actual = await realpath(absolute);
  const relative = path.relative(root, actual);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new ScopeSelectionError("Manifest must resolve to a file inside the configured repository.");
  }
  const info = await stat(actual);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new ScopeSelectionError("Manifest must be an XML file smaller than 1 MB.");
  const data = await readFile(actual, "utf8");
  const valid = XMLValidator.validate(data);
  if (valid !== true) throw new ScopeSelectionError("Invalid package.xml XML structure.");
  const parsed = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(data) as {
    Package?: { types?: Array<{ name?: string; members?: string[] | string }> | { name?: string; members?: string[] | string } }
  };
  if (!parsed?.Package?.types) throw new ScopeSelectionError("Invalid package.xml: missing Package.types.");
  const groups = Array.isArray(parsed.Package.types) ? parsed.Package.types : [parsed.Package.types];
  const members: string[] = [];
  for (const group of groups) {
    if (typeof group.name !== "string") throw new ScopeSelectionError("Invalid package.xml: missing metadata type name.");
    const values = Array.isArray(group.members) ? group.members : [group.members];
    for (const value of values) {
      if (typeof value !== "string") throw new ScopeSelectionError("Invalid package.xml: missing members for " + group.name);
      members.push(group.name + ":" + value);
    }
  }
  if (members.length > MAX_MEMBERS) throw new ScopeSelectionError("Manifest exceeds 1000 members; use a full scan.");
  return members;
}

/**
 * Limit the analysis to the SOQL potentially affected by selected metadata.
 * Access grants and unsupported metadata deliberately broaden to full scanning:
 * a partial scan must never be presented as clean when we cannot scope it safely.
 */
export async function selectScopedSoqlQueries(
  repositoryPath: string,
  allQueries: SoqlQuery[],
  request: SoqlScopeRequest,
): Promise<{ queries: SoqlQuery[]; scope: SoqlScopeSummary }> {
  if (request.mode === "FULL") return {
    queries: allQueries,
    scope: { mode: "FULL", components: [], totalQueriesFound: allQueries.length,
      queriesSelected: allQueries.length, warnings: [], expandedToFull: false },
  };
  const raw = [
    ...(request.components ?? []),
    ...(request.manifestPath ? await readManifest(repositoryPath, request.manifestPath) : []),
  ];
  const selected = new Map<string, Set<string>>();
  const members: string[] = [];
  for (const rawMember of raw) {
    const { type, name } = normalizeMember(rawMember);
    const key = type.toLowerCase();
    const set = selected.get(key) ?? new Set<string>();
    set.add(name.toLowerCase());
    selected.set(key, set);
    members.push(type + ":" + name);
  }
  const warnings: string[] = [];
  let expandedToFull = false;
  const unsupported = [...selected.keys()].filter(type => !TYPE_NAMES.has(type));
  if (unsupported.length) {
    expandedToFull = true;
    warnings.push("Full SOQL scan applied: " + unsupported.join(", ") +
      " can affect access indirectly or is not yet modeled by selective dependency analysis.");
    if (unsupported.some(type => !ACCESS_TYPES.has(type))) {
      warnings.push("Only Apex .cls static SOQL is scanned; Flow, trigger and dynamic SOQL dependencies are not yet analyzed.");
    }
  }
  for (const [type, set] of selected) {
    if (set.has("*")) {
      expandedToFull = true;
      warnings.push("Wildcard in " + type + " expands analysis to all supported Apex SOQL.");
    }
  }
  if (expandedToFull) return {
    queries: allQueries,
    scope: { mode: "SELECTIVE", ...(request.manifestPath ? { manifestPath: request.manifestPath } : {}),
      components: [...new Set(members)], totalQueriesFound: allQueries.length,
      queriesSelected: allQueries.length, warnings, expandedToFull: true },
  };

  const apexNames = selected.get("apexclass") ?? new Set<string>();
  const objectNames = selected.get("customobject") ?? new Set<string>();
  const fieldNames = selected.get("customfield") ?? new Set<string>();
  const fieldObjects = new Set([...fieldNames].filter(name => name.endsWith(".*")).map(name => name.slice(0, -2)));
  const exactFields = new Set([...fieldNames].filter(name => !name.endsWith(".*")));
  const graph = (objectNames.size || fieldNames.size)
    ? await buildRelationshipMap(path.join(repositoryPath, "force-app", "main", "default", "objects"))
    : null;
  const chosen = allQueries.filter(query => {
    const baseName = path.basename(query.filePath, ".cls").toLowerCase();
    if (apexNames.has(baseName)) return true;
    if (!graph) return false;
    const found = collectQueryFields(query, graph);
    if (found.queriedObjects.some(name => objectNames.has(name.toLowerCase()))) return true;
    if (found.objects.some(name => objectNames.has(name.toLowerCase()) || fieldObjects.has(name.toLowerCase()))) return true;
    if (found.fields.some(field => exactFields.has((field.object + "." + field.field).toLowerCase()))) return true;
    // Unknown relationship targets may be impacted; include for REVIEW instead of hiding them.
    return found.unresolvedEntries.length > 0;
  });
  const result: SoqlScopeSummary = { mode: "SELECTIVE",
    ...(request.manifestPath ? { manifestPath: request.manifestPath } : {}),
    components: [...new Set(members)], totalQueriesFound: allQueries.length,
    queriesSelected: chosen.length, warnings, expandedToFull: false };
  if (chosen.length === 0) result.warnings.push("No static Apex SOQL matched these members. This is not proof that other metadata has no deployment impact.");
  return { queries: chosen, scope: result };
}
