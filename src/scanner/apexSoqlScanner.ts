import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { classifySoqlMode } from "../analyzer/soqlExecutionMode.js";
import { parseNestedSoql, maskSoql } from "../analyzer/nestedSoqlScopes.js";

import type { SoqlQuery } from "../models/SoqlQuery.js";
import { recordSoqlCount } from "../services/SoqlPerformanceMetrics.js";

// Bound filesystem concurrency: improve cold scans without opening hundreds of
// Apex files simultaneously or changing deterministic query ordering.
const READ_BATCH_SIZE = 12;

export async function scanApexSoql(
  repositoryPath: string
): Promise<SoqlQuery[]> {
  const apexFiles =
    await findApexClasses(
      repositoryPath
    );

  recordSoqlCount("scanner.apex_files", apexFiles.length);
  const queries: SoqlQuery[] = [];

  // Promise.all retains input order, so parallel reads cannot reorder findings.
  // Using a fixed-size batch also bounds memory and file-handle usage.
  for (let start = 0; start < apexFiles.length; start += READ_BATCH_SIZE) {
    const batch = apexFiles.slice(start, start + READ_BATCH_SIZE);
    const parsed = await Promise.all(batch.map(async (filePath) => {
      const source = await readFile(filePath, "utf-8");
      return extractSoqlQueries(source, filePath);
    }));
    for (const fileQueries of parsed) queries.push(...fileQueries);
  }

  return queries.sort(
    (a, b) =>
      a.filePath.localeCompare(
        b.filePath
      ) ||
      a.lineNumber -
        b.lineNumber
  );
}

async function findApexClasses(
  repositoryPath: string
): Promise<string[]> {
  const results: string[] = [];

  await walkDirectory(
    repositoryPath,
    results
  );

  return results;
}

async function walkDirectory(
  directoryPath: string,
  results: string[]
): Promise<void> {
  const entries =
    await readdir(
      directoryPath,
      { withFileTypes: true }
    );

  for (const entry of entries) {
    const fullPath =
      path.join(
        directoryPath,
        entry.name
      );

    if (entry.isDirectory()) {
      await walkDirectory(
        fullPath,
        results
      );

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (
      !entry.name
        .toLowerCase()
        .endsWith(".cls")
    ) {
      continue;
    }

    /*
     * Exclude test classes.
     */
    if (
      entry.name
        .toLowerCase()
        .includes("test")
    ) {
      continue;
    }

    results.push(fullPath);
  }
}

 export function extractSoqlQueries(
  source: string,
  filePath: string
): SoqlQuery[] {
  const queries: SoqlQuery[] = [];
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
  for (
    let index = startIndex;
    index < source.length;
    index++
  ) {
    if (source[index] !== "[") {
      continue;
    }

    const remainder =
      source.slice(index + 1);

    if (
      /^\s*SELECT\b/i.test(
        remainder
      )
    ) {
      return index;
    }
  }

  return -1;
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