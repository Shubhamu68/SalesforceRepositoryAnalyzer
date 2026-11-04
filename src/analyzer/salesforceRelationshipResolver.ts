import { readdir, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { listPermissionabilitySnapshotFields } from "./fieldPermissionability.js";

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
}

export interface ResolvedFieldPath {
  object: string;
  field: string;
  // Include each object along the relationship path for object permission checks.
  objects: string[];
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
  version: 1;
  objects: Record<string, { parents?: SnapshotParent[]; children?: SnapshotChild[] }>;
}

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

  registerObject(name: string): void {
    if (name.trim()) this.objectNames.set(norm(name), name);
  }

  addParent(child: string, relationship: string, targets: string[], sourceField: string): void {
    if (!child || !relationship || !targets.length) return;
    this.registerObject(child);
    for (const target of targets) this.registerObject(target);
    const key = norm(child);
    const entries = this.parentEdges.get(key) ?? new Map<string, ParentEdge>();
    // Org Describe data is applied last and supersedes inferred/repository metadata.
    entries.set(norm(relationship), { targets: [...new Set(targets)], sourceField });
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

  /** Return undefined for absent or polymorphic/ambiguous relationships. */
  parentObject(child: string, relationship: string): string | undefined {
    const targets = this.parentEdges.get(norm(child))?.get(norm(relationship))?.targets;
    return targets?.length === 1 ? targets[0] : undefined;
  }

  childObject(parent: string, relationship: string): string | undefined {
    const targets = this.childEdges.get(norm(parent))?.get(norm(relationship))?.targets;
    return targets?.length === 1 ? targets[0] : undefined;
  }

  /** Explain the first relationship hop that cannot be established safely. */
  explainUnresolved(baseObject: string, fieldPath: string): string {
    const parts = fieldPath.split(".").map((part) => part.trim());
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
    const parts = fieldPath.split(".").map((part) => part.trim());
    if (!parts.length || parts.some((part) => !/^[A-Za-z_]\w*$/.test(part))) return undefined;
    let object = this.objectNames.get(norm(baseObject)) ?? baseObject;
    const objects = [object];
    for (const relationship of parts.slice(0, -1)) {
      const parent = this.parentObject(object, relationship);
      if (!parent) return undefined;
      object = parent;
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
export async function buildRelationshipMap(objectsDirectory: string): Promise<RelationshipMap> {
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
    for (const fieldEntry of fieldEntries) {
      if (!fieldEntry.isFile() || !fieldEntry.name.endsWith(".field-meta.xml")) continue;
      const field = parser.parse(await readFile(path.join(fieldsDirectory, fieldEntry.name), "utf8")).CustomField;
      if (!field) continue;
      const targets = normalizeStringArray(field.referenceTo);
      if (!targets.length) continue;
      const sourceField = fieldEntry.name.slice(0, -".field-meta.xml".length);
      // SOQL parent relationship name for CustomField Foo__c is Foo__r.
      const parentName = sourceField.endsWith("__c") ? `${sourceField.slice(0, -3)}__r`
        : sourceField.endsWith("Id") ? sourceField.slice(0, -2) : undefined;
      if (parentName) graph.addParent(childObject, parentName, targets, sourceField);
      // XML relationshipName is the inverse parent-to-child relationship name.
      const childName = typeof field.relationshipName === "string" ? field.relationshipName.trim() : "";
      if (childName) for (const parent of targets) graph.addChild(parent, childName, childObject, sourceField);
    }
  }

  // The existing permissionability export contains field names for nine objects.
  // It can identify straightforward standard FooId -> Foo relationships without
  // inventing a parent for custom lookup fields or polymorphic references.
  const snapshotFields = listPermissionabilitySnapshotFields();
  const knownObjects = new Map<string, string>();
  for (const objectName of snapshotFields.keys()) {
    knownObjects.set(norm(objectName), objectName);
    graph.registerObject(objectName);
  }
  for (const [objectName, fields] of snapshotFields) {
    for (const fieldName of fields) {
      if (!fieldName.endsWith("Id") || fieldName === "Id") continue;
      const relationship = fieldName.slice(0, -2);
      if (graph.parentObject(objectName, relationship)) continue;
      const directTarget = knownObjects.get(norm(relationship));
      if (directTarget) graph.addParent(objectName, relationship, [directTarget], fieldName);
      // OriginalOrderItemId is a standard reference to OrderItem. Only infer
      // this when both the exact source field and OrderItem object are known.
      if (norm(relationship) === "originalorderitem" && knownObjects.has("orderitem")) {
        graph.addParent(objectName, relationship, [knownObjects.get("orderitem")!], fieldName);
      }
    }
  }

  const snapshotFile = path.resolve(process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH?.trim()
    || path.join(process.cwd(), "config", "relationship-schema.json"));
  if (existsSync(snapshotFile)) {
    let snapshot: RelationshipSnapshot;
    try { snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as RelationshipSnapshot; }
    catch (error) { throw new Error(`Could not parse relationship snapshot ${snapshotFile}: ${String(error)}`); }
    if (snapshot.version !== 1 || !snapshot.objects || typeof snapshot.objects !== "object") {
      throw new Error(`Invalid relationship snapshot format at ${snapshotFile}`);
    }
    for (const [objectName, details] of Object.entries(snapshot.objects)) {
      graph.registerObject(objectName);
      for (const rel of details.parents ?? []) {
        if (rel.relationshipName && rel.referenceTo?.length) {
          graph.addParent(objectName, rel.relationshipName, rel.referenceTo, rel.sourceField);
        }
      }
      for (const rel of details.children ?? []) {
        if (rel.relationshipName && rel.childObject) {
          graph.addChild(objectName, rel.relationshipName, rel.childObject, rel.sourceField);
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
