import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
import type { SoqlQuery, SoqlSubquery } from "../models/SoqlQuery.js";
import type { ResolvedQueryField } from "../models/StackTraceImpact.js";
import { isIgnoredField } from "./soqlSystemFields.js";
import { extractSoqlExpressionFields, type SoqlFieldContext } from "./soqlExpressionInventory.js";
import type { RelationshipMap } from "./salesforceRelationshipResolver.js";
import { maskNestedSelects } from "./nestedSoqlScopes.js";

export interface ScopedFieldReference extends ResolvedQueryField {
  lineNumber: number;
  queryLineNumber: number;
  relationshipPath: string;
  usageContext?: SoqlFieldContext;
  functionName?: string;
}
export interface UnresolvedQueryReference {
  kind: "FIELD" | "RELATIONSHIP";
  baseObject: string;
  fieldPath: string;
  lineNumber: number;
  relationshipPath: string;
  message: string;
}
export interface QueryFieldCollection {
  scopes: Array<{ object: string; lineNumber: number; relationshipPath: string }>;
  fields: ResolvedQueryField[];
  references: ScopedFieldReference[];
  objects: string[];
  queriedObjects: string[];
  unresolved: string[];
  unresolvedEntries: UnresolvedQueryReference[];
  limitations: string[];
}


/**
 * Apex bind values belong to Apex, not SOQL. In particular,
 * :new Set<String>{...} contains < and > tokens that must NOT be
 * parsed as SOQL comparison operators or field paths.
 *
 * Mask only the bind operand, preserve all offsets/newlines and leave
 * subsequent AND/OR and clause keywords visible for normal analysis.
 */
export function maskApexBindExpressions(clause: string): string {
  const characters = clause.split("");
  const masked = clause.split("");
  const n = clause.length;
  const isIdentifierStart = (char: string | undefined) => char !== undefined && /[A-Za-z_]/.test(char);
  const isIdentifierPart = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (characters[i] !== "\n" && characters[i] !== "\r") masked[i] = " ";
  };
  const skipSpace = (start: number) => {
    let i = start;
    while (i < n && /\s/.test(characters[i])) i++;
    return i;
  };
  const identifier = (start: number): number => {
    if (!isIdentifierStart(characters[start])) return start;
    let i = start + 1;
    while (isIdentifierPart(characters[i])) i++;
    return i;
  };
  const balanced = (start: number): number => {
    const endings: Record<string, string> = { "<": ">", "(": ")", "{": "}", "[": "]" };
    const stack = [endings[characters[start]]];
    for (let i = start + 1; i < n; i++) {
      const current = characters[i];
      if (current in endings) stack.push(endings[current]);
      else if (current === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return i + 1;
      }
    }
    // An unfinished Apex bind isn't valid SOQL. Retain it as unverified
    // rather than interpreting pieces of an initializer as object fields.
    return n;
  };

  for (let i = 0; i < n; i++) {
    if (characters[i] !== ":") continue;
    const begin = i;
    let next = skipSpace(i + 1);
    if (!isIdentifierStart(characters[next])) continue;
    let end = identifier(next);
    if (clause.slice(next, end).toLowerCase() === "new") {
      next = skipSpace(end);
      if (!isIdentifierStart(characters[next])) continue;
      end = identifier(next);
    }
    for (;;) {
      const at = skipSpace(end);
      const token = characters[at];
      if (token === "." && isIdentifierStart(characters[at + 1])) {
        end = identifier(at + 1);
        continue;
      }
      if (token === "<" || token === "(" || token === "{" || token === "[") {
        end = balanced(at);
        continue;
      }
      break;
    }
    blank(begin, end);
    i = Math.max(i, end - 1);
  }
  return masked.join("");
}

function clauseFields(query: string, kind: "WHERE" | "ORDER BY" | "GROUP BY" | "HAVING"): string[] {
  const scope = maskNestedSelects(query);
  const startPattern = kind === "WHERE" ? /\bWHERE\b/i :
    kind === "ORDER BY" ? /\bORDER\s+BY\b/i :
    kind === "GROUP BY" ? /\bGROUP\s+BY\b/i : /\bHAVING\b/i;
  const matched = startPattern.exec(scope);
  if (!matched) return [];
  const rest = scope.slice(matched.index + matched[0].length);
  const end = /\b(?:WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|WITH\s+(?:USER_MODE|SYSTEM_MODE|SECURITY_ENFORCED)|FOR\s+UPDATE)\b/i.exec(rest);
  const clause = maskApexBindExpressions(end ? rest.slice(0, end.index) : rest);
  const names: string[] = [];
  if (kind === "WHERE" || kind === "HAVING") {
    const pattern = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:=|!=|<>|>=|<=|>|<|\b(?:NOT\s+)?(?:IN|LIKE|INCLUDES|EXCLUDES)\b)/gi;
    for (const match of clause.matchAll(pattern)) names.push(match[1]);
  } else {
    for (const item of clause.split(",")) {
      const trimmed = item.trim();
      // A function name is not a fallback field. The parser limitation
      // explicitly records that it could not analyze the expression.
      if (/^[A-Za-z_]\w*\s*\(/.test(trimmed)) continue;
      const match = trimmed.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/);
      if (match) names.push(match[1]);
    }
  }
  return [...new Set(names)];
}

function scopeFieldLine(text: string, lineNumber: number, field: string,
  context?: SoqlFieldContext, maskedScope?: string): number {
  const visible = maskedScope ?? maskNestedSelects(text);
  const safe = field.replace(/[^A-Za-z0-9_]/g, "\\$&");
  const pattern = new RegExp("\\b" + safe + "\\b", "i");
  const clauses: Record<SoqlFieldContext, RegExp> = {
    SELECT: /\bSELECT\b/i, WHERE: /\bWHERE\b/i,
    GROUP_BY: /\bGROUP\s+BY\b/i, HAVING: /\bHAVING\b/i,
    ORDER_BY: /\bORDER\s+BY\b/i,
  };
  const beginsAt = context ? clauses[context].exec(visible) : null;
  const offset = beginsAt ? beginsAt.index + beginsAt[0].length : 0;
  const match = pattern.exec(visible.slice(offset));
  const absolute = match ? offset + match.index : pattern.exec(visible)?.index;
  return absolute === undefined ? lineNumber
    : lineNumber + text.slice(0, absolute).split("\n").length - 1;
}

/** Shared recursive scope resolver for SOQL Security and Stack Trace analyzers. */
export function collectQueryFields(query: SoqlQuery, relationships: RelationshipMap): QueryFieldCollection {
  const deduplicated = new Map<string, ResolvedQueryField>();
  const references: ScopedFieldReference[] = [];
  const objects = new Set<string>([query.object]);
  const queriedObjects = new Set<string>([query.object]);
  const unresolvedEntries: UnresolvedQueryReference[] = [];
  const limitations: string[] = [];
  const scopes: QueryFieldCollection["scopes"] = [];
  // Rich SELECTs may have dozens of field references. Reusing the masked
  // scope avoids rescanning/parsing its nested subqueries once per field.
  const maskedScopes = new Map<string, string>();
  const masked = (text: string): string => {
    let value = maskedScopes.get(text);
    if (value === undefined) {
      value = maskNestedSelects(text);
      maskedScopes.set(text, value);
    }
    return value;
  };
  const unresolved = (kind: "FIELD" | "RELATIONSHIP", baseObject: string,
    fieldPath: string, lineNumber: number, path: string, message: string): void => {
    if (isDataAccessAnalysisObject(baseObject)) {
      unresolvedEntries.push({ kind, baseObject, fieldPath, lineNumber, relationshipPath: path, message });
    }
  };

  const add = (baseObject: string, fieldPath: string, source: string,
    text: string, lineNumber: number, path: string,
    usageContext?: SoqlFieldContext, functionName?: string): void => {
    const candidate = fieldPath.trim();
    if (!candidate || !isDataAccessAnalysisObject(baseObject)) return;
    const resolved = relationships.resolveField(baseObject, candidate);
    if (!resolved) {
      unresolved("FIELD", baseObject, candidate, lineNumber, path,
        relationships.explainUnresolved(baseObject, candidate));
      return;
    }
    if (!isDataAccessAnalysisObject(resolved.object)) return;
    for (const object of resolved.objects) {
      if (isDataAccessAnalysisObject(object)) objects.add(object);
    }
    if (resolved.polymorphicNamePseudoField) {
      // Name is a non-queryable, non-permissionable polymorphic descriptor:
      // check the originating object Read, never User/Group fields nor a
      // synthetic Name object Read. Metadata validation happened in resolver.
      return;
    }
    if (isIgnoredField(resolved.field, resolved.object)) return;
    const field: ScopedFieldReference = {
      object: resolved.object, field: resolved.field, source,
      lineNumber: scopeFieldLine(text, lineNumber, candidate, usageContext, masked(text)),
      queryLineNumber: query.lineNumber, relationshipPath: path,
      ...(usageContext ? { usageContext } : {}),
      ...(functionName ? { functionName } : {}),
    };
    references.push(field);
    const key = (resolved.object + "." + resolved.field).toLowerCase();
    if (!deduplicated.has(key)) deduplicated.set(key, {
      object: resolved.object, field: resolved.field, source,
    });
  };

  const scope = (object: string, fields: string[], children: SoqlSubquery[],
    text: string, lineNumber: number, relationshipPath: string, depth: number): void => {
    if (!isDataAccessAnalysisObject(object)) return;
    scopes.push({ object, lineNumber, relationshipPath });
    if (depth > 20) {
      limitations.push("Nested query traversal limit exceeded at " + relationshipPath);
      return;
    }
    const expressions = extractSoqlExpressionFields(text);
    limitations.push(...expressions.limitations.map((message) => message + " at " + relationshipPath));
    if (expressions.parsed) {
      for (const ref of expressions.fields) {
        const source = ref.context === "SELECT" ? ref.fieldPath
          : (ref.context === "GROUP_BY" ? "GROUP BY"
            : ref.context === "ORDER_BY" ? "ORDER BY" : ref.context) + " " + ref.fieldPath;
        add(object, ref.fieldPath, source, text, lineNumber, relationshipPath,
          ref.context, ref.functionName);
      }
    } else {
      // Retain proven bare field references on parser failure, but make the
      // unparsed syntax a visible Review item (never a clean result).
      for (const field of fields) add(object, field, field, text, lineNumber, relationshipPath, "SELECT");
      for (const name of ["WHERE", "ORDER BY", "GROUP BY", "HAVING"] as const) {
        const usageContext = name.replace(" ", "_") as SoqlFieldContext;
        for (const field of clauseFields(text, name)) {
          add(object, field, name + " " + field, text, lineNumber, relationshipPath, usageContext);
        }
      }
    }
    for (const childQuery of children) {
      const isJoin = childQuery.kind === "SEMI_JOIN" || childQuery.kind === "ANTI_JOIN";
      const childObject = isJoin ? childQuery.relationshipName : relationships.childObject(object, childQuery.relationshipName);
      const childPath = relationshipPath + " -> " + childQuery.relationshipName;
      const nestedLine = childQuery.lineNumber ?? lineNumber;
      if (!childObject) {
        unresolved("RELATIONSHIP", object, childQuery.relationshipName, nestedLine, childPath,
          "Could not resolve child relationship " + object + "." + childQuery.relationshipName);
        continue;
      }
      if (!isDataAccessAnalysisObject(childObject)) continue;
      objects.add(childObject);
      queriedObjects.add(childObject);
      scope(childObject, childQuery.fields, childQuery.subqueries,
        childQuery.query ?? "", nestedLine, childPath, depth + 1);
    }
  };

  scope(query.object, query.fields, query.subqueries, query.query, query.lineNumber, query.object, 1);
  return {
    fields: [...deduplicated.values()], references, scopes,
    objects: [...objects].filter(isDataAccessAnalysisObject),
    queriedObjects: [...queriedObjects].filter(isDataAccessAnalysisObject),
    unresolved: [...new Set(unresolvedEntries.map(item => item.message))],
    unresolvedEntries, limitations: [...new Set(limitations)],
  };
}
