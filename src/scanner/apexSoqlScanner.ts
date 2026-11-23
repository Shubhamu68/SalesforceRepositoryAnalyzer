import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { classifySoqlMode } from "../analyzer/soqlExecutionMode.js";
import { parseNestedSoql, maskSoql } from "../analyzer/nestedSoqlScopes.js";
import { extractDynamicSoqlQueries, type UnresolvedDynamicSoql } from "./dynamicSoqlScanner.js";

import type { SoqlQuery } from "../models/SoqlQuery.js";
import { recordSoqlCount, timeSoqlPhase } from "../services/SoqlPerformanceMetrics.js";

// Bound filesystem concurrency: improve cold scans without opening hundreds of
// Apex files simultaneously or changing deterministic query ordering.
const READ_BATCH_SIZE = 12;

/**
 * Preserve the original repository-wide semantics (including class exclusion
 * and source ordering) while avoiding repeated Apex parsing across personas.
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
type CachedApexFile = { fingerprint: string; queries: SoqlQuery[]; unresolvedDynamic: UnresolvedDynamicSoql[] };
const indexedRepositories = new Map<string, Map<string, CachedApexFile>>();
const inFlightScans = new Map<string, Promise<SoqlScanInventory>>();

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
export async function scanApexSoqlWithUnresolved(repositoryPath: string): Promise<SoqlScanInventory> {
  const root = path.resolve(repositoryPath);
  const pending = inFlightScans.get(root);
  if (pending) {
    recordSoqlCount("scanner.inflight_reuse");
    return pending;
  }
  const work = scanRepositoryApex(root);
  inFlightScans.set(root, work);
  try {
    return await work;
  } finally {
    if (inFlightScans.get(root) === work) inFlightScans.delete(root);
  }
}

async function scanRepositoryApex(repositoryPath: string): Promise<SoqlScanInventory> {
  const apexFiles = await timeSoqlPhase("scanner.discovery", () => findApexClasses(repositoryPath));
  apexFiles.sort((a, b) => a.localeCompare(b));
  recordSoqlCount("scanner.apex_files", apexFiles.length);

  const previous = indexedRepositories.get(repositoryPath);
  let reused = 0;
  const currentEntries = await timeSoqlPhase("scanner.stat_and_parse", () =>
    parallelMap(apexFiles, async (filePath): Promise<[string, CachedApexFile]> => {
      // Nanosecond mtime+ctime and size detect ordinary source edits even when
      // content length is unchanged; directory traversal detects additions/deletions.
      // Cold scans need both source bytes and metadata anyway. Fetch them
      // concurrently rather than serializing thousands of stat+read pairs.
      // Warm scans stat first, avoiding file reads when reuse is safe.
      const cold = previous ? undefined : await Promise.all([
        stat(filePath, { bigint: true }), readFile(filePath, "utf8"),
      ]);
      const info = cold ? cold[0] : await stat(filePath, { bigint: true });
      const fingerprint = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const cached = previous?.get(filePath);
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const lastChanged = info.ctimeNs > info.mtimeNs ? info.ctimeNs : info.mtimeNs;
      const timestampStable = nowNs - lastChanged >= FILE_TIMESTAMP_SAFETY_NS;
      if (cached?.fingerprint === fingerprint && timestampStable) {
        reused++;
        return [filePath, cached];
      }
      const source = cold ? cold[1] : await readFile(filePath, "utf8");
      const staticQueries = extractSoqlQueries(source, filePath);
      const dynamic = extractDynamicSoqlQueries(source, filePath);
      // Every dynamic execution site and branch variant has its own identity,
      // so multiple queries can correctly share the same physical Apex line.
      return [filePath, {
        fingerprint, queries: [...staticQueries, ...dynamic.queries],
        unresolvedDynamic: dynamic.unresolved,
      }];
    }));
  recordSoqlCount("scanner.reused_files", reused);
  recordSoqlCount("scanner.parsed_files", apexFiles.length - reused);
  const nextIndex = new Map(currentEntries);
  // Only publish a complete successful snapshot. Failed reads do not poison
  // the previous cache, and deleted files are removed from the new index.
  if (indexedRepositories.size >= MAX_REPOSITORIES && !indexedRepositories.has(repositoryPath)) {
    indexedRepositories.delete(indexedRepositories.keys().next().value!);
  }
  indexedRepositories.set(repositoryPath, nextIndex);
  const queries: SoqlQuery[] = [];
  const unresolvedDynamic: UnresolvedDynamicSoql[] = [];
  for (const [, entry] of currentEntries) {
    queries.push(...entry.queries);
    unresolvedDynamic.push(...entry.unresolvedDynamic);
  }
  return {
    queries: queries.sort((a, b) =>
      a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber),
    unresolvedDynamic: unresolvedDynamic.sort((a, b) =>
      a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber),
  };
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
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          directories.push(fullPath);
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