import type { SoqlSubquery } from "../models/SoqlQuery.js";

/**
 * One SOQL scope parser used by repository and stack-trace scanning.
 * Character offsets survive masking so nested line numbers remain accurate.
 * This is a static parser: unsupported constructs produce analysis limitations,
 * never a fabricated permission denial.
 */
export interface ParsedSoqlScope {
  fromName: string;
  fields: string[];
  subqueries: SoqlSubquery[];
}

export function maskSoql(text: string): string {
  const out = text.split("");
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  const blank = (i: number) => { if (text[i] !== "\n" && text[i] !== "\r") out[i] = " "; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (state === "normal") {
      if (ch === "'") { state = "single"; blank(i); }
      else if (ch === '"') { state = "double"; blank(i); }
      else if ((ch === "/" && next === "/") || (ch === "-" && next === "-")) { state = "line"; blank(i); blank(++i); }
      else if (ch === "/" && next === "*") { state = "block"; blank(i); blank(++i); }
    } else if (state === "line") {
      if (ch === "\n") state = "normal"; else blank(i);
    } else if (state === "block") {
      if (ch === "*" && next === "/") { blank(i); blank(++i); state = "normal"; }
      else blank(i);
    } else {
      if (ch === "\\" && next !== undefined) { blank(i); blank(++i); }
      else if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) { blank(i); state = "normal"; }
      else blank(i);
    }
  }
  return out.join("");
}

function wordAt(masked: string, i: number, word: string): boolean {
  return masked.slice(i, i + word.length).toUpperCase() === word &&
    (i === 0 || !/\w/.test(masked[i - 1])) &&
    (i + word.length === masked.length || !/\w/.test(masked[i + word.length]));
}

function topKeyword(masked: string, word: string, from = 0): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    if (i >= from && depth === 0 && wordAt(masked, i, word)) return i;
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") depth--;
  }
  return -1;
}

function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function segments(text: string, masked: string, start: number, end: number): Array<{ text: string; offset: number }> {
  const result: Array<{ text: string; offset: number }> = [];
  let depth = 0, begin = start;
  for (let i = start; i < end; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") depth--;
    else if (masked[i] === "," && depth === 0) {
      result.push({ text: text.slice(begin, i), offset: begin });
      begin = i + 1;
    }
  }
  result.push({ text: text.slice(begin, end), offset: begin });
  return result;
}

function selectedField(raw: string): string | undefined {
  let value = raw.trim();
  if (!value) return undefined;
  const functionMatch = value.match(/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)(?:\s+\w+)?$/);
  if (functionMatch) {
    const name = functionMatch[1].toUpperCase();
    if (["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"].includes(name)) return undefined;
    if (["FORMAT", "TOLABEL"].includes(name)) value = functionMatch[2].trim();
    else return undefined;
  }
  value = value.replace(/\s+(?:AS\s+)?[A-Za-z_]\w*$/i, "").trim();
  return value || undefined;
}

export function parseNestedSoql(text: string, rootLine = 1): ParsedSoqlScope | undefined {
  function parse(current: string, absoluteOffset: number): ParsedSoqlScope | undefined {
    const mask = maskSoql(current);
    const select = mask.search(/\bSELECT\b/i);
    if (select < 0 || mask.slice(0, select).trim()) return undefined;
    const from = topKeyword(mask, "FROM", select + 6);
    if (from < 0) return undefined;
    const fromMatch = mask.slice(from + 4).match(/^\s+([A-Za-z_]\w*)/);
    if (!fromMatch) return undefined;
    const children: SoqlSubquery[] = [];
    const fields: string[] = [];
    const makeChild = (start: number, end: number, kind: "CHILD" | "SEMI_JOIN" | "ANTI_JOIN"): void => {
      const subtext = current.slice(start, end);
      const parsed = parse(subtext, absoluteOffset + start);
      if (!parsed) return;
      const absolute = absoluteOffset + start;
      const lineNumber = rootLine + text.slice(0, absolute).split("\n").length - 1;
      children.push({
        relationshipName: parsed.fromName, fields: parsed.fields,
        subqueries: parsed.subqueries, kind, query: subtext,
        lineNumber,
      });
    };
    for (const item of segments(current, mask, select + 6, from)) {
      const raw = item.text;
      const leading = raw.length - raw.trimStart().length;
      const start = item.offset + leading;
      const candidate = raw.trim();
      if (!candidate) continue;
      if (candidate.startsWith("(") && mask.slice(start).match(/^\(\s*SELECT\b/i)) {
        const end = closingParen(mask, start);
        if (end >= 0 && !current.slice(end + 1, item.offset + raw.length).trim()) {
          makeChild(start + 1, end, "CHILD");
        }
        // An unparseable child SELECT is NOT an FLS field.
        continue;
      }
      const field = selectedField(candidate);
      if (field) fields.push(field);
    }
    // Semi-joins and anti-joins occur in predicates, not the SELECT list.
    // Skip whole parenthesized subselects so their descendants are found once.
    for (let i = from + 4; i < mask.length; i++) {
      if (mask[i] !== "(" || !/^\(\s*SELECT\b/i.test(mask.slice(i))) continue;
      const end = closingParen(mask, i);
      if (end < 0) break;
      const prefix = mask.slice(Math.max(from + 4, i - 36), i);
      const kind = /\bNOT\s+IN\s*$/i.test(prefix) ? "ANTI_JOIN" : "SEMI_JOIN";
      makeChild(i + 1, end, kind);
      i = end;
    }
    return { fromName: fromMatch[1], fields, subqueries: children };
  }
  return parse(text.trim(), 0);
}

/** Mask descendant SELECT scopes while preserving the outer WHERE/ORDER BY text. */
export function maskNestedSelects(text: string): string {
  const masked = maskSoql(text);
  const chars = text.split("");
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "(" || !/^\(\s*SELECT\b/i.test(masked.slice(i))) continue;
    const end = closingParen(masked, i);
    if (end < 0) break;
    for (let j = i; j <= end; j++) if (chars[j] !== "\n") chars[j] = " ";
    i = end;
  }
  return maskSoql(chars.join(""));
}
