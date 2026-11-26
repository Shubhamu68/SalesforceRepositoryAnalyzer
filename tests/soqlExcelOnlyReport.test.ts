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
    // The user-facing explanation is concise; source-level blockers remain in diagnostics.
    assert.equal(explanation,"OLS/FLS could not be fully verified because the dynamic query’s object or field references depend on runtime inputs.");
    assert.ok(explanation.length<=200,explanation);
    assert.doesNotMatch(explanation,/Why the query could not be fully resolved|Object_API_Name__c|getFieldListFromFieldSet|OLS\/FLS analysis was not performed/);
    assert.equal(sheet.getCell("E7").value,"Unable to verify");
    assert.equal(sheet.getCell("E7").font.color?.argb,"FFB42332");
  }finally{await rm(root,{recursive:true,force:true});}
});


test("Excel finalization removes only complete finite site review, preserving genuine access findings and runtime reviews",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-excel-coverage-"));
 try{
   const source="public class Q {public static void run(String kind){try{String q='';if(kind=='A'){q='SELECT Id,Name FROM Account WHERE Id=:rid';}else if(kind=='C'){q='SELECT Id,Email FROM Contact WHERE Id=:rid';}q+=' WITH SECURITY_ENFORCED';Database.query(q);}catch(Exception e){System.debug(e);}}public static void runtime(String objectName){Database.query('SELECT Id FROM '+objectName);}}";
   await writeFile(path.join(root,"Q.cls"),source);
   const analyzer={analyze:async(_persona:Persona,queries:import("../src/models/SoqlQuery.js").SoqlQuery[])=>{
     const accepted=queries.filter(q=>q.referenceCoverage==="COMPLETE_FINITE_DOMAIN");
     assert.equal(accepted.length,2);
     const q=accepted.find(q=>q.object==="Account")!;
     return [{...example,filePath:q.filePath,lineNumber:q.lineNumber,queryVariantId:q.queryVariantId,object:q.object,field:"Name",query:q.query},
       {...example,severity:"REVIEW",criticality:"Unable to verify",verificationSource:"UNVERIFIED",object:"Contact",field:"Email",reason:"Org permission evidence unavailable"}] as SoqlSecurityFinding[];
   }} as unknown as SoqlSecurityAnalyzer;
   const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"reports")).analyze({name:"Test"} as Persona);
   assert.equal(result.findings.length,3);
   assert.equal(result.findings.filter(f=>f.object==="Dynamic SOQL").length,1);
   assert.equal(result.findings.filter(f=>f.criticality==="High").length,1);
   assert.equal(result.findings.filter(f=>f.criticality==="Unable to verify").length,2);
   const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(result.reports.summaryReportPath);
   const rows=workbook.getWorksheet("Summary")!.getRows(7,3)!;
   assert.equal(rows.filter(r=>r.getCell(1).value==="Dynamic SOQL").length,1);
   assert.equal(rows.filter(r=>r.getCell(5).value==="Unable to verify").length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("existing variants: actual Excel high for confirmed denial, low for known grants, unknown remains a specific review",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-existing-variants-"));
 try{
   const source=["public class Service {",
    "public static void one(String field){Database.query('SELECT Id,'+field+' FROM Account');}",
    "public static void two(String field){Database.query('SELECT Id,'+field+' FROM Contact');}",
    "public static void three(String field){Database.query('SELECT Id,'+field+' FROM Lead');}",
    "public static void other(String obj){Database.query('SELECT Id FROM '+obj);}",
    "public static void entry(){one('Industry');two('Email');three('Company');}","}"].join("\n");
   await writeFile(path.join(root,"Service.cls"),source);
   const analyzer={analyze:async(_persona:Persona,queries:import("../src/models/SoqlQuery.js").SoqlQuery[])=>{
     assert.equal(queries.length,3,JSON.stringify(queries));
     const a=queries.find(q=>q.object==="Account")!,l=queries.find(q=>q.object==="Lead")!;
     assert.ok(a.queryVariantId&&l.queryVariantId);
     return [
       {...example,filePath:a.filePath,lineNumber:a.lineNumber,queryVariantId:a.queryVariantId,
        object:"Account",field:"Industry",query:a.query,withUserMode:false,severity:"INFO",criticality:"Low",
        verificationSource:"ORG_DENIED",findingType:"FIELD_READ",effectiveMode:"SYSTEM_MODE",runtimeImpact:"Not enforced by query",reason:"Salesforce confirmed missing Read."},
       {...example,filePath:l.filePath,lineNumber:l.lineNumber,queryVariantId:l.queryVariantId,
        object:"Lead",field:"Company",query:l.query,severity:"REVIEW",criticality:"Unable to verify",
        verificationSource:"UNVERIFIED",findingType:"FIELD_READ",reason:"Salesforce could not verify Read."},
     ] as SoqlSecurityFinding[];
   }} as unknown as SoqlSecurityAnalyzer;
   const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"reports")).analyze({name:"Test"} as Persona);
   assert.equal(result.findings.length,4,JSON.stringify(result.findings));
   const denied=result.findings.find(f=>f.field==="Industry")!;
   assert.equal(denied.criticality,"High");assert.equal(denied.runtimeImpact,"Not enforced by query");
   assert.equal(denied.effectiveMode,"SYSTEM_MODE");assert.equal(denied.verificationSource,"ORG_DENIED");
   assert.match(denied.reason,/additional runtime-dependent variants may exist/);
   const low=result.findings.find(f=>f.field.startsWith("(Recovered query variants"))!;
   assert.equal(low.object,"Contact");assert.equal(low.criticality,"Low");assert.match(low.reason,/No missing OLS\/FLS/);
   assert.equal(result.findings.find(f=>f.field==="Company")?.criticality,"Unable to verify");
   assert.equal(result.findings.filter(f=>f.object==="Dynamic SOQL").length,1);
   const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(result.reports.summaryReportPath);
   const rows=workbook.getWorksheet("Summary")!.getRows(7,4)!;
   assert.equal(rows.filter(r=>r.getCell(5).value==="High").length,1);
   assert.equal(rows.filter(r=>r.getCell(5).value==="Low").length,1);
   assert.equal(rows.filter(r=>r.getCell(5).value==="Unable to verify").length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("partial reference reporting reaches Excel without changing genuine runtime or permission reviews",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-partial-references-excel-"));
 try{
  const source=[
    "public class Q {",
    " public static void run(String w){String q='SELECT Id,Name FROM Account WHERE Id=:rid';if(String.isNotBlank(w)){q+=' AND '+w;}Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}",
    " public static void other(String obj){Database.query('SELECT Id FROM '+obj);}",
    "}"
  ].join("\n");
  await writeFile(path.join(root,"Q.cls"),source);
  const analyzer={analyze:async(_persona:Persona,queries:import("../src/models/SoqlQuery.js").SoqlQuery[])=>{
    const q=queries.find(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE")!;
    assert.ok(q&&q.selectPrefixOnly,JSON.stringify(queries));
    return [{...example,filePath:q.filePath,lineNumber:q.lineNumber,queryVariantId:q.queryVariantId,object:q.object,field:"Name",query:q.query,
      findingType:"FIELD_READ",severity:"INFO",criticality:"Low",effectiveMode:"UNKNOWN",runtimeImpact:"Undetermined",reason:"Salesforce confirmed missing Read."}];
  }} as unknown as SoqlSecurityAnalyzer;
  const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"out")).analyze({name:"Test"} as Persona);
  assert.equal(result.findings.length,2,JSON.stringify(result.findings));
  assert.equal(result.findings.find(f=>f.field==="Name")?.criticality,"High");
  assert.equal(result.findings.filter(f=>f.criticality==="Unable to verify").length,1);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(result.reports.summaryReportPath);
  const sheet=workbook.getWorksheet("Summary")!;
  assert.equal(sheet.getCell("E7").value,"High");
  assert.match(String(sheet.getCell("F7").value),/Additional runtime-dependent references may exist/);
  assert.match(String(sheet.getCell("F7").value),/effective query mode is not verified/);
  assert.equal(sheet.getCell("E8").value,"Unable to verify");
  assert.match(String(sheet.getCell("A5").value),/High does not always mean a runtime access failure/);
 }finally{await rm(root,{recursive:true,force:true});}
});
