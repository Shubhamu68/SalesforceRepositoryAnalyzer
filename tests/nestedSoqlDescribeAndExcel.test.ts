import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { SalesforceRelationshipMetadataService } from "../src/salesforce/SalesforceRelationshipMetadataService.js";
import { collectQueryFields } from "../src/analyzer/soqlQueryFieldResolver.js";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { SoqlSecurityFinding } from "../src/models/SoqlSecurityFinding.js";

const parse = (query: string) => extractSoqlQueries("List<SObject> items=[" + query + "];", "classes/Test.cls")[0];

test("Salesforce Describe fills missing standard and custom child relationships", async () => {
  const calls: string[] = [];
  const descriptions = {
    Account: {
      fields: [], childRelationships: [
        { relationshipName: "ChildAccounts", childSObject: "Account", field: "ParentId" },
        { relationshipName: "Custom_Children__r", childSObject: "CustomChild__c", field: "Account__c" },
      ],
    },
    CustomChild__c: {
      fields: [{ name: "Account__c", relationshipName: "Account__r", referenceTo: ["Account"] }],
      childRelationships: [],
    },
  };
  const org = { describeSObject: async (name: string) => {
    calls.push(name);
    if (name in descriptions) return descriptions[name as keyof typeof descriptions];
    throw new Error("No describe available");
  } } as unknown as SalesforceOrgConnection;
  const graph = new RelationshipMap();
  const hydrator = new SalesforceRelationshipMetadataService(org).createHydrator(graph);
  const q = parse("SELECT Id, (SELECT Name FROM ChildAccounts), (SELECT Account__r.Name FROM Custom_Children__r) FROM Account");
  assert.ok(collectQueryFields(q, graph).unresolved.length > 0);
  await hydrator.hydrateQuery(q);
  const second = collectQueryFields(q, graph);
  assert.equal(second.unresolvedEntries.length, 0);
  assert.equal(graph.childObject("Account", "Custom_Children__r"), "CustomChild__c");
  assert.ok(second.fields.some(f => f.object === "Account" && f.field === "Name"));
  assert.ok(calls.includes("Account"));
});

test("nested child parent path is hydrated using its own object describe", async () => {
  const calls: string[] = [];
  const org = { describeSObject: async (object: string) => {
    calls.push(object);
    if (object === "Account") return { fields: [], childRelationships: [{ relationshipName: "Contacts", childSObject: "Contact" }] };
    if (object === "Contact") return { fields: [{ name: "OwnerId", relationshipName: "Owner", referenceTo: ["User"] }], childRelationships: [] };
    return { fields: [], childRelationships: [] };
  } } as unknown as SalesforceOrgConnection;
  const graph = new RelationshipMap();
  const query = parse("SELECT Name, (SELECT Owner.Email FROM Contacts) FROM Account");
  const hydrator = new SalesforceRelationshipMetadataService(org).createHydrator(graph);
  const initial = collectQueryFields(query, graph);
  await hydrator.hydrateQuery(query, initial.unresolved);
  assert.ok(collectQueryFields(query, graph).fields.some(f => f.object === "User" && f.field === "Email"));
  assert.ok(calls.includes("Contact"));
});

test("metadata Describe failure remains unresolved and produces a warning, never fabricated access", async () => {
  const org = { describeSObject: async () => { throw new Error("Missing access"); } } as unknown as SalesforceOrgConnection;
  const graph = new RelationshipMap();
  const q = parse("SELECT Name, (SELECT Id FROM MissingChildren__r) FROM Account");
  const warnings = await new SalesforceRelationshipMetadataService(org).createHydrator(graph).hydrateQuery(q);
  assert.ok(warnings.some(x => x.includes("Could not retrieve")));
  assert.equal(collectQueryFields(q, graph).unresolvedEntries[0].kind, "RELATIONSHIP");
});

test("Excel retains one eight-column Summary with nested Apex references", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sf-nested-report-"));
  try {
    const findings: SoqlSecurityFinding[] = [
      {
        severity: "ERROR", criticality: "High", findingType: "FIELD_READ",
        verificationSource: "ORG_DENIED",
        object: "Contact", field: "Custom_Field__c", query: "SELECT ...",
        filePath: "classes/Test.cls", lineNumber: 12, withUserMode: true,
        declaredMode: "USER_MODE", effectiveMode: "USER_MODE",
        runtimeImpact: "Potential access failure", apiVersion: 66,
        reason: "Selected user lacks access", relationshipPath: "Account -> Contacts", queryLevel: 2,
      },
      {
        severity: "INFO", criticality: "Low", findingType: "FIELD_READ",
        verificationSource: "ORG_DENIED",
        object: "Contact", field: "Custom_Field__c", query: "SELECT ...",
        filePath: "classes/Test2.cls", lineNumber: 30, withUserMode: false,
        declaredMode: "SYSTEM_MODE", effectiveMode: "SYSTEM_MODE",
        runtimeImpact: "Not enforced by query", apiVersion: 66,
        reason: "System-mode advisory", relationshipPath: "Account -> Contacts", queryLevel: 2,
      },
    ];
    const output = await writeSoqlReport(tmp, "OTC", 2, findings);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.summaryReportPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Summary"]);
    const summary = workbook.getWorksheet("Summary")!;
    assert.equal(summary.columnCount, 8);
    assert.equal(summary.getCell("H6").value, "Effective Query Mode");
    assert.equal(summary.getCell("I6").value, null);
    assert.equal(summary.getCell("J6").value, null);
    assert.equal(summary.getCell("K6").value, null);
    assert.equal(summary.getCell("E7").value, "High");
    assert.equal(summary.getCell("C7").value, 2);
    assert.equal(summary.getCell("G7").value, "Mixed");
    assert.equal(summary.getCell("H7").value, "Mixed");
    assert.match(String(summary.getCell("F7").value), /Severity differs across SOQL queries/);
    const lines = summary.getCell("D7").value;
    assert.ok(lines && typeof lines === "object" && "richText" in lines);
    assert.match((lines.richText as Array<{ text: string }>).map(x => x.text).join(""), /Line Number 12/);
    assert.match((lines.richText as Array<{ text: string }>).map(x => x.text).join(""), /Line Number 30/);
    assert.deepEqual(Object.keys(output), ["summaryReportPath"]);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(tmp), [path.basename(output.summaryReportPath)]);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
