import { parseQuery } from "@jetstreamapp/soql-parser-js";
import { normalizeApexBindExpressions } from "./apexBindNormalizer.js";

/** Read-relevant portions of SOQL: callers keep individual usages for security-mode decisions. */
export type SoqlFieldContext = "SELECT" | "WHERE" | "GROUP_BY" | "HAVING" | "ORDER_BY";
export interface SoqlExpressionField {
  fieldPath: string;
  context: SoqlFieldContext;
  functionName?: string;
}

export interface SoqlExpressionInventory {
  parsed: boolean;
  fields: SoqlExpressionField[];
  limitations: string[];
}

const FIELD_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const EXCLUDED_LITERALS = new Set(["null", "true", "false", "all", "custom", "standard", "undefined"]);
const ANALYZABLE_FUNCTIONS = new Set([
  "COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX",
  "GROUPING", "ROLLUP", "CUBE",
  "CALENDAR_YEAR", "CALENDAR_MONTH", "CALENDAR_QUARTER",
  "CALENDAR_WEEK", "DAY_IN_MONTH", "DAY_IN_WEEK", "DAY_IN_YEAR",
  "DAY_ONLY", "FISCAL_YEAR", "FISCAL_QUARTER",
  "HOUR_IN_DAY", "WEEK_IN_MONTH", "WEEK_IN_YEAR",
  "CONVERTCURRENCY", "FORMAT", "TOLABEL", "DISTANCE", "GEOLOCATION", "FORMULA",
]);
const INVALID_ALIAS = new Set(["select", "from", "where", "group", "having", "order"]);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/**
 * Backwards-compatible export for callers using the previous constructor-only
 * adapter. All Apex bind forms now use the same normalized parser view.
 */
export function normalizeApexConstructorBinds(query: string): string {
  return normalizeApexBindExpressions(query).query;
}

function readableDiagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Parse the actual query's expression tree, not the first identifier in each
 * clause. The root SELECT only is collected here: the existing scoped
 * traversal handles child subqueries and semi-/anti-joins independently.
 * An unsupported SOQL expression produces a limitation, never a clean result.
 */
export function extractSoqlExpressionFields(query: string): SoqlExpressionInventory {
  const normalized = normalizeApexBindExpressions(query);
  const limitations: string[] = [...normalized.limitations];
  if (limitations.length) {
    return { parsed: false, fields: [], limitations };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseQuery(normalized.query, {
      allowApexBindVariables: true,
    }) as unknown as Record<string, unknown>;
  } catch (error) {
    return {
      parsed: false, fields: [],
      limitations: ["SOQL expression parse incomplete: " + readableDiagnostic(error)],
    };
  }

  const fields: SoqlExpressionField[] = [];
  const aliases = new Map<string, string[]>();
  const issue = (detail: string) => {
    if (!limitations.includes(detail)) limitations.push(detail);
  };
  const add = (path: string, context: SoqlFieldContext, functionName?: string) => {
    const name = path.trim();
    if (!FIELD_PATH.test(name) || EXCLUDED_LITERALS.has(name.toLowerCase())) return;
    fields.push({ fieldPath: name, context, ...(functionName ? { functionName } : {}) });
  };

  const visitFunction = (
    value: unknown, context: SoqlFieldContext, enclosingFunction?: string,
    depth = 0
  ): void => {
    if (depth > 30) {
      issue("SOQL function nesting exceeded 30 levels; field access needs review.");
      return;
    }
    const node = asRecord(value);
    if (!node) return;
    const name = typeof node.functionName === "string" ? node.functionName.toUpperCase() : "";
    if (!name) {
      issue("Unknown SOQL function expression; field access needs review.");
      return;
    }
    if (name === "FIELDS") {
      // FIELDS(ALL/CUSTOM/STANDARD) dynamically expands fields. Treat as a
      // coverage limitation, not an exemption from FLS evaluation.
      issue("FIELDS() dynamically selects fields; individual field Read cannot be established statically.");
      return;
    }
    if (!ANALYZABLE_FUNCTIONS.has(name)) {
      issue("SOQL function " + name + " needs field-argument review.");
    }
    if (name === "FORMULA") {
      const formula = asRecord(node.formula);
      if (!formula) issue("FORMULA() could not be analyzed into field references.");
      const walkFormula = (item: unknown): void => {
        const operand = asRecord(item);
        if (!operand) return;
        if (operand.type === "FieldReference" && Array.isArray(operand.parts)) {
          const parts = operand.parts.filter((p): p is string => typeof p === "string");
          add(parts.join("."), context, name);
        } else if (operand.type === "BinaryExpression") {
          walkFormula(operand.left);
          walkFormula(operand.right);
        }
      };
      walkFormula(formula);
      return;
    }
    if (!Array.isArray(node.parameters)) {
      issue(name + "() arguments could not be inspected.");
      return;
    }
    for (const parameter of node.parameters) {
      if (typeof parameter === "string") {
        // Literals like 'mi', numeric parameters of GEOLOCATION, and bindings
        // are not Salesforce field references.
        if (parameter.startsWith("'") || parameter.startsWith(":") ||
            /^[-+]?\d/.test(parameter)) continue;
        // Prevent aliases from becoming synthetic fields when an aggregate is
        // referenced in ORDER BY or HAVING.
        add(parameter, context, name);
      } else if (asRecord(parameter)) {
        visitFunction(parameter, context, name || enclosingFunction, depth + 1);
      }
    }
  };

  const visitSelect = (item: unknown): string[] => {
    const node = asRecord(item);
    if (!node) return [];
    const before = fields.length;
    switch (node.type) {
      case "Field":
        if (typeof node.field === "string") {
          const prefix = typeof node.objectPrefix === "string" ? node.objectPrefix + "." : "";
          add(prefix + node.field, "SELECT");
        }
        break;
      case "FieldRelationship":
        if (typeof node.field === "string" && Array.isArray(node.relationships)) {
          const path = [...node.relationships.filter((p): p is string => typeof p === "string"), node.field].join(".");
          add(path, "SELECT");
        }
        break;
      case "FieldFunctionExpression":
        visitFunction(node, "SELECT");
        break;
      case "FieldSubquery":
        // The child scope is handled recursively by collectQueryFields.
        break;
      case "FieldTypeof":
        issue("TYPEOF polymorphic field projection requires manual analysis.");
        break;
      default:
        issue("Unrecognized SELECT expression; field access needs review.");
    }
    const paths = fields.slice(before).map(item => item.fieldPath);
    if (typeof node.alias === "string" && !INVALID_ALIAS.has(node.alias.toLowerCase()) && paths.length) {
      aliases.set(node.alias.toLowerCase(), paths);
    }
    return paths;
  };

  const visitWhereOrHaving = (value: unknown, context: "WHERE" | "HAVING", depth = 0): void => {
    if (depth > 50) { issue(context + " condition nesting exceeded 50 levels."); return; }
    const node = asRecord(value);
    if (!node) return;
    if (typeof node.field === "string") add(node.field, context);
    if (node.fn) visitFunction(node.fn, context);
    if (node.left) visitWhereOrHaving(node.left, context, depth + 1);
    if (node.right) visitWhereOrHaving(node.right, context, depth + 1);
    // valueQuery is analyzed in its independent semi-/anti-join child scope.
  };

  const visitGrouped = (input: unknown, context: "GROUP_BY" | "ORDER_BY") => {
    for (const entry of Array.isArray(input) ? input : input ? [input] : []) {
      const node = asRecord(entry);
      if (!node) { issue("Unrecognized " + context + " expression."); continue; }
      const value = node.field;
      const names = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      for (const name of names) {
        if (typeof name !== "string") continue;
        const targets = aliases.get(name.toLowerCase()) ?? [name];
        for (const target of targets) add(target, context);
      }
      if (node.fn) visitFunction(node.fn, context);
      if (node.having) visitWhereOrHaving(node.having, "HAVING");
    }
  };

  for (const item of Array.isArray(parsed.fields) ? parsed.fields : []) visitSelect(item);
  if (parsed.where) visitWhereOrHaving(parsed.where, "WHERE");
  if (parsed.groupBy) visitGrouped(parsed.groupBy, "GROUP_BY");
  if (parsed.having) visitWhereOrHaving(parsed.having, "HAVING");
  if (parsed.orderBy) visitGrouped(parsed.orderBy, "ORDER_BY");

  return { parsed: true, fields, limitations };
}
