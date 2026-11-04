import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { extractSoqlQueries } from "./apexSoqlScanner.js";
import type { SoqlQuery } from "../models/SoqlQuery.js";
import type { ApexStackFrame, ReachableMethod } from "../models/StackTraceImpact.js";

export interface ApexMethod extends Omit<ReachableMethod, "depth" | "callPaths"> {
  parameterCount: number;
  parameterTypes: Map<string, string>;
  source: string;
  masked: string;
  bodyOpen: number;
  bodyClose: number;
  queries: SoqlQuery[];
}

export interface ApexMethodIndex {
  methods: ApexMethod[];
  classes: Map<string, ApexMethod[]>;
  files: string[];
}

const IGNORED_DIRECTORIES = new Set([
  ".git", ".sfdx", ".sf", "node_modules", "dist", "build", ".next", "coverage",
]);

const RESERVED = new Set([
  "if", "else", "for", "while", "do", "switch", "catch", "try", "return",
  "throw", "new", "with", "when", "runas", "select", "from", "insert",
  "update", "delete", "upsert", "merge", "typeof",
]);

/** Mask comments and quoted literals, preserving character offsets and newlines. */
export function maskApex(source: string): string {
  const output = source.split("");
  let state: "normal" | "line" | "block" | "single" | "double" = "normal";
  const blank = (index: number) => { if (source[index] !== "\n" && source[index] !== "\r") output[index] = " "; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "normal") {
      if (ch === "/" && next === "/") { blank(i); blank(i + 1); i++; state = "line"; }
      else if (ch === "/" && next === "*") { blank(i); blank(i + 1); i++; state = "block"; }
      else if (ch === "'") { blank(i); state = "single"; }
      else if (ch === '"') { blank(i); state = "double"; }
      continue;
    }
    if (state === "line") { if (ch === "\n") state = "normal"; else blank(i); continue; }
    if (state === "block") {
      if (ch === "*" && next === "/") { blank(i); blank(i + 1); i++; state = "normal"; }
      else blank(i);
      continue;
    }
    if (ch === "\\" && next !== undefined) { blank(i); blank(i + 1); i++; continue; }
    blank(i);
    if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) state = "normal";
  }
  return output.join("");
}

export function matchPair(masked: string, open: number, opening: string, closing: string): number {
  let level = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === opening) level++;
    if (masked[i] === closing && --level === 0) return i;
  }
  return -1;
}

export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

/** Split method arguments at top-level commas (including generic-type brackets). */
export function countArguments(text: string): number {
  if (!text.trim()) return 0;
  let nested = 0;
  let count = 1;
  for (const char of text) {
    if (char === "(" || char === "[" || char === "<" || char === "{") nested++;
    else if (char === ")" || char === "]" || char === ">" || char === "}") nested = Math.max(0, nested - 1);
    else if (char === "," && nested === 0) count++;
  }
  return count;
}

function parameterTypes(params: string): Map<string, string> {
  const types = new Map<string, string>();
  // Useful for resolving calls like `service.validate()` when service is a typed parameter.
  for (const item of params.split(/,(?![^<]*>)/)) {
    const normalized = item.trim().replace(/\bfinal\s+/g, "");
    const match = normalized.match(/(?:^|\s)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*$/);
    if (match) types.set(match[2].toLowerCase(), match[1]);
  }
  return types;
}

export function extractApexMethods(source: string, filePath: string): ApexMethod[] {
  const masked = maskApex(source);
  const className = path.basename(filePath, ".cls");
  const methods: ApexMethod[] = [];
  const matcher = /\b([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked)) !== null) {
    const name = match[1];
    if (RESERVED.has(name.toLowerCase())) continue;
    const openParen = masked.indexOf("(", match.index + name.length);
    const closeParen = matchPair(masked, openParen, "(", ")");
    if (closeParen < 0) continue;
    const after = masked.slice(closeParen + 1).match(/^\s*\{/);
    if (!after) continue;
    const openBrace = closeParen + 1 + after[0].length - 1;
    const endBrace = matchPair(masked, openBrace, "{", "}");
    if (endBrace < 0) continue;

    const boundary = Math.max(
      masked.lastIndexOf(";", match.index - 1),
      masked.lastIndexOf("{", match.index - 1),
      masked.lastIndexOf("}", match.index - 1)
    );
    const header = masked.slice(boundary + 1, match.index).trim();
    // A declaration must have a return type/modifier or be an Apex constructor.
    // Avoid classifying control flow and call expressions followed by blocks as methods.
    const declaration = /(?:^|\s)(?:public|private|protected|global|static|override|virtual|webservice|void|testMethod)\b/i.test(header)
      || /^\s*[A-Za-z_][A-Za-z_0-9<>,.\[\]\s?]*\s+$/.test(masked.slice(boundary + 1, match.index));
    if (!declaration && name.toLowerCase() !== className.toLowerCase()) continue;
    if (/(?:\bnew\s+|\breturn\s+|=\s*)$/.test(header) || header.endsWith(".")) continue;

    const start = lineAt(source, match.index);
    const end = lineAt(source, endBrace);
    const params = masked.slice(openParen + 1, closeParen);
    methods.push({
      id: `${filePath}:${start}:${name}`,
      className, methodName: name, filePath,
      startLine: start, endLine: end,
      parameterCount: countArguments(params),
      parameterTypes: parameterTypes(params),
      source, masked, bodyOpen: openBrace, bodyClose: endBrace,
      queries: [],
    });
    // Method bodies can contain calls, not method declarations. Skip body.
    matcher.lastIndex = endBrace + 1;
  }
  const queries = extractSoqlQueries(source, filePath);
  for (const query of queries) {
    const containing = methods
      .filter((method) => method.startLine <= query.lineNumber && method.endLine >= query.lineNumber)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    containing?.queries.push(query);
  }
  return methods;
}

export function parseApexStackTrace(text: string): ApexStackFrame[] {
  const frames: ApexStackFrame[] = [];
  const regex = /^\s*(Class|Trigger)\.([A-Za-z_][\w.]*)\s*:\s*line\s+(\d+)(?:\s*,\s*column\s+\d+)?/i;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(regex);
    if (!match) continue;
    const tokens = match[2].split(".");
    const kind = match[1].toLowerCase() === "class" ? "Class" : "Trigger";
    frames.push({
      kind,
      className: kind === "Class" ? tokens.slice(0, -1).join(".") : match[2],
      methodName: kind === "Class" ? tokens[tokens.length - 1] : undefined,
      line: Number(match[3]), raw: line.trim(),
    });
  }
  return frames;
}

export async function createApexMethodIndex(repositoryPath: string): Promise<ApexMethodIndex> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cls")) files.push(full);
    }
  }
  await walk(repositoryPath);
  const methods: ApexMethod[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    methods.push(...extractApexMethods(source, filePath));
  }
  const classes = new Map<string, ApexMethod[]>();
  for (const method of methods) {
    const name = method.className.toLowerCase();
    if (!classes.has(name)) classes.set(name, []);
    classes.get(name)!.push(method);
  }
  return { methods, classes, files };
}

export interface ApexCall {
  qualifier?: string;
  method: string;
  argumentsCount: number;
  line: number;
}

/** Detect statically recognizable calls within a method, ignoring strings/comments and static SOQL. */
export function extractMethodCalls(method: ApexMethod): ApexCall[] {
  let body = method.masked.slice(method.bodyOpen + 1, method.bodyClose);
  // Erase static SOQL text so SOQL functions are never mistaken for Apex calls.
  const chars = body.split("");
  const pattern = /\[\s*SELECT\b/gi;
  let queryMatch: RegExpExecArray | null;
  while ((queryMatch = pattern.exec(body)) !== null) {
    const end = matchPair(body, queryMatch.index, "[", "]");
    if (end < 0) continue;
    for (let i = queryMatch.index; i <= end; i++) if (chars[i] !== "\n") chars[i] = " ";
    pattern.lastIndex = end + 1;
  }
  body = chars.join("");
  const results: ApexCall[] = [];
  const matcher = /\b(?:(\b[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(body)) !== null) {
    const methodName = match[2];
    if (RESERVED.has(methodName.toLowerCase())) continue;
    const parenthesis = body.indexOf("(", match.index + match[0].length - 1);
    const end = matchPair(body, parenthesis, "(", ")");
    if (end < 0) continue;
    const previous = body.slice(Math.max(0, match.index - 12), match.index);
    if (/\bnew\s*$/i.test(previous)) continue;
    results.push({
      qualifier: match[1], method: methodName,
      argumentsCount: countArguments(body.slice(parenthesis + 1, end)),
      line: lineAt(method.source, method.bodyOpen + 1 + match.index),
    });
  }
  return results;
}

export function resolveMethodCalls(
  method: ApexMethod, index: ApexMethodIndex, warnings: string[]
): ApexMethod[] {
  const calls = extractMethodCalls(method);
  const localTypes = new Map(method.parameterTypes);
  const body = method.masked.slice(method.bodyOpen + 1, method.bodyClose);
  for (const declaration of body.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?==|;|,)/g)) {
    if (index.classes.has(declaration[1].toLowerCase())) localTypes.set(declaration[2].toLowerCase(), declaration[1]);
  }
  const resolved = new Map<string, ApexMethod>();
  for (const call of calls) {
    let owner = method.className;
    if (call.qualifier && !["this", "super"].includes(call.qualifier.toLowerCase())) {
      if (index.classes.has(call.qualifier.toLowerCase())) owner = call.qualifier;
      else if (localTypes.has(call.qualifier.toLowerCase())) owner = localTypes.get(call.qualifier.toLowerCase())!;
      else continue; // External dependency, collections, or dynamically typed instance.
    }
    const candidates = (index.classes.get(owner.toLowerCase()) ?? [])
      .filter((candidate) => candidate.methodName.toLowerCase() === call.method.toLowerCase()
        && candidate.parameterCount === call.argumentsCount);
    if (candidates.length === 1) resolved.set(candidates[0].id, candidates[0]);
    else if (candidates.length > 1) warnings.push(
      `Ambiguous overload ${owner}.${call.method} at ${method.className}:${call.line}; call was not followed.`
    );
  }
  return [...resolved.values()];
}
