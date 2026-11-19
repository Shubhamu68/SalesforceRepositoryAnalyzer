import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { OptionalFieldMetadataCache, FIELD_CACHE_MAX_AGE_MS } from "../src/services/OptionalFieldMetadataCache.js";
import { SalesforceFieldMetadataService } from "../src/salesforce/SalesforceFieldMetadataService.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import { buildRelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { createPersonaAccessEvaluator } from "../src/analyzer/personaAccessEvaluator.js";
import type { ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { Persona } from "../src/models/Persona.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";

const ORG_A = "00D000000000001";
const ORG_B = "00D000000000002";
const now = Date.now();
const date = new Date(now).toISOString();
const cacheJson = (organizationId: string, capturedAt = date) => ({
  version: 2, organizationId, capturedAt,
  objects: { Account: { Name: false, Industry: true }, CustomChild__c: { Label__c: true } },
});
const relationshipJson = (organizationId: string, capturedAt = date) => ({
  version: 2, organizationId, capturedAt, objects: {
    CustomChild__c: {
      parents: [{ relationshipName: "Account__r", sourceField: "Account__c", referenceTo: ["Account"] }],
    },
  },
});

async function withRoot(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "neutral-metadata-"));
  try { await work(root); } finally { await rm(root, { force: true, recursive: true }); }
}

test("no bundled field snapshot: unknown remains unknown in fresh repository-only usage", async () => {
  const service = new SalesforceFieldMetadataService(undefined,
    new OptionalFieldMetadataCache(undefined, undefined));
  assert.deepEqual(await service.getField("Account", "Name"),
    { permissionable: undefined, source: "UNKNOWN" });
  assert.deepEqual(await service.getField("Unrelated__c", "Any_Field__c"),
    { permissionable: undefined, source: "UNKNOWN" });
});

test("optional cache is only used with an explicitly matching offline org and preserves true/false", async () => {
  await withRoot(async root => {
    const filename = path.join(root, "fields.local.json");
    await writeFile(filename, JSON.stringify(cacheJson(ORG_A)));
    const matching = new OptionalFieldMetadataCache(filename, ORG_A, () => now);
    const service = new SalesforceFieldMetadataService(undefined, matching);
    assert.deepEqual(await service.getField("Account", "Name"),
      { permissionable: false, source: "OPTIONAL_CACHE" });
    assert.deepEqual(await service.getField("Account", "Industry"),
      { permissionable: true, source: "OPTIONAL_CACHE" });
    assert.deepEqual(await service.getField("Account", "NotThere__c"),
      { permissionable: undefined, source: "UNKNOWN" });
    const unscoped = new SalesforceFieldMetadataService(undefined,
      new OptionalFieldMetadataCache(filename, undefined, () => now));
    assert.equal((await unscoped.getField("Account", "Name")).source, "UNKNOWN");
    const wrong = new SalesforceFieldMetadataService(undefined,
      new OptionalFieldMetadataCache(filename, ORG_B, () => now));
    assert.equal((await wrong.getField("Account", "Name")).source, "UNKNOWN");
  });
});

test("connected org may only use its own cache when live EntityParticle fails", async () => {
  await withRoot(async root => {
    const filename = path.join(root, "fields.local.json");
    await writeFile(filename, JSON.stringify(cacheJson(ORG_A)));
    let queries = 0;
    const connection = {
      status: { organizationId: ORG_A, instanceUrl: "https://example.my.salesforce.com" },
      queryAll: async () => { queries++; throw new Error("Tooling denied"); },
    } as unknown as SalesforceOrgConnection;
    const service = new SalesforceFieldMetadataService(connection,
      new OptionalFieldMetadataCache(filename, ORG_B, () => now));
    assert.deepEqual(await service.getField("Account", "Name"),
      { permissionable: false, source: "OPTIONAL_CACHE" },
      "selected connected org, not mismatched offline override, determines cache eligibility");
    (connection.status as { organizationId: string }).organizationId = ORG_B;
    assert.deepEqual(await service.getField("Account", "Name"),
      { permissionable: undefined, source: "UNKNOWN" });
    assert.equal(queries, 2);
  });
});

test("successful current-org EntityParticle always wins over opt-in offline cache", async () => {
  await withRoot(async root => {
    const filename = path.join(root, "fields.local.json");
    await writeFile(filename, JSON.stringify(cacheJson(ORG_A)));
    const connection = {
      status: { organizationId: ORG_A, instanceUrl: "https://example.my.salesforce.com" },
      queryAll: async () => [{ QualifiedApiName: "Name", IsPermissionable: true }],
    } as unknown as SalesforceOrgConnection;
    const service = new SalesforceFieldMetadataService(connection,
      new OptionalFieldMetadataCache(filename, ORG_A, () => now));
    assert.deepEqual(await service.getField("Account", "Name"),
      { permissionable: true, source: "LIVE" });
    assert.deepEqual(await service.getField("Account", "Industry"),
      { permissionable: undefined, source: "UNKNOWN" },
      "absent from successful live result must not be borrowed from cache");
  });
});

test("stale, future, malformed and legacy cache files never justify FLS bypass", async () => {
  await withRoot(async root => {
    for (const [label, contents] of [
      ["stale", JSON.stringify(cacheJson(ORG_A, new Date(now - FIELD_CACHE_MAX_AGE_MS - 1000).toISOString()))],
      ["future", JSON.stringify(cacheJson(ORG_A, new Date(now + 6 * 60_000).toISOString()))],
      ["malformed", "{not-json}"],
      ["legacy", JSON.stringify({ version: 1, objects: cacheJson(ORG_A).objects })],
    ]) {
      const file = path.join(root, label + ".json");
      await writeFile(file, contents);
      const service = new SalesforceFieldMetadataService(undefined,
        new OptionalFieldMetadataCache(file, ORG_A, () => now));
      assert.deepEqual(await service.getField("Account", "Name"),
        { permissionable: undefined, source: "UNKNOWN" }, label);
    }
  });
});

test("repository XML relationships work independently of field permissionability snapshot", async () => {
  await withRoot(async root => {
    const folder = path.join(root, "CustomChild__c", "fields");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "Account__c.field-meta.xml"),
      "<CustomField><fullName>Account__c</fullName><type>Lookup</type><referenceTo>Account</referenceTo><relationshipName>CustomChildren__r</relationshipName></CustomField>");
    const graph = await buildRelationshipMap(root);
    assert.equal(graph.resolveField("CustomChild__c", "Account__r.Name")?.object, "Account");
    assert.equal(graph.childObject("Account", "CustomChildren__r"), "CustomChild__c");
    assert.equal(graph.parentTargets("CustomChild__c", "OriginalOrderItem"), undefined,
      "no special OMS relationship can be invented by a hardcoded field list");
  });
});

test("relationship export is opt-in, org-scoped and cannot override repository relationships", async () => {
  await withRoot(async root => {
    const filename = path.join(root, "relationships.local.json");
    await writeFile(filename, JSON.stringify(relationshipJson(ORG_A)));
    const oldPath = process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH;
    const oldOrg = process.env.FIELD_METADATA_OFFLINE_ORG_ID;
    try {
      process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH = filename;
      process.env.FIELD_METADATA_OFFLINE_ORG_ID = ORG_A;
      const valid = await buildRelationshipMap(root);
      assert.equal(valid.resolveField("CustomChild__c", "Account__r.Name")?.object, "Account");
      process.env.FIELD_METADATA_OFFLINE_ORG_ID = ORG_B;
      const wrong = await buildRelationshipMap(root);
      assert.equal(wrong.parentTargets("CustomChild__c", "Account__r"), undefined);
      const live = await buildRelationshipMap(root, { connected: true, organizationId: ORG_A });
      assert.equal(live.resolveField("CustomChild__c", "Account__r.Name")?.object, "Account");
      const invalid = await buildRelationshipMap(root, { connected: true, organizationId: ORG_B });
      assert.equal(invalid.parentTargets("CustomChild__c", "Account__r"), undefined);
    } finally {
      if (oldPath === undefined) delete process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH;
      else process.env.SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH = oldPath;
      if (oldOrg === undefined) delete process.env.FIELD_METADATA_OFFLINE_ORG_ID;
      else process.env.FIELD_METADATA_OFFLINE_ORG_ID = oldOrg;
    }
  });
});

test("no project-specific field JSON is shipped in the Analyzer source", () => {
  assert.equal(existsSync(path.resolve("config/field-permissionability.json")), false);
});

test("CSV importer generates an explicit, org-scoped version 2 cache", async () => {
  await withRoot(async root => {
    const input = path.join(root, "fields.csv");
    const output = path.join(root, "fields.local.json");
    await writeFile(input, [
      "EntityDefinition.QualifiedApiName,QualifiedApiName,IsPermissionable",
      "Custom__c,Example__c,true",
      "Custom__c,CreatedDate,false",
    ].join("\n"));
    const result = spawnSync(process.execPath,
      ["scripts/import-field-permissionability.mjs", input, output, "--org-id", ORG_A],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const exported = JSON.parse(await readFile(output, "utf8"));
    assert.equal(exported.version, 2);
    assert.equal(exported.organizationId, ORG_A);
    assert.ok(Number.isFinite(Date.parse(exported.capturedAt)));
    assert.deepEqual(exported.objects.Custom__c,
      { CreatedDate: false, Example__c: true });
  });
});

test("repository evaluator never grants field Read from unknown snapshot metadata", () => {
  const persona: Persona = { name: "New Project", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const ps: PermissionSet = {
    name: "GeneralRead", label: "GeneralRead",
    objectPermissions: [{ object: "Custom__c", allowRead: true, allowCreate: false,
      allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }],
    fieldPermissions: [],
  };
  const resolved: ResolvedPersonaPermissions = {
    persona, permissionSetGroups: [], directPermissionSets: [ps],
    permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
    mutingPermissionSets: [], mutesByGroup: new Map(),
  };
  const field = createPersonaAccessEvaluator(resolved).evaluateField("Custom__c.Field__c");
  assert.equal(field.permissionable, undefined);
  assert.equal(field.readable, false, "object read alone cannot prove a missing FLS grant");
});
