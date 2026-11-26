import { maskSoql } from "./soqlMask.js";
import { readApexOperandBoundary } from "../core/apex/ApexOperandBoundary.js";

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
    const bind = readApexOperandBoundary(visible,i+1);
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
