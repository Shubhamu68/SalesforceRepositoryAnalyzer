import {countApex,timeApex} from "./ApexPerformance.js";

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
  /** Scalar parameter types are retained for bounded symbolic evaluation. */
  parameterTypes?: string[];
  /** Static methods have no instance-this context. */
  isStatic?:boolean;
  /** Only explicitly private methods permit exhaustive same-class caller tracing. */
  visibility: "private" | "public" | "protected" | "global" | "unspecified";
  body: SourceNode[];
}
const CONTROL = new Set(["if","else","for","while","switch","catch","try","do","synchronized"]);
const whitespace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

/** Bounded, exact-source cache. Syntax only: no metadata, permissions or
 * evaluated state. A changed source string always has a different key. */
type CachedSyntax={masked?:string;methods?:IndexedApexMethod[];weight:number};
const syntaxCache=new Map<string,CachedSyntax>();
const MAX_SYNTAX_ENTRIES=2048,MAX_SYNTAX_CHARS=12_000_000;
let syntaxChars=0;
function syntaxEntry(source:string):CachedSyntax|undefined{
  // Tiny expression fragments are deliberately not cached here.
  if(source.length<512||source.length>MAX_SYNTAX_CHARS/4)return undefined;
  const old=syntaxCache.get(source);
  if(old){syntaxCache.delete(source);syntaxCache.set(source,old);return old;}
  // Approximate text/AST cost, not an exact heap measurement.
  const weight=source.length*4;
  while(syntaxCache.size&&(syntaxCache.size>=MAX_SYNTAX_ENTRIES||syntaxChars+weight>MAX_SYNTAX_CHARS)){
    const first=syntaxCache.keys().next().value!;
    syntaxChars-=syntaxCache.get(first)!.weight;syntaxCache.delete(first);
  }
  const entry:CachedSyntax={weight};
  syntaxCache.set(source,entry);syntaxChars+=weight;return entry;
}

/** Preserve offsets/newlines; mask comments and Apex quoted strings. */
export function maskApexSource(source:string):string{
  const entry=syntaxEntry(source);
  if(entry?.masked!==undefined)return entry.masked;
  const value=maskUncached(source);
  if(entry)entry.masked=value;
  return value;
}
function maskUncached(source: string): string {
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
/** Remove Apex comments while preserving single/double-quoted literals and newlines.
 * Source query concatenation can contain // comments between string fragments;
 * these must never be interpreted as query content or Apex expressions. */
export function stripApexComments(source:string):string {
  let result="",mode:"plain"|"single"|"double"|"line"|"block"="plain";
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(mode==="line"){
      if(ch==="\n"){result+="\n";mode="plain";}
      else result+=ch==="\r"?"\r":" ";
      continue;
    }
    if(mode==="block"){
      if(ch==="*"&&next==="/"){result+="  ";i++;mode="plain";}
      else result+=ch==="\r"||ch==="\n"?ch:" ";
      continue;
    }
    if(mode==="single"||mode==="double"){
      result+=ch;
      if(ch==="\\"&&i+1<source.length){result+=source[++i];continue;}
      if(ch===(mode==="single"?"'":'"'))mode="plain";
      continue;
    }
    if(ch==="/"&&next==="/"){result+="  ";i++;mode="line";continue;}
    if(ch==="/"&&next==="*"){result+="  ";i++;mode="block";continue;}
    result+=ch;
    if(ch==="'")mode="single";
    else if(ch==='"')mode="double";
  }
  return result;
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
    // Generic collection types can contain commas even at expression level
    // (e.g. nested Map constructors). Do not mistake those for arguments.
    if(ch==="<"&&delimiter===","&&/\b(?:Map|List|Set)\s*$/i.test(masked.slice(Math.max(0,i-40),i))){
      const close=matchingPair(masked,i,"<",">");
      if(close>=0&&/^[\w\s,.<>]+$/.test(masked.slice(i+1,close))){i=close;continue;}
    }
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
      const match = /^(?:final\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>?]+>)?(?:\[\])?\s+([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/i.exec(header.trim());
      const body = parseBody(source,masked,close+1,end);
      nodes.push({kind:"for",start:at,end:body.next,loopVariable:match?.[1],iterable:match?.[2],
        body:body.nodes, text:header});
      cursor=body.next;
    } else if (masked[at] === "{") {
      const body = parseBody(source,masked,at,end);
      nodes.push({kind:"block",start:at,end:body.next,body:body.nodes});
      cursor=body.next;
    } else if(keyword(masked,at,"try")){
      const normal=parseBody(source,masked,at+3,end);
      let cursorAfter=skip(masked,normal.next,end);
      let otherwise:SourceNode[]=[];
      if(keyword(masked,cursorAfter,"catch")){
        const open=skip(masked,cursorAfter+5,end);
        const close=masked[open]==="("?matchingPair(masked,open):-1;
        if(close<0){nodes.push({kind:"opaque",start:at,end,text:"Invalid Apex catch"});break;}
        const caught=parseBody(source,masked,close+1,end);
        otherwise=caught.nodes;cursorAfter=skip(masked,caught.next,end);
      }
      // A try/catch represents normal and exception paths; neither may
      // silently be discarded when it mutates a query string.
      nodes.push({kind:"if",start:at,end:cursorAfter,
        condition:"__apex_exception_path_unknown__",body:normal.nodes,otherwise});
      cursor=cursorAfter;
    } else if (["while","switch","catch","do"].some(k=>keyword(masked,at,k))) {
      // Unknown control flow never turns into an unconditional assignment.
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
export function indexApexMethods(source:string):IndexedApexMethod[]{
  const entry=syntaxEntry(source);
  if(entry?.methods){countApex("syntax.method_cache_hit");return entry.methods;}
  countApex("syntax.method_cache_miss");
  const methods=timeApex("syntax.parse_ms",()=>indexMethodsUncached(source));
  if(entry){freezeMethods(methods);entry.methods=methods;}
  return methods;
}
function freezeMethods(methods:IndexedApexMethod[]):IndexedApexMethod[]{
  const freezeNodes=(nodes:SourceNode[])=>{
    for(const node of nodes){if(node.body)freezeNodes(node.body);if(node.otherwise)freezeNodes(node.otherwise);Object.freeze(node);}
    Object.freeze(nodes);
  };
  for(const method of methods){freezeNodes(method.body);Object.freeze(method.parameters);if(method.parameterTypes)Object.freeze(method.parameterTypes);Object.freeze(method);}
  Object.freeze(methods);return methods;
}

/** One syntax inventory per repository build. Masks are released after the
 * indexes are constructed; method trees are retained by the graph owners.
 * No evaluated values, metadata or permissions enter this inventory. */
export class ApexRepositorySyntaxInventory{
  private readonly entries=new Map<string,{masked:string;methods?:IndexedApexMethod[]}>();
  masked(source:string):string{
    const entry=this.entries.get(source);
    if(entry){countApex("syntax.inventory_mask_hit");return entry.masked;}
    const masked=maskUncached(source);
    this.entries.set(source,{masked});return masked;
  }
  methods(source:string):IndexedApexMethod[]{
    const masked=this.masked(source);
    const entry=this.entries.get(source)!;
    if(entry.methods){countApex("syntax.method_cache_hit");return entry.methods;}
    countApex("syntax.method_cache_miss");
    entry.methods=freezeMethods(timeApex("syntax.parse_ms",()=>indexMethodsUncached(source,masked)));
    return entry.methods;
  }
  clear():void{this.entries.clear();}
}

function indexMethodsUncached(source: string,masked=maskApexSource(source)): IndexedApexMethod[] {
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
    const rawParameters=splitApexTopLevel(source.slice(opening+1,closing),",");
    const parameters=rawParameters.map(v=>/^(?:final\s+)?([\w.\s<>,\[\]]+)\s+([A-Za-z_]\w*)$/i.exec(v.trim()));
    const args=parameters.map((v,i)=>v?.[2]??rawParameters[i].trim().match(/([A-Za-z_]\w*)\s*$/)?.[1]??"").filter(Boolean);
    const parameterTypes=parameters.length===args.length?parameters.map(v=>v?.[1].trim()??""):[];
    const visibility=/\b(private|public|protected|global)\b/i.exec(prefix);
    methods.push({name:match[1],start:brace+1,end:closeBrace,parameters:args,parameterTypes,
      visibility:(visibility?.[1].toLowerCase()??"unspecified") as IndexedApexMethod["visibility"],
      isStatic:/\bstatic\b/i.test(prefix),
      body:parseApexStatements(source,brace+1,closeBrace,masked)});
    call.lastIndex=brace+1;
  }
  return methods;
}
