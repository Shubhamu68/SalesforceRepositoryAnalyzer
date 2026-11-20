import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SoqlFieldReference } from "../models/SoqlFieldInventory.js";
import type { PreparedSoqlSecurityAnalysis } from "./soqlSecurityAnalyzer.js";

/**
 * Diagnostic-only snapshot of the actual prepared SOQL inventory.
 *
 * The snapshot is persona-independent: object/field access verdicts are NOT
 * included. Validate them separately for each representative Salesforce user.
 * Do not use this export as an independent measure of parser completeness.
 */
export function serializePreparedSoqlInventory(
  prepared: PreparedSoqlSecurityAnalysis,
  organizationId?: string,
  generatedAt = new Date().toISOString(),
) {
  const queryIdsByLocation = new Map<string, string[]>();
  const locationKey = (filePath: string, lineNumber: number) => filePath + "\u0000" + lineNumber;
  const queries = prepared.queries.map((query, index) => {
    const id = "Q" + String(index + 1).padStart(5, "0");
    const key = locationKey(query.filePath, query.lineNumber);
    queryIdsByLocation.set(key, [...(queryIdsByLocation.get(key) ?? []), id]);
    return {
      id,
      filePath: query.filePath,
      lineNumber: query.lineNumber,
      baseObject: query.object,
      query: query.query,
      parsedFields: query.fields,
      securityMode: query.securityMode,
      execution: prepared.modeResults[index] ?? null,
    };
  });

  const reference = (ref: SoqlFieldReference) => ({
    ...ref,
    // Some Apex lines can contain two queries; retain all matching candidates.
    // The original SOQL and line are exported for disambiguation.
    queryIds: queryIdsByLocation.get(locationKey(
      ref.filePath, ref.queryLineNumber ?? ref.lineNumber,
    )) ?? [],
  });
  const objectNames = [...new Set([
    ...prepared.inventory.keys(),
    ...prepared.inventory.objectReferences.keys(),
  ])].sort((a, b) => a.localeCompare(b));

  const objects = objectNames.map((object) => {
    const fieldMap = prepared.inventory.get(object);
    const fields = [...(fieldMap?.entries() ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, references]) => ({
        field: references[0]?.field ?? key,
        references: references.map(reference),
      }));
    return {
      object,
      fields,
      objectReferences: (prepared.inventory.objectReferences.get(object) ?? []).map(reference),
    };
  });

  const unresolvedFields = prepared.unresolvedFields.map((entry) => ({
    baseObject: entry.baseObject,
    fieldPath: entry.fieldPath,
    kind: entry.kind ?? "FIELD",
    lineNumber: entry.lineNumber ?? entry.query.lineNumber,
    relationshipPath: entry.relationshipPath ?? null,
    filePath: entry.query.filePath,
    queryLineNumber: entry.query.lineNumber,
    queryIds: queryIdsByLocation.get(locationKey(entry.query.filePath, entry.query.lineNumber)) ?? [],
  }));
  const parserLimitations = prepared.parserLimitations.map(({ query, message }) => ({
    message,
    filePath: query.filePath,
    queryLineNumber: query.lineNumber,
    queryIds: queryIdsByLocation.get(locationKey(query.filePath, query.lineNumber)) ?? [],
  }));

  return {
    schemaVersion: 1,
    generatedAt,
    organizationId: organizationId ?? null,
    purpose: "Diagnostic snapshot of SOQL references prepared by the Analyzer; not an independent parser audit or a permission verdict.",
    summary: {
      queries: queries.length,
      resolvedObjects: objects.length,
      resolvedObjectFieldPairs: objects.reduce((n, object) => n + object.fields.length, 0),
      fieldOccurrences: objects.reduce((n, object) =>
        n + object.fields.reduce((m, field) => m + field.references.length, 0), 0),
      unresolvedReferences: unresolvedFields.length,
      parserLimitations: parserLimitations.length,
    },
    queries,
    objects,
    unresolvedFields,
    parserLimitations,
  };
}

/**
 * The Windows desktop loads SALESFORCE_* settings from its per-user .env.
 * No path configured => no file writes and no change to normal analysis.
 * The file may contain proprietary Apex queries and local filesystem paths;
 * keep it local and never commit it to a repository.
 */
export async function writePreparedSoqlInventoryDiagnostic(
  targetPath: string,
  prepared: PreparedSoqlSecurityAnalysis,
  organizationId?: string,
): Promise<void> {
  if (!path.isAbsolute(targetPath) || path.extname(targetPath).toLowerCase() !== ".json") {
    throw new Error("SALESFORCE_SOQL_DIAGNOSTIC_EXPORT_PATH must be an absolute path ending in .json");
  }

  const payload = serializePreparedSoqlInventory(prepared, organizationId);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = targetPath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error("SOQL diagnostic inventory export failed: " +
      (error instanceof Error ? error.message : String(error)));
  }
}
