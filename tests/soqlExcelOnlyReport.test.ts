import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";
import type { SoqlSecurityFinding } from "../src/models/SoqlSecurityFinding.js";
import {SoqlAnalysisService} from "../src/services/SoqlAnalysisService.js";
import type {SoqlSecurityAnalyzer} from "../src/analyzer/soqlSecurityAnalyzer.js";
import type {Persona} from "../src/models/Persona.js";

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


test("runtime configuration dependency is propagated to the actual Excel Explanation cell without trace logging",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"sf-excel-backward-reason-"));
  try{
    const source=[
      "public class Report {",
      " public static void run(String reportName){",
      "  Report_Config__mdt cfg=getConfig(reportName);",
      "  String obj=cfg.Object_API_Name__c;",
      "  List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set_Name__c);",
      "  String q='SELECT '+String.join(paths,',')+' FROM '+obj;",
      "  Database.query(q);",
      " }",
      " private static Report_Config__mdt getConfig(String key){",
      "  if(String.isBlank(key)){return null;}",
      "  List<Report_Config__mdt> cfgs=[SELECT DeveloperName,Object_API_Name__c,Field_Set_Name__c FROM Report_Config__mdt WHERE DeveloperName=:key AND Active__c=true LIMIT 1];",
      "  return cfgs.isEmpty()?null:cfgs[0];",
      " }",
      "}"
    ].join("\n");
    await writeFile(path.join(root,"Report.cls"),source);
    const analyzer={analyze:async()=>[] as SoqlSecurityFinding[]} as unknown as SoqlSecurityAnalyzer;
    const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"reports")).analyze({name:"Test"} as Persona);
    assert.equal(result.findings.length,1,JSON.stringify(result.findings));
    assert.equal(result.findings[0].severity,"REVIEW");
    assert.equal(result.findings[0].criticality,"Unable to verify");
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(result.reports.summaryReportPath);
    const sheet=workbook.getWorksheet("Summary")!;
    const explanation=String(sheet.getCell("F7").value);
    assert.match(explanation,/Backward dependency assessment/);
    assert.match(explanation,/reportName.*no proven source caller/);
    assert.match(explanation,/Custom Metadata.*Object_API_Name__c/);
    assert.match(explanation,/getConfig.*getFieldListFromFieldSet/);
    assert.match(explanation,/OLS\/FLS analysis was not performed/);
    assert.equal(sheet.getCell("E7").value,"Unable to verify");
    assert.equal(sheet.getCell("E7").font.color?.argb,"FFB42332");
  }finally{await rm(root,{recursive:true,force:true});}
});
