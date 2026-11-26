import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import { scanApexSoql } from "../src/scanner/apexSoqlScanner.js";
import { buildRelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { SoqlAnalysisService } from "../src/services/SoqlAnalysisService.js";
import { recordSoqlCount, timeSoqlOrgQuery, timeSoqlPhase, withSoqlPerformance } from "../src/services/SoqlPerformanceMetrics.js";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import type { SalesforceFieldMetadataService } from "../src/salesforce/SalesforceFieldMetadataService.js";
import { SalesforceUserFieldAccessGateway } from "../src/salesforce/SalesforceUserFieldAccessGateway.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const persona: Persona = {
  name: "OMS Specialist", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [],
};

test("bounded Apex scanning preserves query order, locations and test-class exclusion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-io-apex-"));
  try {
    await mkdir(path.join(root, "classes"));
    for (let i = 15; i >= 0; i--) {
      const name = `A${String(i).padStart(2, "0")}.cls`;
      await writeFile(path.join(root, "classes", name),
        `public class A${i} {\n  void run() {\n    [SELECT Id FROM Account WITH USER_MODE];\n  }\n}\n`);
    }
    await writeFile(path.join(root, "classes", "AccountTest.cls"),
      "public class AccountTest { [SELECT Id FROM Opportunity]; }");
    const result = await scanApexSoql(root);
    assert.equal(result.length, 16);
    assert.ok(result.every(q => q.object === "Account" && q.lineNumber === 3));
    assert.deepEqual(result.map(q => path.basename(q.filePath)),
      Array.from({ length: 16 }, (_, i) => `A${String(i).padStart(2, "0")}.cls`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded relationship XML reads preserve parent and child edges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-io-rel-"));
  try {
    const fields = path.join(root, "Line_Item__c", "fields");
    await mkdir(fields, { recursive: true });
    for (let i = 0; i < 19; i++) {
      const name = `Reference${i}__c`;
      await writeFile(path.join(fields, name + ".field-meta.xml"),
        `<CustomField><fullName>${name}</fullName><type>Lookup</type><referenceTo>Account</referenceTo><relationshipName>RelatedLines${i}__r</relationshipName></CustomField>`);
    }
    const graph = await buildRelationshipMap(root);
    for (let i = 0; i < 19; i++) {
      assert.deepEqual(graph.parentTargets("Line_Item__c", `Reference${i}__r`), ["Account"]);
      assert.equal(graph.childObject("Account", `RelatedLines${i}__r`), "Line_Item__c");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository-granted SOQL fields skip unnecessary org metadata, missing grants still use live metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-io-grant-"));
  try {
    const resolved: ResolvedPersonaPermissions = {
      persona,
      permissionSetGroups: [],
      directPermissionSets: [{
        name: "TestPS", label: "TestPS",
        objectPermissions: [{
          object: "Account", allowRead: true, allowCreate: false, allowEdit: false,
          allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
        }],
        fieldPermissions: [{ field: "Account.Granted__c", readable: true, editable: false }],
      }],
      permissionSetGrants: [],
      mutingPermissionSets: [], mutesByGroup: new Map(),
    };
    resolved.permissionSetGrants = resolved.directPermissionSets.map(permissionSet => ({
      permissionSet, type: "directPermissionSet" as const,
    }));
    const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
    let metadataCalls = 0;
    let verificationCalls = 0;
    const metadata = { getField: async () => {
      metadataCalls++;
      return { permissionable: true as const, source: "LIVE" as const };
    } } as unknown as SalesforceFieldMetadataService;
    const verifier = {
      resolve: async () => ({ source: "REPOSITORY", readable: true, message: "Read granted" }),
      resolveFieldRead: async () => {
        verificationCalls++;
        return { source: "ORG_DENIED", readable: false, message: "Denied" };
      },
    } as unknown as OrgObjectReadVerificationService;
    const analyzer = new SoqlSecurityAnalyzer(resolver, root, verifier, undefined, undefined, metadata);
    const makeQuery = (field: string): SoqlQuery => ({
      filePath: path.join(root, "Example.cls"), lineNumber: 2,
      query: `SELECT ${field} FROM Account WITH USER_MODE`, object: "Account",
      fields: [field], subqueries: [], securityMode: "USER_MODE", withUserMode: true,
    });
    assert.deepEqual(await analyzer.analyze(persona, [makeQuery("Granted__c")]), []);
    assert.equal(metadataCalls, 0);
    assert.equal(verificationCalls, 0);
    const findings = await analyzer.analyze(persona, [makeQuery("Missing__c")]);
    assert.equal(metadataCalls, 1);
    assert.equal(verificationCalls, 1);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].criticality, "High");
    assert.equal(findings[0].field, "Missing__c");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SOQL profiling is opt-in, request-scoped, and never prints SOQL or sensitive strings", async () => {
  const old = process.env.SALESFORCE_SOQL_PERF;
  const previousLog = console.info;
  const lines: string[] = [];
  console.info = (...items: unknown[]) => { lines.push(items.join(" ")); };
  try {
    process.env.SALESFORCE_SOQL_PERF = "1";
    const secret = "secret-persona-or-token-NEVER-LOG";
    await Promise.all([
      withSoqlPerformance(async () => {
        recordSoqlCount("queries.analyzed", 2);
        await timeSoqlPhase("repository.scan", async () => {
          await timeSoqlOrgQuery(`SELECT Id FROM UserFieldAccess WHERE BadField = '${secret}'`, async () => []);
        });
      }, true),
      withSoqlPerformance(async () => {
        recordSoqlCount("queries.analyzed", 3);
        await timeSoqlOrgQuery("SELECT Id FROM EntityParticle", async () => []);
      }, true),
    ]);
    assert.ok(lines.some(line => line.includes("repository.scan: ")));
    assert.ok(lines.some(line => line.includes("org.access.calls: 1")));
    assert.ok(lines.some(line => line.includes("org.field_metadata.calls: 1")));
    assert.ok(lines.some(line => line.includes("queries.analyzed: 2")));
    assert.ok(lines.some(line => line.includes("queries.analyzed: 3")));
    assert.ok(!lines.some(line => line.includes("queries.analyzed: 5")), "concurrent scopes must stay isolated");
    assert.doesNotMatch(lines.join("\n"), /secret-persona|WHERE|SELECT|token-NEVER-LOG/);
    lines.length = 0;
    // Legacy environment variable is still set, but normal code ignores it.
    await withSoqlPerformance(async () => recordSoqlCount("queries.analyzed", 5));
    assert.deepEqual(lines, [], "no timing output in the normal release path");
  } finally {
    console.info = previousLog;
    if (old === undefined) delete process.env.SALESFORCE_SOQL_PERF;
    else process.env.SALESFORCE_SOQL_PERF = old;
  }
});

test("end-to-end SOQL profiling retains the existing one-sheet Excel structure and UI result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-io-service-"));
  const old = process.env.SALESFORCE_SOQL_PERF;
  const originalInfo = console.info;
  const entries: string[] = [];
  try {
    await writeFile(path.join(root, "Simple.cls"),
      "public class Simple { [SELECT Id FROM Account WITH USER_MODE]; }");
    process.env.SALESFORCE_SOQL_PERF = "1";
    console.info = (...parts: unknown[]) => { entries.push(parts.join(" ")); };
    const service = new SoqlAnalysisService(root,
      { analyze: async () => [] } as unknown as SoqlSecurityAnalyzer, path.join(root, "reports"));
    const output = await withSoqlPerformance(() => service.analyze(persona), true);
    assert.equal(output.summary.queriesAnalyzed, 1);
    assert.equal(output.summary.totalFindings, 0);
    assert.equal(output.summary.userModeQueries, 1);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.reports.summaryReportPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Summary"]);
    assert.equal(workbook.getWorksheet("Summary")?.getCell("B2").value, persona.name);
    for (const phase of ["total", "repository.scan", "security.total", "excel.total", "excel.grouping", "excel.serialization"]) {
      assert.ok(entries.some(line => line.startsWith(`[SOQL Perf] ${phase}:`)), phase);
    }
  } finally {
    console.info = originalInfo;
    if (old === undefined) delete process.env.SALESFORCE_SOQL_PERF;
    else process.env.SALESFORCE_SOQL_PERF = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental Apex scan detects same-size changes, added files and removals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-incremental-"));
  try {
    const first = path.join(root, "First.cls");
    const later = path.join(root, "Second.cls");
    const code = (object: string) => `public class X { [SELECT Id FROM ${object} WITH USER_MODE]; }`;
    await writeFile(first, code("Account"));
    assert.equal((await scanApexSoql(root))[0].object, "Account");
    assert.equal((await scanApexSoql(root))[0].object, "Account", "warm scan reuses unchanged parsed queries");

    // Account and Contact are the same length; size-only invalidation is unsafe.
    await writeFile(first, code("Contact"));
    assert.equal((await scanApexSoql(root))[0].object, "Contact",
      "same-size edit must invalidate the cached parse");
    await writeFile(later, code("Opportunity"));
    const added = await scanApexSoql(root);
    assert.deepEqual(added.map(q => q.object), ["Contact", "Opportunity"]);

    await unlink(first);
    const removed = await scanApexSoql(root);
    assert.deepEqual(removed.map(q => q.object), ["Opportunity"],
      "deleted classes must not survive cache reuse");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("simultaneous Apex scans share in-flight work without changing query order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-scan-parallel-"));
  try {
    await mkdir(path.join(root, "classes"), { recursive: true });
    for (let i = 0; i < 24; i++) {
      await writeFile(path.join(root, "classes", `X${String(i).padStart(2, "0")}.cls`),
        `public class X${i} { [SELECT Id FROM Account WITH USER_MODE]; }`);
    }
    const [first, second] = await Promise.all([scanApexSoql(root), scanApexSoql(root)]);
    assert.deepEqual(second, first);
    assert.equal(first.length, 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one prepared inventory supports different personas without reusing permission decisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-shared-prepare-"));
  try {
    const granted = { ...persona, name: "Granted Persona" };
    const denied = { ...persona, name: "Denied Persona" };
    const permissionSetFor = (name: string, hasRead: boolean) => ({
      name: `PS-${name}`, label: name,
      objectPermissions: [{
        object: "Account", allowRead: true, allowCreate: false, allowEdit: false,
        allowDelete: false, viewAllRecords: false, modifyAllRecords: false,
        viewAllFields: false,
      }],
      fieldPermissions: hasRead ? [{
        field: "Account.Industry", readable: true, editable: false,
      }] : [],
    });
    const resolver = { resolve: async (selected: Persona): Promise<ResolvedPersonaPermissions> => {
      const ps = permissionSetFor(selected.name, selected.name === granted.name);
      return {
        persona: selected, permissionSetGroups: [], directPermissionSets: [ps],
        permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
        mutingPermissionSets: [], mutesByGroup: new Map(),
      };
    }} as unknown as PersonaPermissionResolver;
    let orgChecks = 0;
    const verifier = {
      resolve: async () => ({ source: "REPOSITORY", readable: true, message: "Read grant" }),
      resolveFieldRead: async () => {
        orgChecks++;
        return { source: "ORG_DENIED", readable: false, message: "Read denied" };
      },
    } as unknown as OrgObjectReadVerificationService;
    const metadata = { getField: async () => ({
      source: "LIVE" as const, permissionable: true,
    }) } as unknown as SalesforceFieldMetadataService;
    const analyzer = new SoqlSecurityAnalyzer(resolver, root, verifier, undefined, undefined, metadata);
    const queries: SoqlQuery[] = [{
      object: "Account", fields: ["Industry"], subqueries: [], filePath: path.join(root, "Example.cls"),
      lineNumber: 1, query: "SELECT Industry FROM Account WITH USER_MODE",
      withUserMode: true, securityMode: "USER_MODE",
    }];
    const prepared = await analyzer.prepare(queries);
    const [allowed, blocked] = await Promise.all([
      analyzer.analyzePrepared(granted, prepared),
      analyzer.analyzePrepared(denied, prepared),
    ]);
    assert.deepEqual(allowed, []);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].criticality, "High");
    assert.equal(orgChecks, 1, "only the persona missing a repository grant should query Salesforce");
    const direct = await analyzer.analyze(denied, queries);
    assert.deepEqual(blocked, direct, "reused preparation must match the original per-persona result");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compound parent indexing handles large Describe without changing field semantics", async () => {
  const fields = [
    { name: "BillingAddress", type: "address" },
    { name: "BillingCity", type: "string" },
    ...Array.from({ length: 1800 }, (_, i) => ({
      name: `Field${i}__c`, type: "string",
    })),
  ];
  let describes = 0;
  const connection = {
    get status() { return { organizationId: "00D000000000001", instanceUrl: "https://example.my.salesforce.com" }; },
    async describeSObject() {
      describes++;
      return { name: "Account", fields, childRelationships: [] };
    },
    async queryAll() { throw new Error("Not needed for compound-map test"); },
  } as unknown as SalesforceOrgConnection;
  const gateway = new SalesforceUserFieldAccessGateway(connection);
  assert.equal(await gateway.compoundParent("Account", "BillingCity"), "BillingAddress");
  assert.equal(await gateway.compoundParent("Account", "Field1799__c"), null);
  assert.equal(describes, 1, "one Describe is enough for all compound-field lookups");
});

test("org verification bounds concurrent field checks and preserves all outcomes", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const mock = {
    getVerificationScope: () => "test-org",
    verifyFieldRead: async (_persona: Persona, object: string, field: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => setTimeout(resolve, 8));
      calls.push(object + "." + field);
      inFlight--;
      return {
        object, field, outcome: "VERIFIED" as const, matchedUsers: 1,
        checkedUsers: 1, sampled: false, message: "Accessible",
      };
    },
  };
  const service = new OrgObjectReadVerificationService(
    { statusNeutralObjectRead: new Set() },
    mock as unknown as import("../src/salesforce/SalesforcePersonaAccessVerifier.js").SalesforcePersonaAccessVerifier,
  );
  const decisions = await Promise.all(
    Array.from({ length: 14 }, (_, i) => service.resolveField(persona, "Account", `Custom${i}__c`)),
  );
  assert.equal(calls.length, 14, "all unique fields must be checked");
  assert.equal(inFlight, 0);
  assert.ok(maxInFlight <= 3, `org concurrency exceeded its cap: ${maxInFlight}`);
  assert.ok(decisions.every(result => result?.outcome === "VERIFIED"));
});

test("Apex scanner fast-path ignores static SOQL text in comments and strings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-quick-mask-"));
  try {
    const file = path.join(root, "One.cls");
    await writeFile(file, [
      "public class One {",
      "  String literal = '[SELECT Id FROM Account]';",
      "  // [SELECT Name FROM Contact]",
      "  /* [SELECT Amount FROM Opportunity] */",
      "  void run() { [   SELECT Id FROM OrderSummary WITH USER_MODE]; }",
      "}",
    ].join("\n"));
    const found = await scanApexSoql(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].object, "OrderSummary");
    assert.equal(found[0].lineNumber, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
