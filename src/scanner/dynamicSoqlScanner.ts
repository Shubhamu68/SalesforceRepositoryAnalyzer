import { classifySoqlMode, type DeclaredSoqlMode } from "../analyzer/soqlExecutionMode.js";
import { maskSoql } from "../analyzer/soqlMask.js";
import { parseNestedSoql } from "../analyzer/nestedSoqlScopes.js";
import type { SoqlQuery } from "../models/SoqlQuery.js";

/** Exactly two outcomes: a complete query or an explicit unresolved site. */
export interface UnresolvedDynamicSoql {
  filePath: string;
  lineNumber: number;
  reason: string;
}
export interface DynamicSoqlScanResult {
  queries: SoqlQuery[];
  unresolved: UnresolvedDynamicSoql[];
}

const EXECUTION = /\bDatabase\s*\.\s*(queryWithBinds|countQueryWithBinds|getQueryLocatorWithBinds|query|countQuery|getQueryLocator)\s*\(/gi;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const LITERAL = /^'(?:\\.|[^'\\])*'$/s;
const MAX_EXPRESSION_LENGTH = 100_000;
const MAX_STATEMENTS = 1000;
const MAX_RESOLUTION_DEPTH = 24;

function lineAt(source: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position; i++) if (source[i] === "\n") line++;
  return line;
}

/** Parentheses and commas inside Apex strings/comments have already been masked. */
function findClosing(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split a Database call's arguments at top-level commas only. */
function callArguments(source: string, masked: string, start: number, end: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let first = start;
  for (let i = start; i < end; i++) {
    const char = masked[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      args.push(source.slice(first, i).trim());
      first = i + 1;
    }
  }
  args.push(source.slice(first, end).trim());
  return args;
}

/**
 * Resolve only values assigned in the innermost unconditional lexical block.
 * The first unsupported branch, loop, nested block or unknown expression
 * invalidates the attempt. Conservative failure prevents invented SELECT fields.
 */
function lexicalBlockStart(masked: string, at: number): number {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}") stack.pop();
  }
  return stack.length ? stack[stack.length - 1] + 1 : -1;
}

function splitConcat(expression: string): string[] | null {
  if (expression.length > MAX_EXPRESSION_LENGTH) return null;
  const parts: string[] = [];
  let start = 0, quoted = false;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (quoted && char === "\\" && i + 1 < expression.length) { i++; continue; }
    if (char === "'") { quoted = !quoted; continue; }
    if (!quoted && char === "+") {
      parts.push(expression.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted) return null;
  parts.push(expression.slice(start).trim());
  return parts.every(Boolean) ? parts : null;
}

function decodeLiteral(token: string): string | null {
  if (!LITERAL.test(token)) return null;
  const content = token.slice(1, -1);
  if (/\\(?![\\'nrt])/.test(content)) return null;
  return content.replace(/\\([\\'nrt])/g, (_, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function expressionValue(expression: string, values: ReadonlyMap<string, string | null>): string | null {
  const pieces = splitConcat(expression);
  if (!pieces) return null;
  let result = "";
  for (const token of pieces) {
    const literal = decodeLiteral(token);
    if (literal !== null) result += literal;
    else if (IDENTIFIER.test(token) && values.get(token) !== undefined) {
      const value = values.get(token);
      if (value === null || value === undefined) return null;
      result += value;
    } else return null;
    if (result.length > MAX_EXPRESSION_LENGTH) return null;
  }
  return result;
}

function resolveQueryExpression(
  source: string, masked: string, expression: string, callStart: number,
): string | null {
  const blockStart = lexicalBlockStart(masked, callStart);
  if (blockStart < 0) return null;
  const beforeCall = masked.slice(blockStart, callStart);
  // Earlier control flow could conditionally mutate values. Do not assume
  // such assignments execute; a future AST/dataflow phase may support them.
  if (/[{}]/.test(beforeCall) || /\b(?:if|else|for|while|do|switch|try|catch)\s*(?:\(|\{)/i.test(beforeCall)) {
    return null;
  }
  const values = new Map<string, string | null>();
  let start = blockStart, statementCount = 0;
  for (let i = blockStart; i < callStart; i++) {
    if (masked[i] !== ";") continue;
    if (++statementCount > MAX_STATEMENTS) return null;
    const statement = source.slice(start, i).trim();
    start = i + 1;
    const match = /^(?:(?:final|static|public|private|protected|global)\s+)*(?:String\s+)?([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]*)$/i.exec(statement);
    if (!match) continue;
    const [, name, operator, rhs] = match;
    const value = expressionValue(rhs, values);
    if (operator === "=") values.set(name, value);
    else {
      const previous = values.get(name);
      values.set(name, previous === undefined || previous === null || value === null ? null : previous + value);
    }
  }
  return expressionValue(expression, values);
}

function accessLevel(method: string, argumentsList: readonly string[]): { level?: "USER_MODE" | "SYSTEM_MODE"; error?: string } {
  const withBinds = /withbinds$/i.test(method);
  const expected = withBinds ? 3 : 1;
  const index = withBinds ? 2 : 1;
  if (argumentsList.length < expected || argumentsList.length > (withBinds ? 3 : 2)) {
    return { error: "Unsupported Database call argument count." };
  }
  if (argumentsList.length === 1) return {};
  if (withBinds || argumentsList.length === 2) {
    const value = argumentsList[index];
    const matched = /^AccessLevel\.(USER_MODE|SYSTEM_MODE)$/i.exec(value);
    if (!matched) return { error: "Database AccessLevel argument cannot be determined statically." };
    return { level: matched[1].toUpperCase() as "USER_MODE" | "SYSTEM_MODE" };
  }
  return {};
}

/**
 * Find every supported dynamic SOQL execution site. A site is either
 * completely RESOLVED or UNRESOLVED; never synthesize a partial query.
 */
export function extractDynamicSoqlQueries(source: string, filePath: string): DynamicSoqlScanResult {
  const masked = maskSoql(source);
  const queries: SoqlQuery[] = [];
  const unresolved: UnresolvedDynamicSoql[] = [];
  const sites: Array<{ lineNumber: number; query?: SoqlQuery; reason?: string }> = [];
  EXECUTION.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = EXECUTION.exec(masked)) !== null) {
    const method = found[1];
    const open = masked.indexOf("(", found.index);
    const end = findClosing(masked, open);
    const lineNumber = lineAt(source, found.index);
    if (end < 0) {
      sites.push({ lineNumber, reason: "Database query invocation has unmatched parentheses." });
      continue;
    }
    const args = callArguments(source, masked, open + 1, end);
    const level = accessLevel(method, args);
    if (level.error) {
      sites.push({ lineNumber, reason: level.error });
      EXECUTION.lastIndex = end + 1;
      continue;
    }
    const text = resolveQueryExpression(source, masked, args[0], found.index);
    if (text === null) {
      sites.push({ lineNumber, reason: "Dynamic query string uses unsupported expressions, variables, assignments or control flow." });
      EXECUTION.lastIndex = end + 1;
      continue;
    }
    const queryText = text.trim();
    if (!/^SELECT\b/i.test(queryText)) {
      sites.push({ lineNumber, reason: "Constructed string is not a complete SELECT SOQL query." });
      EXECUTION.lastIndex = end + 1;
      continue;
    }
    const parsed = parseNestedSoql(queryText, lineNumber);
    if (!parsed) {
      sites.push({ lineNumber, reason: "Constructed SOQL could not be parsed as a complete query." });
      EXECUTION.lastIndex = end + 1;
      continue;
    }
    const declaredMode = classifySoqlMode(queryText);
    if (level.level && declaredMode !== "UNSPECIFIED" && declaredMode !== level.level) {
      sites.push({ lineNumber, reason: "Conflicting SOQL WITH mode and Database AccessLevel." });
      EXECUTION.lastIndex = end + 1;
      continue;
    }
    sites.push({
      lineNumber,
      query: {
        filePath, lineNumber, query: queryText, object: parsed.fromName,
        fields: parsed.fields, subqueries: parsed.subqueries,
        withUserMode: declaredMode === "USER_MODE" || level.level === "USER_MODE",
        securityMode: declaredMode,
        ...(level.level ? { dynamicAccessLevel: level.level } : {}),
      }
    });
    EXECUTION.lastIndex = end + 1;
  }

  // Existing v0.1.0 finding attribution is file+line based. Rather than
  // associate a wrong query with a same-line neighbor, require review.
  const counts = new Map<number, number>();
  for (const site of sites) counts.set(site.lineNumber, (counts.get(site.lineNumber) ?? 0) + 1);
  for (const site of sites) {
    if ((counts.get(site.lineNumber) ?? 0) > 1) {
      unresolved.push({ filePath, lineNumber: site.lineNumber,
        reason: "Multiple dynamic query execution sites share this line; source attribution is ambiguous." });
    } else if (site.query) queries.push(site.query);
    else unresolved.push({ filePath, lineNumber: site.lineNumber,
      reason: site.reason ?? "Dynamic query string cannot be resolved." });
  }
  // One review per source line prevents duplicated indistinguishable rows.
  return { queries, unresolved: [...new Map(unresolved.map(x => [x.lineNumber, x])).values()] };
}
