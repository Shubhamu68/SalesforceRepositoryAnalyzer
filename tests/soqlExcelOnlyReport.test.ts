import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";
import type { SoqlSecurityFinding } from "../src/models/SoqlSecurityFinding.js";

const example: SoqlSecurityFinding = {
  severity: "ERROR",
  criticality: "High",
  verificationSource: "ORG_DENIED",
  object: "OrderSummary",
  field: "New_Field__c",
  filePath: "classes/SummaryHandler.cls",
  lineNumber: 10,
  query: "SELECT New_Field__c FROM OrderSummary WITH USER_MODE",
  withUserMode: true,
  reason: "Missing field Read permission",
  effectiveMode: "USER_MODE",
  runtimeImpact: "Potential access failure",
};

test("report writer produces exactly one Excel workbook and no TXT files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-excel-only-"));
  const output = path.join(root, "reports");
  try {
    const result = await writeSoqlReport(output, "OMS Specialist", 2, [example]);
    assert.deepEqual(Object.keys(result), ["summaryReportPath"]);
    assert.match(path.basename(result.summaryReportPath), /^soql-fls-OMS_Specialist-.*-summary\.xlsx$/);
    assert.deepEqual(await readdir(output), [path.basename(result.summaryReportPath)]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.summaryReportPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Summary"]);
    const sheet = workbook.getWorksheet("Summary")!;
    assert.equal(sheet.columnCount, 8);
    assert.equal(sheet.getCell("B2").value, "OMS Specialist");
    assert.equal(sheet.getCell("B3").value, 2);
    assert.equal(sheet.getCell("B4").value, 1);
    assert.equal(sheet.getCell("A7").value, "OrderSummary");
    assert.equal(sheet.getCell("B7").value, "New_Field__c");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no findings still produces one valid Excel Summary workbook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-excel-only-empty-"));
  try {
    const result = await writeSoqlReport(root, "OMS View Only", 0, []);
    assert.deepEqual(await readdir(root), [path.basename(result.summaryReportPath)]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.summaryReportPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Summary"]);
    assert.equal(workbook.getWorksheet("Summary")?.getCell("B4").value, 0);
    assert.equal(workbook.getWorksheet("Summary")?.getCell("H6").value, "Effective Query Mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing legacy TXT reports remain untouched; no new TXT report is created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-excel-only-legacy-"));
  const legacyName = "old-errors.txt";
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, legacyName), "previous report", "utf8");
    const result = await writeSoqlReport(root, "OMS Specialist", 1, [example]);
    assert.deepEqual((await readdir(root)).sort(),
      [legacyName, path.basename(result.summaryReportPath)].sort());
    assert.equal(await readFile(path.join(root, legacyName), "utf8"), "previous report");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
