import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
import type { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import type { SalesforceFieldMetadataService } from "../src/salesforce/SalesforceFieldMetadataService.js";

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
      }),
      withSoqlPerformance(async () => {
        recordSoqlCount("queries.analyzed", 3);
        await timeSoqlOrgQuery("SELECT Id FROM EntityParticle", async () => []);
      }),
    ]);
    assert.ok(lines.some(line => line.includes("repository.scan: ")));
    assert.ok(lines.some(line => line.includes("org.access.calls: 1")));
    assert.ok(lines.some(line => line.includes("org.field_metadata.calls: 1")));
    assert.ok(lines.some(line => line.includes("queries.analyzed: 2")));
    assert.ok(lines.some(line => line.includes("queries.analyzed: 3")));
    assert.ok(!lines.some(line => line.includes("queries.analyzed: 5")), "concurrent scopes must stay isolated");
    assert.doesNotMatch(lines.join("\n"), /secret-persona|WHERE|SELECT|token-NEVER-LOG/);
    lines.length = 0;
    delete process.env.SALESFORCE_SOQL_PERF;
    await withSoqlPerformance(async () => recordSoqlCount("queries.analyzed", 5));
    assert.deepEqual(lines, [], "no timing output unless explicitly enabled");
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
    const output = await service.analyze(persona);
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
