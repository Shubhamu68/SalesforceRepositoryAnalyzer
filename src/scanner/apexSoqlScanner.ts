import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  SoqlQuery,
  SoqlSubquery,
} from "../models/SoqlQuery.js";

export async function scanApexSoql(
  repositoryPath: string
): Promise<SoqlQuery[]> {
  const apexFiles =
    await findApexClasses(
      repositoryPath
    );

  const queries: SoqlQuery[] = [];

  for (const filePath of apexFiles) {
    const source =
      await readFile(
        filePath,
        "utf-8"
      );

    const fileQueries =
      extractSoqlQueries(
        source,
        filePath
      );

    queries.push(
      ...fileQueries
    );
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
  const parsed =
    parseSelectStatement(
      queryText
    );

  if (!parsed) {
    return null;
  }

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

    object: parsed.fromName,

    fields: parsed.fields,

    subqueries:
      parsed.subqueries,

    withUserMode,

    securityMode:
      withUserMode
        ? "USER_MODE"
        : "NO_USER_MODE",
  };
}

interface ParsedSelectStatement {
  fromName: string;
  fields: string[];
  subqueries: SoqlSubquery[];
}

function parseSelectStatement(
  queryText: string
): ParsedSelectStatement | null {
  const trimmed =
    queryText.trim();

  if (
    !/^SELECT\b/i.test(
      trimmed
    )
  ) {
    return null;
  }

  const selectStart =
    findKeywordAtTopLevel(
      trimmed,
      "SELECT",
      0
    );

  if (selectStart !== 0) {
    return null;
  }

  const fromIndex =
    findKeywordAtTopLevel(
      trimmed,
      "FROM",
      "SELECT".length
    );

  if (fromIndex === -1) {
    return null;
  }

  const selectClause =
    trimmed
      .slice(
        "SELECT".length,
        fromIndex
      )
      .trim();

  const afterFrom =
    trimmed
      .slice(
        fromIndex + "FROM".length
      )
      .trim();

  const fromMatch =
    afterFrom.match(
      /^([A-Za-z_][A-Za-z0-9_]*)/
    );

  if (!fromMatch) {
    return null;
  }

  const fromName =
    fromMatch[1];

  const fields: string[] = [];
  const subqueries: SoqlSubquery[] = [];

  const selectItems =
    splitTopLevelCommaSeparated(
      selectClause
    );

  for (const item of selectItems) {
    const trimmedItem =
      item.trim();

    if (!trimmedItem) {
      continue;
    }

    const subqueryText =
      unwrapSubquery(
        trimmedItem
      );

    if (subqueryText) {
      const parsedSubquery =
        parseSelectStatement(
          subqueryText
        );

      if (parsedSubquery) {
        subqueries.push({
          relationshipName:
            parsedSubquery.fromName,

          fields:
            parsedSubquery.fields,

          subqueries:
            parsedSubquery.subqueries,
        });

        continue;
      }
    }

    addField(
      fields,
      trimmedItem
    );
  }

  return {
    fromName,
    fields,
    subqueries,
  };
}

function unwrapSubquery(
  value: string
): string | undefined {
  const trimmed =
    value.trim();

  if (
    !trimmed.startsWith("(") ||
    !trimmed.endsWith(")")
  ) {
    return undefined;
  }

  if (
    !isMatchingOuterParentheses(
      trimmed
    )
  ) {
    return undefined;
  }

  const inner =
    trimmed
      .slice(1, -1)
      .trim();

  if (
    !/^SELECT\b/i.test(
      inner
    )
  ) {
    return undefined;
  }

  return inner;
}

function isMatchingOuterParentheses(
  value: string
): boolean {
  let depth = 0;
  let inSingleQuote = false;

  for (
    let index = 0;
    index < value.length;
    index++
  ) {
    const current =
      value[index];

    if (inSingleQuote) {
      if (
        current === "\\" &&
        value[index + 1]
      ) {
        index++;
        continue;
      }

      if (current === "'") {
        inSingleQuote = false;
      }

      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      continue;
    }

    if (current === "(") {
      depth++;
      continue;
    }

    if (current === ")") {
      depth--;

      /*
       * The outer opening parenthesis
       * closed before the final character.
       */
      if (
        depth === 0 &&
        index !== value.length - 1
      ) {
        return false;
      }
    }
  }

  return depth === 0;
}

function findKeywordAtTopLevel(
  value: string,
  keyword: string,
  startIndex: number
): number {
  let depth = 0;
  let inSingleQuote = false;

  for (
    let index = startIndex;
    index < value.length;
    index++
  ) {
    const current =
      value[index];

    if (inSingleQuote) {
      if (
        current === "\\" &&
        value[index + 1]
      ) {
        index++;
        continue;
      }

      if (current === "'") {
        inSingleQuote = false;
      }

      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      continue;
    }

    if (current === "(") {
      depth++;
      continue;
    }

    if (current === ")") {
      depth--;
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (
      value
        .slice(
          index,
          index + keyword.length
        )
        .toUpperCase() !==
      keyword.toUpperCase()
    ) {
      continue;
    }

    const previous =
      index === 0
        ? " "
        : value[index - 1];

    const next =
      index + keyword.length >=
      value.length
        ? " "
        : value[
            index + keyword.length
          ];

    if (
      isWordBoundary(previous) &&
      isWordBoundary(next)
    ) {
      return index;
    }
  }

  return -1;
}

function isWordBoundary(
  value: string
): boolean {
  return !/[A-Za-z0-9_]/.test(
    value
  );
}

function splitTopLevelCommaSeparated(
  value: string
): string[] {
  const values: string[] = [];

  let current = "";
  let depth = 0;
  let inSingleQuote = false;

  for (
    let index = 0;
    index < value.length;
    index++
  ) {
    const currentChar =
      value[index];

    if (inSingleQuote) {
      current += currentChar;

      if (
        currentChar === "\\" &&
        value[index + 1]
      ) {
        current +=
          value[index + 1];

        index++;
        continue;
      }

      if (currentChar === "'") {
        inSingleQuote = false;
      }

      continue;
    }

    if (currentChar === "'") {
      inSingleQuote = true;
      current += currentChar;
      continue;
    }

    if (currentChar === "(") {
      depth++;
      current += currentChar;
      continue;
    }

    if (currentChar === ")") {
      depth--;
      current += currentChar;
      continue;
    }

    if (
      currentChar === "," &&
      depth === 0
    ) {
      values.push(
        current.trim()
      );

      current = "";
      continue;
    }

    current += currentChar;
  }

  if (current.trim()) {
    values.push(
      current.trim()
    );
  }

  return values;
}

function addField(
  fields: string[],
  value: string
): void {
  let field =
    value
      .trim()
      .replace(/\s+/g, " ");

  if (!field) {
    return;
  }

  /*
   * Unwrap supported SOQL functions.
   */
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

  /*
   * Remove simple aliases.
   */
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