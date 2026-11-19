import { readdir, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { recordSoqlCount } from "../services/SoqlPerformanceMetrics.js";

const parser = new XMLParser({ ignoreAttributes: true });
const norm = (value: string) => value.trim().toLowerCase();

export interface RelationshipMetadata {
  relationshipName: string;
  sourceField: string;
  childObject: string;
  targetObjects: string[];
}

interface ParentEdge {
  targets: string[];
  sourceField: string;
  /** From Salesforce Describe; required to identify the polymorphic Name pseudo-object safely. */
  namePointing?: boolean;
  polymorphicForeignKey?: boolean;
}

export interface ResolvedFieldPath {
  object: string;
  field: string;
  // Include each object along the relationship path for object permission checks.
  objects: string[];
  /** A validated field on Salesforce's non-queryable polymorphic Name descriptor.
   * No separate field-level permission is configurable on this descriptor.
   * Keep the source object's Read check; do not guess a concrete target.
   */
  polymorphicNamePseudoField?: boolean;
}

interface SnapshotParent {
  relationshipName: string;
  sourceField: string;
  referenceTo: string[];
}
interface SnapshotChild {
  relationshipName: string;
  childObject: string;
  sourceField?: string;
}
interface RelationshipSnapshot {
  version: 2;
  organizationId: string;
  capturedAt: string;
  objects: Record<string, { parents?: SnapshotParent[]; children?: SnapshotChild[] }>;
}

export interface RelationshipMetadataScope {
  /** True means a selected org is in use; offline-org override is never used. */
  connected?: boolean;
  organizationId?: string;
}
const orgIdPattern = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CACHE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const sameOrg = (a: string, b: string): boolean =>
  a.slice(0, 15).toLowerCase() === b.slice(0, 15).toLowerCase();

/**
 * Contains BOTH directions of Salesforce relationships.
 * The Map inherited for backwards compatibility represents parent -> child
 * (for SOQL subqueries). `parentEdges` is child -> parent for dotted SELECT paths.
 * No traversal-depth cutoff is imposed by this resolver.
 */
export class RelationshipMap extends Map<string, Map<string, RelationshipMetadata>> {
  private readonly parentEdges = new Map<string, Map<string, ParentEdge>>();
  private readonly childEdges = new Map<string, Map<string, { targets: string[] }>>();
  private readonly objectNames = new Map<string, string>();
  // Populated from the current org's REST Describe("Name"), never inferred
  // from identically named fields on User/Group/Contact/etc.
  private readonly supportedPolymorphicNameFields = new Set<string>();

  registerPolymorphicNameFields(fields: readonly string[]): void {
    for (const field of fields) {
      if (field && /^[A-Za-z_]\w*$/.test(field)) {
        this.supportedPolymorphicNameFields.add(norm(field));
      }
    }
  }

  registerObject(name: string): void {
    if (name.trim()) this.objectNames.set(norm(name), name);
  }

  addParent(
    child: string, relationship: string, targets: string[], sourceField: string,
    options: { namePointing?: boolean; polymorphicForeignKey?: boolean } = {}
  ): void {
    if (!child || !relationship || !targets.length) return;
    this.registerObject(child);
    for (const target of targets) this.registerObject(target);
    const key = norm(child);
    const entries = this.parentEdges.get(key) ?? new Map<string, ParentEdge>();
    // Org Describe data is applied last and supersedes inferred/repository metadata.
    entries.set(norm(relationship), { targets: [...new Set(targets)], sourceField, ...options });
    this.parentEdges.set(key, entries);
  }

  addChild(parent: string, relationship: string, child: string, sourceField = ""): void {
    if (!parent || !relationship || !child) return;
    this.registerObject(parent);
    this.registerObject(child);
    const key = norm(parent);
    const edges = this.childEdges.get(key) ?? new Map<string, { targets: string[] }>();
    const edgeKey = norm(relationship);
    const prior = edges.get(edgeKey)?.targets ?? [];
    edges.set(edgeKey, { targets: [...new Set([...prior, child])] });
    this.childEdges.set(key, edges);

    // Preserve the previous public Map structure used by inventory consumers.
    const existingKey = [...this.keys()].find((name) => norm(name) === key) ?? parent;
    const children = this.get(existingKey) ?? new Map<string, RelationshipMetadata>();
    children.set(relationship, {
      relationshipName: relationship, sourceField, childObject: child, targetObjects: [parent],
    });
    this.set(existingKey, children);
  }

  /** All targets, without guessing one for polymorphic relationships. */
  parentTargets(child: string, relationship: string): string[] | undefined {
    return this.parentEdges.get(norm(child))?.get(norm(relationship))?.targets;
  }

  /** Return undefined for absent or polymorphic/ambiguous relationships. */
  parentObject(child: string, relationship: string): string | undefined {
    const targets = this.parentEdges.get(norm(child))?.get(norm(relationship))?.targets;
    return targets?.length === 1 ? targets[0] : undefined;
  }

  childObject(parent: string, relationship: string): string | undefined {
    const targets = this.childEdges.get(norm(parent))?.get(norm(relationship))?.targets;
    return targets?.length === 1 ? targets[0] : undefined;
  }

  /**
   * An explicit root object qualifier (OrderSummary.Client__c when already
   * inside OrderSummary) is not a parent relationship. Strip only that exact
   * prefix, and only if metadata does not define a real relationship with
   * that name. Child-to-parent paths such as OrderItemSummary.OrderSummary.Client__c
   * continue traversing the actual OrderSummary edge.
   */
  private fieldParts(baseObject: string, fieldPath: string): string[] {
    const parts = fieldPath.split(".").map((part) => part.trim());
    const root = norm(baseObject);
    if (parts.length > 1 && norm(parts[0]) === root &&
        !this.parentEdges.get(root)?.has(root)) {
      return parts.slice(1);
    }
    return parts;
  }

  /** Explain the first relationship hop that cannot be established safely. */
  explainUnresolved(baseObject: string, fieldPath: string): string {
    const parts = this.fieldParts(baseObject, fieldPath);
    let object = this.objectNames.get(norm(baseObject)) ?? baseObject;
    for (const name of parts.slice(0, -1)) {
      const edge = this.parentEdges.get(norm(object))?.get(norm(name));
      if (!edge) return `${object}.${name} (relationship metadata unavailable)`;
      if (edge.targets.length !== 1) {
        return `${object}.${name} (ambiguous targets: ${edge.targets.join(", ")})`;
      }
      object = edge.targets[0];
    }
    return `${baseObject}.${fieldPath} (invalid/unsupported field path)`;
  }

  resolveField(baseObject: string, fieldPath: string): ResolvedFieldPath | undefined {
    const parts = this.fieldParts(baseObject, fieldPath);
    if (!parts.length || parts.some((part) => !/^[A-Za-z_]\w*$/.test(part))) return undefined;
    let object = this.objectNames.get(norm(baseObject)) ?? baseObject;
    const objects = [object];
    for (let hop = 0; hop < parts.length - 1; hop++) {
      const relationship = parts[hop];
      const edge = this.parentEdges.get(norm(object))?.get(norm(relationship));
      if (!edge) return undefined;
      if (edge.targets.length !== 1) {
        // Salesforce exposes common fields such as Owner.Name through the
        // polymorphic, non-queryable Name pseudo-object (User OR Group).
        // Name has no configurable FLS grant. Do NOT pick User or Group, and
        // do NOT extrapolate this to Owner.Email or further relationship hops.
        const terminalName = hop === parts.length - 2 && norm(parts[parts.length - 1]) === "name";
        const sfNameReference = edge.namePointing === true || edge.polymorphicForeignKey === true;
        const ownerUserOrGroup = norm(relationship) === "owner" &&
          edge.targets.length === 2 &&
          edge.targets.some((target) => norm(target) === "user") &&
          edge.targets.some((target) => norm(target) === "group");
        if (terminalName && (sfNameReference || ownerUserOrGroup)) {
          return { object: "Name", field: "Name", objects };
        }
        // Type (polymorphic discriminator) and IsActive are fields on the
        // non-queryable Salesforce Name pseudo-object. Verify against live
        // Describe("Name"); do not classify User.Type or Group.IsActive as FLS.
        // Other Name properties remain unresolved until separately assessed.
        const terminal = norm(parts[parts.length - 1]);
        if (hop === parts.length - 2 &&
            (terminal === "type" || terminal === "isactive") &&
            (sfNameReference || ownerUserOrGroup) &&
            this.supportedPolymorphicNameFields.has(terminal)) {
          return {
            object: "Name", field: parts[parts.length - 1], objects,
            polymorphicNamePseudoField: true,
          };
        }
        return undefined;
      }
      object = edge.targets[0];
      objects.push(object);
    }
    return { object, field: parts[parts.length - 1], objects };
  }
}

/**
 * Load repository relationships, safe standard Id-based inferences, and optional
 * Salesforce Describe metadata. The latter is authoritative for standard and
 * renamed relationships missing from the local repository.
 */
export async function buildRelationshipMap(
  objectsDirectory: string,
  scope: RelationshipMetadataScope = {},
): Promise<RelationshipMap> {
  const graph = new RelationshipMap();
  let entries;
  try {
    entries = await readdir(objectsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot load Salesforce object metadata from ${objectsDirectory}: ${String(error)}`);
  }
  for (const objectEntry of entries) {
    if (!objectEntry.isDirectory()) continue;
    const childObject = objectEntry.name;
    graph.registerObject(childObject);
    const fieldsDirectory = path.join(objectsDirectory, childObject, "fields");
    let fieldEntries;
    try { fieldEntries = await readdir(fieldsDirectory, { withFileTypes: true }); }
    catch { continue; }
    // Read/parse field XML with bounded IO concurrency, then apply edges in
    // original directory order. This avoids thousands of serial file reads
    // without changing relationship override/ambiguity semantics.
    const fieldFiles = fieldEntries.filter((entry) =>
      entry.isFile() && entry.name.endsWith(".field-meta.xml"));
    recordSoqlCount("relationships.field_xml", fieldFiles.length);
    for (let offset = 0; offset < fieldFiles.length; offset += 12) {
      const batch = fieldFiles.slice(offset, offset + 12);
      const parsed = await Promise.all(batch.map(async (entry) => ({
        name: entry.name,
        field: parser.parse(await readFile(path.join(fieldsDirectory, entry.name), "utf8")).CustomField,
      })));
      for (const { name, field } of parsed) {
        if (!field) continue;
        const targets = normalizeStringArray(field.referenceTo);
        if (!targets.length) continue;
        const sourceField = name.slice(0, -".field-meta.xml".length);
        // SOQL parent relationship name for CustomField Foo__c is Foo__r.
        const parentName = sourceField.endsWith("__c") ? `${sourceField.slice(0, -3)}__r`
          : sourceField.endsWith("Id") ? sourceField.slice(0, -2) : undefined;
        if (parentName) graph.addParent(childObject, parentName, targets, sourceField);
        // XML relationshipName is the inverse parent-to-child relationship name.
        const childName = typeof field.relationshipName === "string" ? field.relationshipName.trim() : "";
        if (childName) for (const parent of targets) graph.addChild(parent, childName, childObject, sourceField);
      }
    }
  }

  // Relationship evidence comes from repository CustomField metadata or
  // Salesforce Describe / an explicitly configured project-specific schema.
  // Never infer standard edges from an unrelated org's permissionability list.

  // A project-specific relationship export is OPTIONAL and never picked up
  // implicitly from the Analyzer's config directory. It must match the actual
  // selected org (or an explicitly stated offline target org).
  const selectedPath = process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH?.trim();
  const expectedOrg = scope.connected ? scope.organizationId
    : process.env.FIELD_METADATA_OFFLINE_ORG_ID?.trim();
  if (selectedPath && expectedOrg && orgIdPattern.test(expectedOrg)) {
    const snapshotFile = path.resolve(selectedPath);
    if (existsSync(snapshotFile)) {
      let snapshot: RelationshipSnapshot | undefined;
      try {
        const parsed = JSON.parse(readFileSync(snapshotFile, "utf8")) as RelationshipSnapshot;
        const timestamp = Date.parse(parsed.capturedAt);
        const age = Date.now() - timestamp;
        if (parsed.version === 2 && typeof parsed.organizationId === "string" &&
          orgIdPattern.test(parsed.organizationId) && sameOrg(parsed.organizationId, expectedOrg) &&
          Number.isFinite(timestamp) && age >= -5 * 60_000 && age <= CACHE_AGE_MS &&
          parsed.objects && typeof parsed.objects === "object" && !Array.isArray(parsed.objects)) {
          snapshot = parsed;
        }
      } catch {
        // Malformed optional cache cannot override repository metadata.
      }
      if (snapshot) {
        for (const [objectName, details] of Object.entries(snapshot.objects)) {
          if (!namePattern.test(objectName) || !details || typeof details !== "object") continue;
          graph.registerObject(objectName);
          for (const rel of Array.isArray(details.parents) ? details.parents : []) {
            if (namePattern.test(rel.relationshipName) &&
              Array.isArray(rel.referenceTo) && rel.referenceTo.length > 0 &&
              rel.referenceTo.every(target => namePattern.test(target)) &&
              !graph.parentTargets(objectName, rel.relationshipName)) {
              graph.addParent(objectName, rel.relationshipName, rel.referenceTo, rel.sourceField ?? "");
            }
          }
          for (const rel of Array.isArray(details.children) ? details.children : []) {
            if (namePattern.test(rel.relationshipName) && namePattern.test(rel.childObject) &&
              !graph.childObject(objectName, rel.relationshipName)) {
              graph.addChild(objectName, rel.relationshipName, rel.childObject, rel.sourceField ?? "");
            }
          }
        }
      }
    }
  }
  return graph;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}
