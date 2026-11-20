import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  serializePreparedSoqlInventory,
  writePreparedSoqlInventoryDiagnostic,
} from "../src/analyzer/soqlInventoryDiagnostics.js";
import type { PreparedSoqlSecurityAnalysis } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { SoqlFieldInventory, SoqlFieldReference } from "../src/models/SoqlFieldInventory.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";

function fixture(): PreparedSoqlSecurityAnalysis {
  const query: SoqlQuery = {
    filePath: "C:/repo/force-app/main/default/classes/OrderService.cls",
    lineNumber: 7,
    query: "SELECT OrderSummary.Client__r.Branch__r.Export__c FROM OrderItemSummary WITH USER_MODE",
    object: "OrderItemSummary",
    fields: ["OrderSummary.Client__r.Branch__r.Export__c"],
    subqueries: [],
    withUserMode: true,
    securityMode: "USER_MODE",
  };
  const ref: SoqlFieldReference = {
    object: "Branch__c",
    field: "Export__c",
    queryFieldPath: "OrderSummary.Client__r.Branch__r.Export__c",
    filePath: query.filePath,
    lineNumber: 7,
    queryLineNumber: 7,
    relationshipPath: "OrderItemSummary",
    usageContext: "SELECT",
  };
  const inventory = new Map<string, Map<string, SoqlFieldReference[]>>() as SoqlFieldInventory;
  inventory.set("Branch__c", new Map([["export__c", [ref]]]));
  // Object-only references need to survive even when no fields are selected.
  inventory.set("OrderItemSummary", new Map());
  inventory.objectReferences = new Map([[
    "OrderItemSummary",
    [{ ...ref, object: "OrderItemSummary", field: "", queryFieldPath: "" }],
  ]]);
  return {
    queries: [query],
    inventory,
    unresolvedFields: [{
      baseObject: "OrderItemSummary",
      fieldPath: "Unsupported__r.Secret__c",
      kind: "RELATIONSHIP",
      lineNumber: 7,
      relationshipPath: "OrderItemSummary",
      query,
    }],
    parserLimitations: [{ query, message: "Example parser limitation" }],
    modeResults: [{
      declaredMode: "USER_MODE",
      effectiveMode: "USER_MODE",
      enforcement: "FULL",
      description: "WITH USER_MODE enforces object and field Read access.",
    }],
  };
}

test("diagnostic export preserves resolved fields, deep paths, source locations and enforcement", () => {
  const exported = serializePreparedSoqlInventory(fixture(), "00D000000000000AAA", "2026-11-20T00:00:00.000Z");
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.organizationId, "00D000000000000AAA");
  assert.equal(exported.summary.queries, 1);
  assert.equal(exported.summary.resolvedObjectFieldPairs, 1);
  assert.equal(exported.summary.fieldOccurrences, 1);
  assert.equal(exported.queries[0].execution?.enforcement, "FULL");
  assert.equal(exported.queries[0].id, "Q00001");

  const branch = exported.objects.find((item) => item.object === "Branch__c");
  assert.ok(branch);
  assert.equal(branch.fields[0].field, "Export__c");
  assert.deepEqual(branch.fields[0].references[0].queryIds, ["Q00001"]);
  assert.equal(branch.fields[0].references[0].usageContext, "SELECT");
  assert.equal(branch.fields[0].references[0].queryFieldPath,
    "OrderSummary.Client__r.Branch__r.Export__c");

  const root = exported.objects.find((item) => item.object === "OrderItemSummary");
  assert.ok(root);
  assert.equal(root.fields.length, 0);
  assert.equal(root.objectReferences.length, 1);
  assert.deepEqual(exported.unresolvedFields[0].queryIds, ["Q00001"]);
  assert.equal(exported.parserLimitations[0].message, "Example parser limitation");
});

test("diagnostic export writes one JSON file; rejects relative or non-JSON paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sf-soql-diag-"));
  try {
    const file = path.join(directory, "reports", "soql-inventory.json");
    await writePreparedSoqlInventoryDiagnostic(file, fixture());
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.summary.queries, 1);
    assert.equal(saved.organizationId, null);
    assert.deepEqual(await readdir(path.dirname(file)), ["soql-inventory.json"]);
    await assert.rejects(() => writePreparedSoqlInventoryDiagnostic("relative.json", fixture()),
      /absolute path/);
    await assert.rejects(() => writePreparedSoqlInventoryDiagnostic(
      path.join(directory, "not-json.txt"), fixture()), /ending in \.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
