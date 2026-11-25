import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { isExcludedRepositoryDirectory } from "./repositoryDiscoveryPolicy.js";
import {setImmediate as yieldToEventLoop} from "node:timers/promises";
import { classifySoqlMode } from "../analyzer/soqlExecutionMode.js";
import { parseNestedSoql, maskSoql } from "../analyzer/nestedSoqlScopes.js";
import { extractDynamicSoqlQueries, type UnresolvedDynamicSoql } from "./dynamicSoqlScanner.js";
import {emitSoqlTraceReports} from "../analyzer/soqlTraceDiagnostics.js";
import type {ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {ApexAnalysisEngine} from "../core/apex/ApexAnalysisEngine.js";
import { ApexRepositoryMethodIndex } from "../core/apex/ApexRepositoryMethodIndex.js";
import { maskApexSource } from "../core/apex/ApexSourceModel.js";
import type { ApexMetadataProvider } from "../core/metadata/ApexMetadataProvider.js";

import type { SoqlQuery } from "../models/SoqlQuery.js";
import { recordSoqlCount, timeSoqlPhase, timeSoqlSync } from "../services/SoqlPerformanceMetrics.js";

 
/**
 * Preserve repository-wide application-source discovery, test exclusion
 * and source ordering while avoiding repeated Apex parsing across personas.
 * Every call stats every discovered class, so changed, deleted and newly added
 * files invalidate the cached per-file parse without a stale global TTL.
 */
const FILE_CONCURRENCY = 16;
const MAX_REPOSITORIES = 2;
// On Windows, rapid same-length rewrites can retain the exact same mtime and
// ctime within the filesystem's timestamp-resolution window. Treat very
// recently modified files as unstable and parse them again until aged out.
const FILE_TIMESTAMP_SAFETY_NS = 2_000_000_000n;
export interface SoqlScanInventory {
  queries: SoqlQuery[];
  unresolvedDynamic: UnresolvedDynamicSoql[];
}
type CachedApexFile = {
  fingerprint: string;
  source: string;
  queries: SoqlQuery[];
  unresolvedDynamic: UnresolvedDynamicSoql[];
};
type CachedRepositoryGraph = { signature: string; index: ApexRepositoryMethodIndex };
const repositoryGraphs = new Map<string,CachedRepositoryGraph>();
const indexedRepositories = new Map<string, Map<string, CachedApexFile>>();
type ScanProgress=(completed:number,total:number)=>void;
type PendingScan={work:Promise<SoqlScanInventory>;listeners:Set<ScanProgress>;completed:number;total:number};
const inFlightScans = new Map<string, PendingScan>();

async function parallelMap<T, R>(
  input: readonly T[], task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(input.length);
  let position = 0;
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, input.length) }, async () => {
    while (position < input.length) {
      const index = position++;
      results[index] = await task(input[index]);
    }
  }));
  return results;
}

export async function scanApexSoql(repositoryPath: string): Promise<SoqlQuery[]> {
  return (await scanApexSoqlWithUnresolved(repositoryPath)).queries;
}

/** One shared repository scan supplies normal queries plus review-only dynamic sites. */
export async function scanApexSoqlWithUnresolved(
  repositoryPath: string, metadata?: ApexMetadataProvider, onProgress?:ScanProgress,
): Promise<SoqlScanInventory> {
  const root = path.resolve(repositoryPath);
  const traceEnabled=process.env.SALESFORCE_SOQL_TRACE==="1";
  const cacheKey = root + "|" + (metadata?.scopeKey ?? "REPOSITORY_ONLY")+(traceEnabled?"|TRACE":"");
  const pending = inFlightScans.get(cacheKey);
  if (pending) {
    recordSoqlCount("scanner.inflight_reuse");
    if(onProgress){pending.listeners.add(onProgress);onProgress(pending.completed,pending.total);}
    try{return await pending.work;}finally{if(onProgress)pending.listeners.delete(onProgress);}
  }
  const listeners=new Set<ScanProgress>();
  if(onProgress)listeners.add(onProgress);
  const job:PendingScan={work:Promise.resolve({queries:[],unresolvedDynamic:[]}),listeners,completed:0,total:0};
  job.work=scanRepositoryApex(root,cacheKey,metadata,(completed,total)=>{
    job.completed=completed;job.total=total;
    for(const listener of job.listeners)listener(completed,total);
  },traceEnabled);
  inFlightScans.set(cacheKey,job);
  try{return await job.work;}
  finally{if(inFlightScans.get(cacheKey)===job)inFlightScans.delete(cacheKey);}
}

/**
 * Restore the original dependency explanation when richer repository helper
 * evaluation cannot traverse a query site's control flow. This is diagnostic
 * only: never import any query, variant or resolved status from the fallback.
 */
function preserveDynamicFailureDiagnostics(
  source:string,filePath:string,
  analysis:ReturnType<typeof extractDynamicSoqlQueries>,
  standaloneResolver?: (name:string,args:ApexValue[])=>ApexValue|undefined,
):ReturnType<typeof extractDynamicSoqlQueries> {
  if(!analysis.unresolved.some(finding=>
    /Invocation is outside a supported method or execution path/i.test(finding.reason)))
    return analysis;
  const local=extractDynamicSoqlQueries(source,filePath,standaloneResolver);
  const localReasons=new Map(local.unresolved.map(finding=>[finding.siteId,finding.reason]));
  return {...analysis,unresolved:analysis.unresolved.map(finding=>{
    if(finding.securityModeConflict||!/Invocation is outside a supported method or execution path/i.test(finding.reason))
      return finding;
    const original=localReasons.get(finding.siteId);
    if(!original || /Invocation is outside a supported method or execution path/i.test(original))
      return finding;
    // Keep the repository-aware dependency explanation when the existing
    // diagnostic-only fallback supplies a more useful forward reason.
    return {...finding,reason:(finding.backwardExplanation?finding.backwardExplanation+" ":"")+
      "Repository caller execution path not established; source-local dependency: "+original};
  })};
}

/** Resolve only org-proven label/Describe and repository-literal constants. */



async function scanRepositoryApex(
  repositoryPath: string, cacheKey: string, metadata?: ApexMetadataProvider, onProgress?:ScanProgress,traceEnabled=false,
): Promise<SoqlScanInventory> {
  const apexFiles = await timeSoqlPhase("scanner.discovery", () => findApexClasses(repositoryPath));
  apexFiles.sort((a, b) => a.localeCompare(b));
  recordSoqlCount("scanner.apex_files", apexFiles.length);

  const previous=indexedRepositories.get(cacheKey);
  // Preserve source bytes in the repository-scoped cache so cross-class caller
  // indexes can be refreshed without rereading unchanged files on warm scans.
  const sources=await timeSoqlPhase("scanner.source_index",()=>parallelMap(apexFiles,
    async filePath=>{
      const info=await stat(filePath,{bigint:true});
      const fingerprint=`${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const lastChanged=info.ctimeNs>info.mtimeNs?info.ctimeNs:info.mtimeNs;
      const stable=BigInt(Date.now())*1_000_000n-lastChanged>=FILE_TIMESTAMP_SAFETY_NS;
      const cached=previous?.get(filePath);
      const reused=stable && cached?.fingerprint===fingerprint;
      return {filePath,fingerprint,reused,
        source:reused?cached!.source:await readFile(filePath,"utf8")};
    }));
  const signature=sources.map(item=>item.filePath+"@"+item.fingerprint).join("|");
  const previousGraph=repositoryGraphs.get(cacheKey);
  const graphUnchanged=previousGraph?.signature===signature;
  const repositoryIndex=graphUnchanged?previousGraph!.index:
    timeSoqlSync("scanner.repository_graph",()=>new ApexRepositoryMethodIndex(sources.map(({filePath,source})=>({filePath,source}))));

  // A changed caller invalidates a callee's dynamic query analysis even if
  // the callee source is unchanged. Never retain a stale cross-class result.
  const engine=new ApexAnalysisEngine(repositoryIndex,metadata);
  let completed=0;
  onProgress?.(0,sources.length);
  const finishFile=async()=>{
    onProgress?.(++completed,sources.length);
    // Give the HTTP progress poll and pending metadata I/O a chance to run.
    // This is cooperative yielding, not parallel CPU execution.
    if(completed%8===0)await yieldToEventLoop();
  };
  const currentEntries=await timeSoqlPhase("scanner.stat_and_parse",()=>parallelMap(sources,
    async (entry:typeof sources[number]):Promise<[string,CachedApexFile]>=>{
      const existing=previous?.get(entry.filePath);
      // A metadata value may flow from a different class into this method.
      // With a connected org, re-evaluate ALL dynamic execution classes on
      // each new user-initiated scan, while reusing unchanged static-only
      // classes. No stale cross-class label/fieldset/CMDT result may survive.
      const hasDynamicCall=/\bDatabase\s*\.\s*(?:query|countQuery|getQueryLocator)(?:WithBinds)?\s*\(/i
        .test(maskApexSource(entry.source));
      if(entry.reused && graphUnchanged && existing &&
         !(metadata && hasDynamicCall)){
        await finishFile();return [entry.filePath,existing];
      }
      const staticQueries=entry.reused && existing
        ?existing.queries.filter(query=>!query.dynamicOrigin)
        :extractSoqlQueries(entry.source,entry.filePath);
      const dynamic=hasDynamicCall?await engine.analyze(entry.filePath,context=>
        preserveDynamicFailureDiagnostics(entry.source,entry.filePath,
          extractDynamicSoqlQueries(entry.source,entry.filePath,context.resolveExternal,context.repositoryIndex,traceEnabled),
          context.resolveLocal)):{queries:[],unresolved:[]};
      if(!hasDynamicCall)recordSoqlCount("scanner.static_only_files");
      await finishFile();
      return [entry.filePath,{
        fingerprint:entry.fingerprint,source:entry.source,
        queries:[...staticQueries,...dynamic.queries],
        unresolvedDynamic:dynamic.unresolved,
      }];
    }));
  recordSoqlCount("scanner.reused_files",graphUnchanged?sources.filter(s=>s.reused).length:0);
  recordSoqlCount("scanner.parsed_files",
    graphUnchanged?sources.filter(s=>!s.reused).length:sources.length);
  const nextIndex=new Map(currentEntries);
  // Publish both caches together only after every scan succeeds.
  if(indexedRepositories.size>=MAX_REPOSITORIES&&!indexedRepositories.has(cacheKey)) {
    const oldest=indexedRepositories.keys().next().value!;
    indexedRepositories.delete(oldest);
    repositoryGraphs.delete(oldest);
  }
  indexedRepositories.set(cacheKey,nextIndex);
  repositoryGraphs.set(cacheKey,{signature,index:repositoryIndex});
  const queries:SoqlQuery[]=[];
  const unresolvedDynamic:UnresolvedDynamicSoql[]=[];
  for(const [,entry] of currentEntries) {
    queries.push(...entry.queries);
    unresolvedDynamic.push(...entry.unresolvedDynamic);
  }
  const sorted=unresolvedDynamic.sort((a,b)=>a.filePath.localeCompare(b.filePath)||a.lineNumber-b.lineNumber);
  if(traceEnabled)emitSoqlTraceReports(sorted);
  return {queries:queries.sort((a,b)=>a.filePath.localeCompare(b.filePath)||a.lineNumber-b.lineNumber),unresolvedDynamic:sorted};
}

/**
 * A breadth-first directory walker with bounded parallel readdir operations.
 * Unlike an unbounded recursive Promise.all, concurrency and memory stay
 * controlled across large metadata repositories.
 */
async function findApexClasses(repositoryPath: string): Promise<string[]> {
  const results: string[] = [];
  let directories = [repositoryPath];
  while (directories.length) {
    const currentLevel = directories;
    directories = [];
    const listed = await parallelMap(currentLevel, async directoryPath => ({
      directoryPath,
      entries: await readdir(directoryPath, { withFileTypes: true }),
    }));
    for (const { directoryPath, entries } of listed) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          if (!isExcludedRepositoryDirectory(entry.name)) directories.push(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cls") &&
                   !entry.name.toLowerCase().includes("test")) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
}

export function extractSoqlQueries(
  source: string,
  filePath: string
): SoqlQuery[] {
  const queries: SoqlQuery[] = [];
  // The scanner only recognizes static bracketed [SELECT ...] queries.
  // Most Apex classes have none. Skip expensive whole-file masking for them.
  // A false positive in a comment/string still gets safely masked below.
  if (!/\[\s*SELECT\b/i.test(source)) return queries;
  // Mask Apex strings/comments once: repeated prefix rescans were quadratic.
  const visible = maskSoql(source);

  let index = 0;

  while (index < source.length) {
    const openBracket =
      findNextQueryOpeningBracket(
        visible,
        index
      );

    if (openBracket === -1) {
      break;
    }

    const closeBracket =
      findMatchingBracket(
        visible,
        openBracket
      );

    if (closeBracket === -1) {
      break;
    }

    const queryText =
      source
        .slice(
          openBracket + 1,
          closeBracket
        )
        .trim();

    if (isStaticSoql(queryText)) {
      const parsed =
        parseSoqlQuery(
          queryText,
          filePath,
          source,
          openBracket
        );

      if (parsed) {
        queries.push(parsed);
      }
    }

    index =
      closeBracket + 1;
  }

  return queries;
}

function isStaticSoql(
  queryText: string
): boolean {
  return /^\s*SELECT\b/i.test(
    queryText
  );
}

function findNextQueryOpeningBracket(
  source: string,
  startIndex: number
): number {
  // A single regex scan avoids allocating a suffix string for every Apex
  // array/list bracket in files that also contain static SOQL.
  const pattern = /\[\s*SELECT\b/gi;
  pattern.lastIndex = startIndex;
  return pattern.exec(source)?.index ?? -1;
}

function findMatchingBracket(
  source: string,
  openingIndex: number
): number {
  let depth = 0;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (
    let index = openingIndex;
    index < source.length;
    index++
  ) {
    const current =
      source[index];

    const next =
      source[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
      }

      continue;
    }

    if (inBlockComment) {
      if (
        current === "*" &&
        next === "/"
      ) {
        inBlockComment = false;
        index++;
      }

      continue;
    }

    if (inSingleQuote) {
      if (
        current === "\\" &&
        next
      ) {
        index++;
        continue;
      }

      if (current === "'") {
        inSingleQuote = false;
      }

      continue;
    }

    if (inDoubleQuote) {
      if (
        current === "\\" &&
        next
      ) {
        index++;
        continue;
      }

      if (current === '"') {
        inDoubleQuote = false;
      }

      continue;
    }

    if (
      current === "/" &&
      next === "/"
    ) {
      inLineComment = true;
      index++;
      continue;
    }

    if (
      current === "/" &&
      next === "*"
    ) {
      inBlockComment = true;
      index++;
      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      continue;
    }

    if (current === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (current === "[") {
      depth++;
      continue;
    }

    if (current === "]") {
      depth--;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseSoqlQuery(
  queryText: string,
  filePath: string,
  source: string,
  openingBracketIndex: number
): SoqlQuery | null {
  const parsed = parseNestedSoql(queryText, getLineNumber(source, openingBracketIndex));

  if (!parsed) {
    return null;
  }

  const declaredMode = classifySoqlMode(queryText);
  const withUserMode = declaredMode === "USER_MODE";

  return {
    filePath,

    lineNumber:
      getLineNumber(
        source,
        openingBracketIndex
      ),

    query: queryText,

    object: parsed.fromName,

    fields: parsed.fields,

    subqueries:
      parsed.subqueries,

    withUserMode,

    securityMode: declaredMode,
  };
}

function getLineNumber(
  source: string,
  index: number
): number {
  let lineNumber = 1;

  for (
    let current = 0;
    current < index;
    current++
  ) {
    if (source[current] === "\n") {
      lineNumber++;
    }
  }

  return lineNumber;
}