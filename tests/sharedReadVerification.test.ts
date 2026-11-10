import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";
import type { SoqlSecurityFinding } from "../src/models/SoqlSecurityFinding.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence, OrgAccessOutcome } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";

const persona: Persona = {
  name: "OTC", profile: "CSR", permissionSetGroups: [], permissionSets: [], mutingPermissionSets: [],
};
const POLICY = { statusNeutralObjectRead: new Set(["orderitemsummary"]) };

function verifier(objectOutcome: OrgAccessOutcome, fieldOutcome: OrgAccessOutcome) {
  const calls = { objects: [] as string[], fields: [] as string[] };
  const evidence = (object: string, field: string | undefined, outcome: OrgAccessOutcome): OrgObjectAccessEvidence => ({
    object, ...(field ? { field } : {}), outcome,
    checkedUsers: outcome === "UNVERIFIED" ? 0 : 2,
    matchedUsers: outcome === "UNVERIFIED" ? 0 : 2,
    sampled: false,
    message: outcome === "VERIFIED" ? "Access verified from Salesforce." :
      outcome === "DENIED" ? "Salesforce confirmed missing access." : "No matching active org user.",
    ...(outcome === "UNVERIFIED" ? { unverifiedReason: "NO_MATCHING_USERS" as const } : {}),
  });
  const mock = {
    getVerificationScope: () => "org123",
    verifyObjectRead: async (_: Persona, object: string) => {
      calls.objects.push(object);
      return evidence(object, undefined, objectOutcome);
    },
    verifyFieldRead: async (_: Persona, object: string, field: string) => {
      calls.fields.push(`${object}.${field}`);
      return evidence(object, field, fieldOutcome);
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  return { service: new OrgObjectReadVerificationService(POLICY, mock), calls };
}

function resolver(object: string, objectReadable: boolean): PersonaPermissionResolver {
  const ps: PermissionSet = {
    name: "Test", label: "Test", fieldPermissions: [],
    objectPermissions: [{ object, allowRead: objectReadable, allowCreate: false,
      allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }],
  };
  const resolved: ResolvedPersonaPermissions = {
    persona, permissionSetGroups: [], directPermissionSets: [ps],
    mutingPermissionSets: [], permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
    mutesByGroup: new Map(),
  };
  return { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
}

function query(object: string, fields: string[], lineNumber = 10): SoqlQuery {
  return { filePath: "classes/Test.cls", lineNumber, object, fields,
    query: `SELECT ${fields.join(", ")} FROM ${object} WITH USER_MODE`, subqueries: [],
    withUserMode: true, securityMode: "USER_MODE" };
}

async function analyze(object: string, objectRead: boolean, queries: SoqlQuery[],
  service: OrgObjectReadVerificationService) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "soql-shared-"));
  try { return await new SoqlSecurityAnalyzer(resolver(object, objectRead), dir, service).analyze(persona, queries); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("repository grants bypass org calls", async () => {
  const { service, calls } = verifier("DENIED", "DENIED");
  const result = await service.resolve(persona, "Account", true);
  const field = await service.resolveFieldRead(persona, "Account", "BillingCity", true);
  assert.equal(result.source, "REPOSITORY");
  assert.equal(field.source, "REPOSITORY");
  assert.deepEqual(calls.objects, []);
  assert.deepEqual(calls.fields, []);
});

test("generic object Read verified from org is LOW once per referenced query", async () => {
  const { service, calls } = verifier("VERIFIED", "VERIFIED");
  const findings = await analyze("OrderSummary", false,
    [query("OrderSummary", ["Id", "CreatedDate"]), query("OrderSummary", ["Id"], 20)], service);
  const objects = findings.filter((f) => f.findingType === "OBJECT_READ");
  assert.equal(objects.length, 2);
  assert.ok(objects.every((f) => f.criticality === "Low" && f.severity === "INFO"));
  assert.equal(calls.objects.length, 1);
  // Object permission isn't duplicated for each selected field.
  assert.equal(objects[0].field, "(Object Read Missing)");
});

test("denied object Read produces one HIGH finding, never cascaded false field errors", async () => {
  const { service, calls } = verifier("DENIED", "DENIED");
  const findings = await analyze("OrderSummary", false,
    [query("OrderSummary", ["Id", "CreatedDate", "Status"])], service);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, "High");
  assert.equal(findings[0].findingType, "OBJECT_READ");
  assert.deepEqual(calls.fields, []);
});

test("missing field FLS on ANY object checks Salesforce, confirmed denial is High", async () => {
  const { service, calls } = verifier("VERIFIED", "DENIED");
  const findings = await analyze("Contact", true,
    [query("Contact", ["Custom_Permission_Field__c"])], service);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, "High");
  assert.equal(findings[0].findingType, "FIELD_READ");
  assert.deepEqual(calls.fields, ["Contact.Custom_Permission_Field__c"]);
});

test("custom compound address components check org instead of being ignored", async () => {
  const { service, calls } = verifier("VERIFIED", "VERIFIED");
  const findings = await analyze("Account", true,
    [query("Account", ["Remit_Address__City__s"])], service);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, "Low");
  assert.deepEqual(calls.fields, ["Account.Remit_Address__City__s"]);
});

test("no matching org user is Unable to verify, not High", async () => {
  const { service } = verifier("UNVERIFIED", "UNVERIFIED");
  const findings = await analyze("OrderSummary", false, [query("OrderSummary", ["Id"])], service);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, "Unable to verify");
  assert.equal(findings[0].severity, "REVIEW");
});

test("status neutral policy does not exempt any OrderItemSummary field", async () => {
  const { service } = verifier("VERIFIED", "DENIED");
  const object = await service.resolve(persona, "OrderItemSummary", false);
  const field = await service.resolveFieldRead(persona, "OrderItemSummary", "Order_Quantity_Change__c", false);
  assert.equal(object.statusNeutral, true);
  assert.equal(field.source, "ORG_DENIED");
});

test("shared gateway caches identical object and field org checks", async () => {
  const { service, calls } = verifier("VERIFIED", "VERIFIED");
  await Promise.all([
    service.resolve(persona, "Account", false), service.resolve(persona, "Account", false),
    service.resolveFieldRead(persona, "Account", "Industry", false),
    service.resolveFieldRead(persona, "Account", "Industry", false),
  ]);
  assert.deepEqual(calls.objects, ["Account"]);
  assert.deepEqual(calls.fields, ["Account.Industry"]);
});

test("Excel contains HIGH, LOW and Unable to verify with explanation columns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "soql-report-"));
  const example = (criticality: "High" | "Low" | "Unable to verify", lineNumber: number): SoqlSecurityFinding => ({
    severity: criticality === "High" ? "ERROR" : criticality === "Low" ? "INFO" : "REVIEW",
    criticality, verificationSource: criticality === "High" ? "ORG_DENIED" :
      criticality === "Low" ? "ORG_VERIFIED" : "UNVERIFIED",
    findingType: "FIELD_READ", filePath: "classes/Test.cls", lineNumber,
    object: "Account", field: `Test_Field_${lineNumber}__c`, query: "SELECT ... FROM Account",
    withUserMode: true, reason: `Explanation for ${criticality}`,
  });
  try {
    const report = await writeSoqlReport(dir, "OTC", 3,
      [example("High", 10), example("Low", 11), example("Unable to verify", 12)]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.summaryReportPath);
    const summary = workbook.getWorksheet("Summary")!;
    const refs = workbook.getWorksheet("References")!;
    assert.equal(summary.getCell("E6").value, "Criticality / Severity");
    assert.equal(summary.getCell("F6").value, "Explanation");
    assert.deepEqual([7, 8, 9].map((row) => summary.getCell(`E${row}`).value),
      ["High", "Unable to verify", "Low"]);
    assert.equal(refs.getCell("F1").value, "Criticality / Severity");
    assert.equal(refs.getCell("G1").value, "Explanation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
