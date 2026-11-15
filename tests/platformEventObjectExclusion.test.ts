import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { createMetadataRouter } from "../src/api/metadataRoutes.js";
import { buildRelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { buildSoqlFieldInventory } from "../src/analyzer/soqlFieldInventoryBuilder.js";
import { AccessQueryService } from "../src/services/AccessQueryService.js";
import { PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON } from "../src/config/fieldSecurityPolicy.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";

test("object picker excludes events, including namespaced events, and rejects direct field requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-picker-events-"));
  const app = express();
  const objectDir = path.join(root, "objects");
  await mkdir(path.join(objectDir, "Account"), { recursive: true });
  await mkdir(path.join(objectDir, "OrderSummaryChangeEvent"), { recursive: true });
  await mkdir(path.join(objectDir, "Event__e"), { recursive: true });
  await mkdir(path.join(objectDir, "pkg__Notify__e"), { recursive: true });
  app.use("/", createMetadataRouter(root));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(url + "/objects");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ["Account", "OrderSummaryChangeEvent"]);
    const fields = await fetch(url + "/objects/Event__e/fields");
    assert.equal(fields.status, 400);
    assert.equal((await fields.json()).error, PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("direct Access Checker service calls cannot analyze event objects or fields", async () => {
  const service = new AccessQueryService({
    getObjectAccess: async () => { throw Error("must not call object access service"); },
  } as never, {
    getFieldAccess: async () => { throw Error("must not call field access service"); },
  } as never);
  const persona = { name: "Tester", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  assert.throws(() => service.checkObject(persona, "Event__e"), { message: PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON });
  assert.throws(() => service.checkField(persona, "ns__Event__e", "Payload__c"), { message: PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON });
});

test("shared SOQL inventory drops Platform Event objects while keeping ordinary query references", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-inventory-events-"));
  try {
    const relationshipMap = await buildRelationshipMap(dir);
    const makeQuery = (object: string): SoqlQuery => ({
      object, fields: ["Id"], filePath: "Scanner.cls", lineNumber: 7,
      query: `SELECT Id FROM ${object} WITH USER_MODE`, securityMode: "USER_MODE",
      withUserMode: true, subqueries: [],
    });
    const inventory = buildSoqlFieldInventory([
      makeQuery("pkg__Notify__e"), makeQuery("Account"),
    ], relationshipMap);
    assert.equal(inventory.has("pkg__Notify__e"), false);
    assert.equal(inventory.objectReferences.has("pkg__Notify__e"), false);
    assert.equal(inventory.has("Account"), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
