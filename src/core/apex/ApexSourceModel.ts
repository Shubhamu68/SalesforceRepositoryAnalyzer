/**
 * Reusable, offset-preserving Apex source structure for code analysis.
 * This deliberately does not interpret Apex: unknown syntax stays opaque.
 * Consumers (SOQL, future queried-field-use checks) share the same boundaries.
 */
export interface SourceNode {
  kind: "statement" | "if" | "for" | "block" | "opaque";
  start: number;
  end: number;
  text?: string;
  condition?: string;
  body?: SourceNode[];
  otherwise?: SourceNode[];
  loopVariable?: string;
  iterable?: string;
}
export interface IndexedApexMethod {
  name: string;
  start: number;
  end: number;
  parameters: string[];
  body: SourceNode[];
}
const CONTROL = new Set(["if","else","for","while","switch","catch","try","do","synchronized"]);
const whitespace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

/** Preserve offsets/newlines; mask comments and Apex quoted strings. */
export function maskApexSource(source: string): string {
  const out = source.split("");
  let mode: "normal" | "line" | "block" | "single" | "double" = "normal";
  const blank = (i: number) => { if (source[i] !== "\r" && source[i] !== "\n") out[i] = " "; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (mode === "normal") {
      if (ch === "/" && next === "/") { blank(i); blank(++i); mode = "line"; }
      else if (ch === "/" && next === "*") { blank(i); blank(++i); mode = "block"; }
      else if (ch === "'") { blank(i); mode = "single"; }
      else if (ch === '"') { blank(i); mode = "double"; }
    } else if (mode === "line") {
      if (ch === "\n") mode = "normal"; else blank(i);
    } else if (mode === "block") {
      if (ch === "*" && next === "/") { blank(i); blank(++i); mode = "normal"; }
      else blank(i);
    } else {
      if (ch === "\\" && i + 1 < source.length) { blank(i); blank(++i); }
      else if (mode === "single" && ch === "'") { blank(i); mode = "normal"; }
      else if (mode === "double" && ch === '"') { blank(i); mode = "normal"; }
      else blank(i);
    }
  }
  return out.join("");
}
export function matchingPair(masked: string, open: number, left = "(", right = ")"): number {
  let level = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === left) level++;
    if (masked[i] === right && --level === 0) return i;
  }
  return -1;
}
export function sourceLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}
/** Split only at top-level delimiters; keep quotes and nested calls intact. */
export function splitApexTopLevel(text: string, delimiter: string): string[] {
  const masked = maskApexSource(text);
  const parts: string[] = [];
  let start = 0;
  let nesting = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if ("([{".includes(ch)) nesting++;
    else if (")]}".includes(ch)) nesting--;
    else if (nesting === 0 && masked.startsWith(delimiter, i) && delimiter.length) {
      parts.push(text.slice(start, i).trim()); i += delimiter.length - 1; start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}
function skip(masked: string, index: number, end: number): number {
  while (index < end && whitespace(masked[index])) index++;
  return index;
}
function keyword(masked: string, index: number, value: string): boolean {
  return masked.slice(index, index + value.length) === value
    && !/\w/.test(masked[index + value.length] ?? " ")
    && !/\w/.test(masked[index - 1] ?? " ");
}
function parseBody(source: string, masked: string, cursor: number, end: number):
  { nodes: SourceNode[]; next: number } {
  cursor = skip(masked, cursor, end);
  if (masked[cursor] === "{") {
    const close = matchingPair(masked, cursor, "{", "}");
    if (close < 0 || close >= end) return {
      nodes: [{kind:"opaque",start:cursor,end, text:"Unbalanced Apex block"}], next:end,
    };
    return {nodes: parseApexStatements(source, cursor + 1, close, masked),next:close+1};
  }
  const nodes = parseApexStatements(source, cursor, end, masked, true);
  return {nodes, next: nodes.length ? nodes[nodes.length-1].end : end};
}
export function parseApexStatements(
  source: string, start: number, end: number, masked = maskApexSource(source), single = false,
): SourceNode[] {
  const nodes: SourceNode[] = [];
  let cursor = start, operations = 0;
  while (cursor < end && operations++ < 10000) {
    cursor = skip(masked, cursor, end);
    if (cursor >= end || masked[cursor] === "}") break;
    const at = cursor;
    if (keyword(masked, at, "if")) {
      const open = skip(masked, at+2, end);
      if (masked[open] !== "(") { nodes.push({kind:"opaque",start:at,end, text:"Invalid if"}); break; }
      const close = matchingPair(masked, open);
      if (close < 0) { nodes.push({kind:"opaque",start:at,end,text:"Invalid if condition"}); break; }
      const body = parseBody(source, masked, close+1, end);
      let next = skip(masked,body.next,end);
      let otherwise: SourceNode[] = [];
      if (keyword(masked,next,"else")) {
        const alternate = parseBody(source, masked, next+4,end);
        otherwise = alternate.nodes; next = alternate.next;
      }
      nodes.push({kind:"if",start:at,end:next,condition:source.slice(open+1,close),
        body:body.nodes,otherwise});
      cursor = next;
    } else if (keyword(masked,at,"for")) {
      const open = skip(masked,at+3,end);
      const close = masked[open] === "(" ? matchingPair(masked,open) : -1;
      if (close < 0) { nodes.push({kind:"opaque",start:at,end,text:"Invalid for"}); break; }
      const header = source.slice(open+1,close);
      const match = /^(?:[\w<>,.?]+\s+)+([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(header.trim());
      const body = parseBody(source,masked,close+1,end);
      nodes.push({kind:"for",start:at,end:body.next,loopVariable:match?.[1],iterable:match?.[2],
        body:body.nodes, text:header});
      cursor=body.next;
    } else if (masked[at] === "{") {
      const body = parseBody(source,masked,at,end);
      nodes.push({kind:"block",start:at,end:body.next,body:body.nodes});
      cursor=body.next;
    } else if (["while","switch","try","catch","do"].some(k=>keyword(masked,at,k))) {
      // Never misinterpret unsupported control flow as unconditional statements.
      // Include the remainder as opaque; downstream queries will be unresolved.
      nodes.push({kind:"opaque",start:at,end,text:"Unsupported Apex control flow"});
      cursor=end;
    } else {
      let nest = 0, finish = -1;
      for (let i = at; i < end; i++) {
        const ch=masked[i];
        if (ch === "(" || ch === "[" || ch === "{") nest++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (ch === "}" && nest === 0) break;
          nest--;
        }
        if (ch === ";" && nest === 0) {finish=i+1;break;}
      }
      if (finish < 0) {
        nodes.push({kind:"opaque",start:at,end,text:"Unterminated Apex statement"});
        cursor=end;
      } else {
        nodes.push({kind:"statement",start:at,end:finish,text:source.slice(at,finish)});
        cursor=finish;
      }
    }
    if (single) break;
  }
  return nodes;
}

/** Reusable method index; no dependency on SOQL scanning or persona policies. */
export function indexApexMethods(source: string): IndexedApexMethod[] {
  const masked = maskApexSource(source);
  const methods: IndexedApexMethod[] = [];
  const call = /\b([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(masked)) !== null) {
    if (CONTROL.has(match[1].toLowerCase())) continue;
    const opening = masked.indexOf("(",match.index);
    const closing = matchingPair(masked,opening);
    if (closing < 0) continue;
    const brace = skip(masked,closing+1,masked.length);
    if (masked[brace] !== "{") {call.lastIndex=closing+1;continue;}
    const before=masked.slice(Math.max(0,match.index-160),match.index);
    const prefix=before.slice(Math.max(before.lastIndexOf(";"),before.lastIndexOf("{"),before.lastIndexOf("}"))+1).trim();
    // A method declaration needs a return type or modifier; rejects Foo.bar() {...}
    if (!/(?:^|\s)[A-Za-z_][\w<>,\[\].?]*\s+$/.test(prefix+" ") ||
        /\b(?:return|new|throw|else)\s*$/i.test(prefix)) {
      call.lastIndex=closing+1; continue;
    }
    const closeBrace=matchingPair(masked,brace,"{","}");
    if(closeBrace<0)continue;
    const args=splitApexTopLevel(source.slice(opening+1,closing),",")
      .map(v=>v.trim().match(/([A-Za-z_]\w*)\s*$/)?.[1]??"")
      .filter(Boolean);
    methods.push({name:match[1],start:brace+1,end:closeBrace,parameters:args,
      body:parseApexStatements(source,brace+1,closeBrace,masked)});
    call.lastIndex=brace+1;
  }
  return methods;
}
