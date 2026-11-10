import type { SoqlQuery, SoqlSubquery } from "../models/SoqlQuery.js";
import type { RelationshipMap } from "../analyzer/salesforceRelationshipResolver.js";
import { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";

/**
 * Enrich an analysis-local RelationshipMap from live REST sObject Describe.
 * Fetch only objects actually needed by a query; each Describe is cached by
 * SalesforceOrgConnection and each map is populated once per object.
 * Incomplete Describe access never implies a permission denial.
 */
export class SalesforceRelationshipMetadataService {
  constructor(private readonly connection: SalesforceOrgConnection) {}

  createHydrator(graph: RelationshipMap): {
    hydrateQuery(query: SoqlQuery, unresolvedPaths?: string[]): Promise<string[]>;
  } {
    const loaded = new Set<string>();
    const warnings = new Set<string>();

    const load = async (objectName: string): Promise<void> => {
      const key = objectName.toLowerCase();
      if (loaded.has(key)) return;
      loaded.add(key);
      try {
        const description = await this.connection.describeSObject(objectName);
        graph.registerObject(objectName);
        for (const field of description.fields) {
          if (!field.relationshipName || !Array.isArray(field.referenceTo) || !field.referenceTo.length) continue;
          graph.addParent(objectName, field.relationshipName, field.referenceTo, field.name, {
            namePointing: field.namePointing === true,
            polymorphicForeignKey: field.polymorphicForeignKey === true,
          });
        }
        for (const child of description.childRelationships) {
          if (child.relationshipName && child.childSObject) {
            graph.addChild(objectName, child.relationshipName, child.childSObject, child.field ?? "");
          }
        }
      } catch {
        warnings.add(`Could not retrieve Salesforce relationship Describe for ${objectName}; local metadata was retained.`);
      }
    };

    const followField = async (baseObject: string, fieldPath: string): Promise<void> => {
      const parts = fieldPath.trim().replace(/^(?:WHERE|ORDER BY)\s+/i, "").split(".");
      if (parts.length < 2 || parts.some((part) => !/^[A-Za-z_]\w*$/.test(part))) return;
      let current = baseObject;
      for (let i = 0; i < parts.length - 1; i++) {
        await load(current);
        const targets = graph.parentTargets(current, parts[i]);
        // Only traverse a relationship when the target is unambiguous.
        // Salesforce's Name pseudo-object handles the final polymorphic .Name.
        if (!targets || targets.length !== 1) break;
        current = targets[0];
      }
    };

    const followChildren = async (parentObject: string, subqueries: SoqlSubquery[]): Promise<void> => {
      await load(parentObject);
      for (const subquery of subqueries) {
        const child = graph.childObject(parentObject, subquery.relationshipName);
        if (!child) continue;
        for (const field of subquery.fields) await followField(child, field);
        await followChildren(child, subquery.subqueries);
      }
    };

    return {
      hydrateQuery: async (query: SoqlQuery, unresolvedPaths: string[] = []): Promise<string[]> => {
        warnings.clear();
        await load(query.object);
        for (const field of query.fields) await followField(query.object, field);
        await followChildren(query.object, query.subqueries);
        // Include fields referenced in WHERE / ORDER BY that the static
        // collector couldn't resolve on the first pass.
        const prefix = `${query.object}.`;
        for (const unresolved of unresolvedPaths) {
          const source = unresolved.split(" — ", 1)[0];
          if (source.toLowerCase().startsWith(prefix.toLowerCase())) {
            await followField(query.object, source.slice(prefix.length));
          }
        }
        return [...warnings];
      },
    };
  }
}
