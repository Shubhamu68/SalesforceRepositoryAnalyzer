const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_]/;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSE = new Set(Object.values(OPEN));

const isIdentStart = (char: string | undefined): boolean =>
  char !== undefined && IDENT_START.test(char);
const isIdentBody = (char: string | undefined): boolean =>
  char !== undefined && IDENT_BODY.test(char);

/** Locate the end of a supported identifier/constructor-led Apex operand
 * in an offset-preserving masked source string. This is a lexical boundary,
 * not an evaluation or a general-purpose Apex expression parser. */
export function readApexOperandBoundary(visible:string,offset:number):{end:number;malformed:boolean}|null{
  const n=visible.length;
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

  const consume = (offset: number): { end: number; malformed: boolean } | null => {
    let i = spaces(offset);
    const firstEnd = identifier(i);
    // This reader supports identifier/constructor-led operands only.
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

  return consume(offset);
}
