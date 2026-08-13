import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import { SoqlQuery } from "../models/SoqlQuery.js";

export async function scanApexSoql(
  repositoryPath: string
): Promise<SoqlQuery[]> {
  const apexFiles = await findApexClasses(
    repositoryPath
  );

  const queries: SoqlQuery[] = [];

  for (const filePath of apexFiles) {
    const source = await readFile(
      filePath,
      "utf-8"
    );

    const fileQueries =
      extractSoqlQueries(
        source,
        filePath
      );

    queries.push(...fileQueries);
  }

  return queries.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.lineNumber - b.lineNumber
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
  const entries = await readdir(
    directoryPath,
    { withFileTypes: true }
  );

  for (const entry of entries) {
    const fullPath = path.join(
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

    if (!entry.name.toLowerCase().endsWith(".cls")) {
      continue;
    }

    // Exclude test classes:
    // *Test*.cls / *test*.cls
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

function extractSoqlQueries(
  source: string,
  filePath: string
): SoqlQuery[] {
  const queries: SoqlQuery[] = [];

  let index = 0;

  while (index < source.length) {
    const openBracket =
      findNextQueryOpeningBracket(
        source,
        index
      );

    if (openBracket === -1) {
      break;
    }

    const closeBracket =
      findMatchingBracket(
        source,
        openBracket
      );

    if (closeBracket === -1) {
      break;
    }

    const queryText = source
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

    index = closeBracket + 1;
  }

  return queries;
}

function isStaticSoql(queryText: string): boolean {
  return /^\s*SELECT\b/i.test(queryText);
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

    if (
      isInsideStringOrComment(
        source,
        index
      )
    ) {
      continue;
    }

    const remainder =
      source.slice(index + 1);

    if (
      /^\s*SELECT\b/i.test(remainder)
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
    const current = source[index];
    const next = source[index + 1];

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

function isInsideStringOrComment(
  source: string,
  targetIndex: number
): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (
    let index = 0;
    index < targetIndex;
    index++
  ) {
    const current = source[index];
    const next = source[index + 1];

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
    }
  }

  return (
    inSingleQuote ||
    inDoubleQuote ||
    inLineComment ||
    inBlockComment
  );
}

function parseSoqlQuery(
  queryText: string,
  filePath: string,
  source: string,
  openingBracketIndex: number
): SoqlQuery | null {
  const fromMatch =
    queryText.match(
      /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i
    );

  if (!fromMatch) {
    return null;
  }

  const object =
    fromMatch[1];

  const selectMatch =
    queryText.match(
      /^\s*SELECT\s+([\s\S]*?)\bFROM\b/i
    );

  if (!selectMatch) {
    return null;
  }

  const fields =
    extractFields(
      selectMatch[1]
    );

  const withUserMode =
  /\bWITH\s+USER_MODE\b/i.test(
    queryText
  );

return {
  filePath,
  lineNumber:
    getLineNumber(
      source,
      openingBracketIndex
    ),
  query: queryText,
  object,
  fields,
  withUserMode,
  securityMode: withUserMode
    ? "USER_MODE"
    : "NO_USER_MODE",
};
}

function extractFields(
  selectClause: string
): string[] {
  const fields: string[] = [];

  let current = "";
  let depth = 0;
  let inSingleQuote = false;

  for (
    let index = 0;
    index < selectClause.length;
    index++
  ) {
    const currentChar =
      selectClause[index];

    if (currentChar === "'") {
      inSingleQuote = !inSingleQuote;
      current += currentChar;
      continue;
    }

    if (!inSingleQuote) {
      if (currentChar === "(") {
        depth++;
      }

      if (currentChar === ")") {
        depth--;
      }

      if (
        currentChar === "," &&
        depth === 0
      ) {
        addField(
          fields,
          current
        );

        current = "";
        continue;
      }
    }

    current += currentChar;
  }

  addField(fields, current);

  return fields;
}

function addField(
  fields: string[],
  value: string
): void {
  let field = value
    .trim()
    .replace(/\s+/g, " ");

  if (!field) {
    return;
  }

  // Ignore subquery blocks for now.
  if (
    field.startsWith("(") &&
    field.toUpperCase().includes("SELECT")
  ) {
    return;
  }

  // --------------------------------------------------
  // Unwrap SOQL functions such as:
  //
  // FORMAT(SomeDate__c)
  // COUNT(Id)
  // MAX(LastModifiedDate)
  //
  // Aggregate functions are ignored entirely.
  // Non-aggregate functions expose their inner
  // field for FLS analysis.
  // --------------------------------------------------

  const functionMatch =
    field.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(.+?)\s*\)$/s
    );

  if (functionMatch) {
    const functionName =
      functionMatch[1].toUpperCase();

    const functionArgument =
      functionMatch[2].trim();

    const aggregateFunctions = new Set([
      "COUNT",
      "COUNT_DISTINCT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
    ]);

    if (
      aggregateFunctions.has(
        functionName
      )
    ) {
      return;
    }

    // FORMAT(field), DISTANCE(...), etc.
    // For FORMAT specifically, the inner
    // field is what needs FLS checking.
    if (
      functionName === "FORMAT"
    ) {
      if (
        functionArgument &&
        !functionArgument.includes(",")
      ) {
        fields.push(
          functionArgument
        );
      }

      return;
    }
  }

  // --------------------------------------------------
  // Remove simple SOQL aliases
  // --------------------------------------------------

  const aliasMatch =
    field.match(
      /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)$/i
    );

  if (
    aliasMatch &&
    !field.includes(".")
  ) {
    field =
      aliasMatch[1].trim();
  }

  fields.push(field);
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