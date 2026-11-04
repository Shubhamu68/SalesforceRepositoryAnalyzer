import type { SoqlQuery, SoqlSubquery } from "../models/SoqlQuery.js";
import type { ResolvedQueryField } from "../models/StackTraceImpact.js";
import { isAggregateExpression, isIgnoredField } from "./soqlSystemFields.js";
import type { RelationshipMap } from "./salesforceRelationshipResolver.js";
import { maskApex } from "../scanner/apexMethodScanner.js";

const unique = <T>(items: T[]) => [...new Set(items)];

export interface QueryFieldCollection {
  fields: ResolvedQueryField[];
  objects: string[];
  /** Objects explicitly named by FROM (root and nested child SELECTs). Not relationship traversal targets. */
  queriedObjects: string[];
  unresolved: string[];
  limitations: string[];
}

/** One relationship traversal engine for stack traces and full-repository SOQL analysis. */
export function collectQueryFields(query: SoqlQuery, relationships: RelationshipMap): QueryFieldCollection {
  const fields = new Map<string, ResolvedQueryField>();
  const objects = new Set<string>([query.object]);
  const queriedObjects = new Set<string>([query.object]);
  const unresolved: string[] = [];
  const limitations: string[] = [];
  const add = (baseObject: string, fieldPath: string, label = fieldPath) => {
    const candidate = fieldPath.trim();
    if (!candidate || isAggregateExpression(candidate)) return;
    const resolved = relationships.resolveField(baseObject, candidate);
    if (!resolved) {
      unresolved.push(`${baseObject}.${label} — ${relationships.explainUnresolved(baseObject, candidate)}`);
      return;
    }
    for (const object of resolved.objects) objects.add(object);
    if (isIgnoredField(resolved.field, resolved.object)) return;
    fields.set(`${resolved.object}.${resolved.field}`.toLowerCase(), {
      object: resolved.object, field: resolved.field, source: label,
    });
  };
  for (const field of query.fields) add(query.object, field);

  const traverseSubquery = (parent: string, subquery: SoqlSubquery) => {
    const child = relationships.childObject(parent, subquery.relationshipName);
    if (!child) {
      unresolved.push(`${parent}.(SELECT ... FROM ${subquery.relationshipName})`);
      return;
    }
    objects.add(child);
    queriedObjects.add(child);
    for (const field of subquery.fields) add(child, field, `${subquery.relationshipName}.${field}`);
    for (const nested of subquery.subqueries) traverseSubquery(child, nested);
  };
  for (const subquery of query.subqueries) traverseSubquery(query.object, subquery);

  // Preserve the prior stack analysis of simple WHERE / ORDER BY expressions.
  // Complex expressions remain unverified instead of being incorrectly approved.
  const withoutSubqueries = maskApex(query.query).replace(/\(\s*SELECT\b[\s\S]*?\)/gi, " ");
  const whereClause = withoutSubqueries.match(/\bWHERE\b([\s\S]*?)(?=\b(?:GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|WITH\s+(?:USER_MODE|SECURITY_ENFORCED|SYSTEM_MODE)|FOR\s+UPDATE)\b|$)/i)?.[1];
  if (whereClause) {
    let found = 0;
    const predicate = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:=|!=|<>|>=|<=|>|<|\b(?:NOT\s+)?(?:IN|LIKE|INCLUDES|EXCLUDES)\b)/gi;
    for (const match of whereClause.matchAll(predicate)) {
      add(query.object, match[1], `WHERE ${match[1]}`);
      found++;
    }
    if (!found || /\b(?:TYPEOF|DISTANCE|GEOLOCATION)\s*\(/i.test(whereClause)) {
      limitations.push("Complex WHERE expression may reference additional fields.");
    }
  }
  const orderClause = withoutSubqueries.match(/\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|OFFSET|WITH\s+(?:USER_MODE|SECURITY_ENFORCED|SYSTEM_MODE)|FOR\s+UPDATE)\b|$)/i)?.[1];
  if (orderClause) for (const part of orderClause.split(",")) {
    const item = part.trim().match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/);
    if (item) add(query.object, item[1], `ORDER BY ${item[1]}`);
    else limitations.push(`Unresolved ORDER BY expression: ${part.trim().slice(0, 60)}`);
  }
  if (/\b(?:GROUP\s+BY|HAVING|TYPEOF)\b/i.test(withoutSubqueries)) {
    limitations.push("GROUP BY, HAVING or TYPEOF requires manual field review.");
  }
  if (query.subqueries.length && /\(\s*SELECT[\s\S]*?\bWHERE\b/i.test(query.query)) {
    limitations.push("Child subquery filter fields require manual review.");
  }
  return { fields: [...fields.values()], objects: [...objects], queriedObjects: [...queriedObjects], unresolved: unique(unresolved), limitations: unique(limitations) };
}
