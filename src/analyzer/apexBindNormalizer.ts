import { maskSoql } from "./soqlMask.js";

/**
 * Apex expressions after a SOQL ':' are values, not SOQL fields.
 * This adapter rewrites only bind operands into parser-safe placeholders.
 * The ORIGINAL query remains untouched for source locations and reports.
 */
export interface NormalizedApexBinds {
  query: string;
  limitations: string[];
  count: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_]/;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSE = new Set(Object.values(OPEN));

const isIdentStart = (char: string | undefined): boolean =>
  char !== undefined && IDENT_START.test(char);
const isIdentBody = (char: string | undefined): boolean =>
  char !== undefined && IDENT_BODY.test(char);

/** The masked string is whitespace in comments/literals but preserves line offsets. */
export function normalizeApexBindExpressions(original: string): NormalizedApexBinds {
  const visible = maskSoql(original);
  const n = visible.length;
  const spans: Array<{ from: number; to: number; inList: boolean; numeric: boolean }> = [];
  const limitations: string[] = [];
  const listContexts: boolean[] = [];

  const spaces = (offset: number): number => {
    let i = offset;
    while (i < n && /\s/.test(visible[i])) i++;
    return i;
  };

  const identifier = (offset: number): number => {
    if (!isIdentStart(visible[offset])) return offset;
    let i = offset + 1;
    while (i < n && isIdentBody(visible[i])) i++;
    return i;
  };

  /** Match Apex nested constructor/method delimiters; skip quoted contents. */
  const balanced = (at: number): number => {
    const stack = [OPEN[visible[at]]];
    if (!stack[0]) return -1;
    for (let i = at + 1; i < n; i++) {
      const ch = visible[i];
      if (OPEN[ch]) stack.push(OPEN[ch]);
      else if (CLOSE.has(ch)) {
        if (ch !== stack[stack.length - 1]) return -1;
        stack.pop();
        if (!stack.length) return i + 1;
      }
    }
    return -1;
  };

  const consume = (colon: number): { end: number; malformed: boolean } | null => {
    let i = spaces(colon + 1);
    const firstEnd = identifier(i);
    // LAST_N_DAYS:30 and other numeric date-literal parameters are NOT binds.
    if (firstEnd === i) return null;
    const first = visible.slice(i, firstEnd);
    const constructor = first.toLowerCase() === "new";
    i = firstEnd;

    if (constructor) {
      i = spaces(i);
      const typeEnd = identifier(i);
      if (typeEnd === i) return { end: i, malformed: true };
      i = typeEnd;
      while (visible[i] === ".") {
        const segmentEnd = identifier(i + 1);
        if (segmentEnd === i + 1) break;
        i = segmentEnd;
      }
      const maybeGeneric = spaces(i);
      if (visible[maybeGeneric] === "<") {
        i = balanced(maybeGeneric);
        if (i < 0) return { end: n, malformed: true };
      }
      i = spaces(i);
      if (visible[i] !== "{" && visible[i] !== "(" && visible[i] !== "[") {
        return { end: i, malformed: true };
      }
      i = balanced(i);
      if (i < 0) return { end: n, malformed: true };
    }

    // Ordinary variables, static class constants, chained method calls,
    // property access, collection indexing, safe-navigation and constructors.
    for (;;) {
      const at = spaces(i);
      const safeNav = visible.slice(at, at + 2) === "?.";
      const dotAt = safeNav ? at + 1 : at;
      if (visible[dotAt] === ".") {
        const fieldAt = spaces(dotAt + 1);
        const fieldEnd = identifier(fieldAt);
        if (fieldEnd === fieldAt) return { end: i, malformed: true };
        i = fieldEnd;
        continue;
      }
      if (visible[at] === "(" || visible[at] === "[") {
        i = balanced(at);
        if (i < 0) return { end: n, malformed: true };
        continue;
      }
      break;
    }
    return { end: i, malformed: false };
  };

  // Main scan tracks ONLY SQL IN-list parentheses. Parentheses inside an Apex
  // bind are consumed as part of that value and never affect SQL nesting.
  for (let i = 0; i < n; i++) {
    const ch = visible[i];
    if (ch === "(") {
      const previous = visible.slice(Math.max(0, i - 48), i);
      const isIn = /\bIN\s*$/i.test(previous);
      const next = spaces(i + 1);
      const isSubquery = /^SELECT\b/i.test(visible.slice(next));
      listContexts.push(isIn && !isSubquery);
      continue;
    }
    if (ch === ")") {
      if (listContexts.length) listContexts.pop();
      continue;
    }
    if (ch !== ":") continue;
    const bind = consume(i);
    if (!bind) continue;
    if (bind.malformed) {
      limitations.push(
        "Apex bind expression could not be normalized near character " + (i + 1) + "."
      );
      // Leave the original token in place so the SOQL parser reports failure,
      // rather than fabricating a permitted field.
      continue;
    }
    const inList = listContexts[listContexts.length - 1] === true;
    // SOQL parser expects a numeric literal after LIMIT / OFFSET, even
    // when Apex supplies the value via a bind at execution time.
    const numeric = /\b(?:LIMIT|OFFSET)\s*$/i.test(visible.slice(Math.max(0, i - 48), i));
    spans.push({ from: i, to: bind.end, inList, numeric });
    i = bind.end - 1;
  }

  let query = original;
  for (const { from, to, inList, numeric } of spans.reverse()) {
    // Never discard line information: query source line references use the
    // original text, and normalized multiline binds preserve line counts.
    const newlines = (original.slice(from, to).match(/\r\n|\r|\n/g) ?? []).join("");
    const replacement = numeric ? "1" : inList ? "'analyzerApexBind'" : ":analyzerApexBind";
    query = query.slice(0, from) + replacement + newlines + query.slice(to);
  }
  return { query, limitations, count: spans.length };
}
