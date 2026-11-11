import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { normalizeSoqlScope, selectScopedSoqlQueries } from "../src/analyzer/soqlAnalysisScope.js";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";

function makeQuery(source: string, apexClass: string) {
  const queries = extractSoqlQueries("List<SObject> rows = [" + source + "];",
    path.join("force-app", "main", "default", "classes", apexClass + ".cls"));
  assert.equal(queries.length, 1);
  return queries[0];
}
const account = makeQuery("SELECT Custom_Amount__c FROM Account", "AccountHandler");
const contacts = makeQuery(
  "SELECT Id, (SELECT Custom_Field__c FROM Contacts WHERE Email != null) FROM Account", "OrderHandler");
const opportunity = makeQuery("SELECT StageName FROM Opportunity", "OpportunityHandler");
const all = [account, contacts, opportunity];

async function setup() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "sf-analyzer-scope-"));
  const base = path.join(repo, "force-app", "main", "default", "objects");
  const contactFields = path.join(base, "Contact", "fields");
  await mkdir(contactFields, { recursive: true });
  await writeFile(path.join(contactFields, "AccountId.field-meta.xml"),
    "<CustomField><referenceTo>Account</referenceTo><relationshipName>Contacts</relationshipName></CustomField>");
  await mkdir(path.join(repo, "manifest"));
  return { repo, remove: () => rm(repo, { force: true, recursive: true }) };
}

test("legacy missing scope defaults to full scan", () => {
  assert.deepEqual(normalizeSoqlScope(undefined), { mode: "FULL" });
});
test("full mode retains every query and never needs a manifest", async () => {
  const result = await selectScopedSoqlQueries(".", all, { mode: "FULL" });
  assert.equal(result.queries.length, 3);
  assert.equal(result.scope.totalQueriesFound, 3);
  assert.equal(result.scope.mode, "FULL");
  assert.equal(result.scope.expandedToFull, false);
});
test("selective ApexClass checks only selected class queries", async () => {
  const { repo, remove } = await setup();
  try {
    const scope = normalizeSoqlScope({ mode: "SELECTIVE", components: ["ApexClass:OrderHandler"] });
    const result = await selectScopedSoqlQueries(repo, all, scope);
    assert.deepEqual(result.queries.map(q => q.object), ["Account"]);
    assert.equal(result.queries.length, 1);
    assert.equal(result.queries[0].filePath, contacts.filePath);
    assert.equal(result.scope.queriesSelected, 1);
  } finally { await remove(); }
});
test("selective CustomField matches resolved nested child query", async () => {
  const { repo, remove } = await setup();
  try {
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["CustomField:Contact.Custom_Field__c"] });
    assert.deepEqual(result.queries.map(q => q.filePath), [contacts.filePath]);
  } finally { await remove(); }
});
test("CustomField selection includes fields referenced only by child WHERE", async () => {
  const { repo, remove } = await setup();
  try {
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["CustomField:Contact.Email"] });
    assert.deepEqual(result.queries.map(q => q.filePath), [contacts.filePath]);
  } finally { await remove(); }
});
test("CustomObject matches nested queried objects as well as root objects", async () => {
  const { repo, remove } = await setup();
  try {
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["CustomObject:Contact"] });
    assert.deepEqual(result.queries.map(q => q.filePath), [contacts.filePath]);
  } finally { await remove(); }
});
test("CustomField:Object.* matches any field from that object", async () => {
  const { repo, remove } = await setup();
  try {
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["CustomField:Contact.*"] });
    assert.deepEqual(result.queries.map(q => q.filePath), [contacts.filePath]);
  } finally { await remove(); }
});
test("multiple selective components combine as union", async () => {
  const { repo, remove } = await setup();
  try {
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["ApexClass:OpportunityHandler", "CustomField:Contact.Custom_Field__c"] });
    assert.deepEqual(result.queries.map(q => q.filePath), [contacts.filePath, opportunity.filePath]);
  } finally { await remove(); }
});
test("package.xml selects Salesforce metadata members and supports single-element types", async () => {
  const { repo, remove } = await setup();
  try {
    await writeFile(path.join(repo, "manifest", "package.xml"),
      '<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">' +
      "<types><members>OrderHandler</members><name>ApexClass</name></types><version>66.0</version></Package>");
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", manifestPath: "manifest/package.xml" });
    assert.equal(result.queries.length, 1);
    assert.equal(result.scope.components[0], "ApexClass:OrderHandler");
    assert.equal(result.scope.manifestPath, "manifest/package.xml");
  } finally { await remove(); }
});
test("package.xml multiple groups can select fields, object and classes", async () => {
  const { repo, remove } = await setup();
  try {
    await writeFile(path.join(repo, "manifest", "package.xml"),
      "<Package><types><members>Contact.Custom_Field__c</members><name>CustomField</name></types>" +
      "<types><members>OpportunityHandler</members><name>ApexClass</name></types><version>66.0</version></Package>");
    const result = await selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", manifestPath: "manifest/package.xml" });
    assert.equal(result.queries.length, 2);
  } finally { await remove(); }
});
test("PermissionSet changes deliberately expand selection to all queries", async () => {
  const result = await selectScopedSoqlQueries(".", all,
    { mode: "SELECTIVE", components: ["PermissionSet:CSR_Extra_Read"] });
  assert.equal(result.queries.length, 3);
  assert.equal(result.scope.expandedToFull, true);
  assert.match(result.scope.warnings.join(" "), /full SOQL scan/i);
});
test("Profile changes deliberately expand selection to all queries", async () => {
  const result = await selectScopedSoqlQueries(".", all,
    { mode: "SELECTIVE", components: ["Profile:CSR"] });
  assert.equal(result.queries.length, 3);
  assert.equal(result.scope.expandedToFull, true);
});
test("unknown metadata types never silently yield a clean selective result", async () => {
  const result = await selectScopedSoqlQueries(".", all,
    { mode: "SELECTIVE", components: ["Flow:UpdateOrder"] });
  assert.equal(result.queries.length, 3);
  assert.equal(result.scope.expandedToFull, true);
  assert.ok(result.scope.warnings.some(x => x.includes("Flow, trigger")));
});
test("wildcard expansion is explicit rather than reporting narrow coverage", async () => {
  const result = await selectScopedSoqlQueries(".", all,
    { mode: "SELECTIVE", components: ["ApexClass:*"] });
  assert.equal(result.scope.queriesSelected, 3);
  assert.equal(result.scope.expandedToFull, true);
});
test("empty matching selection warns instead of asserting no security issues", async () => {
  const result = await selectScopedSoqlQueries(".", all,
    { mode: "SELECTIVE", components: ["ApexClass:NonexistentHandler"] });
  assert.equal(result.queries.length, 0);
  assert.match(result.scope.warnings.join(" "), /not proof/);
});
test("missing metadata selection fails validation", () => {
  assert.throws(() => normalizeSoqlScope({ mode: "SELECTIVE" }), /requires a package.xml/i);
});
test("malformed metadata member fails validation", async () => {
  const { repo, remove } = await setup();
  try {
    await assert.rejects(selectScopedSoqlQueries(repo, all,
      { mode: "SELECTIVE", components: ["CustomField:NotAField"] }), /CustomField must use/);
  } finally { await remove(); }
});
test("directory traversal manifest is rejected before reading", () => {
  assert.throws(() => normalizeSoqlScope({ mode: "SELECTIVE", manifestPath: "../outside.xml" }),
    /repository-relative file path/);
});
test("manifest escaping repository is rejected at read time", async () => {
  const { repo, remove } = await setup();
  try {
    const outside = await mkdtemp(path.join(os.tmpdir(), "sf-manifest-outside-"));
    try {
      await writeFile(path.join(outside, "package.xml"),
        "<Package><types><members>Example</members><name>ApexClass</name></types></Package>");
      const relative = path.relative(repo, path.join(outside, "package.xml"));
      await assert.rejects(selectScopedSoqlQueries(repo, all,
        { mode: "SELECTIVE", manifestPath: relative }), /inside the configured repository/);
    } finally { await rm(outside, { force: true, recursive: true }); }
  } finally { await remove(); }
});
test("Excel records scope mode, number selected, and expansion warnings", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sf-scope-excel-"));
  try {
    const scope = {
      mode: "SELECTIVE" as const, totalQueriesFound: 10, queriesSelected: 3,
      components: ["PermissionSet:CSR"], expandedToFull: true, warnings: ["Scope expanded"],
    };
    const paths = await writeSoqlReport(temp, "CSR", 3, [], scope);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(paths.summaryReportPath);
    const sheet = workbook.getWorksheet("Analysis Scope");
    assert.ok(sheet);
    assert.equal(sheet.getRow(2).getCell(2).value, "Selective Metadata");
    assert.equal(sheet.getRow(4).getCell(2).value, 3);
    assert.equal(sheet.getRow(5).getCell(2).value, "Yes");
  } finally { await rm(temp, { force: true, recursive: true }); }
});
