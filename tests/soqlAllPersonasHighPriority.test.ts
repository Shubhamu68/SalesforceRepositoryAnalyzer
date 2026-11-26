import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import { SoqlAnalysisService } from "../src/services/SoqlAnalysisService.js";
import { writeAllPersonasHighPriorityReport } from "../src/reporter/soqlReportWriter.js";
import type { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlSecurityFinding } from "../src/models/SoqlSecurityFinding.js";

const makePersona = (name: string): Persona => ({
  name, permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [],
});
const personaNames = ["OMS View Only", "CSR", "System Administrator"];
const personas = personaNames.map(makePersona);

function finding(
  filePath: string,
  line: number,
  criticality: "High" | "Low" | "Unable to verify",
  object = "Account",
  field = "Industry",
): SoqlSecurityFinding {
  return {
    filePath, lineNumber: line, object, field,
    query: `SELECT ${field} FROM ${object} WITH USER_MODE`,
    withUserMode: true, declaredMode: "USER_MODE",
    effectiveMode: criticality === "Low" ? "SYSTEM_MODE" : "USER_MODE",
    runtimeImpact: criticality === "High" ? "Potential access failure" :
      criticality === "Low" ? "Not enforced by query" : "Undetermined",
    severity: criticality === "High" ? "ERROR" : "REVIEW",
    criticality,
    verificationSource: criticality === "High" ? "ORG_DENIED" : "UNVERIFIED",
    findingType: "FIELD_READ",
    reason: criticality === "High" ? "Current-org verification confirmed missing Read in USER_MODE." :
      criticality === "Low" ? "System mode does not enforce FLS." : "Cannot confirm Read access.",
  };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value && typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text).join("");
  }
  return String(value ?? "");
}

test("all personas: shared preparation once, independent decisions, exactly one high-only workbook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-high-summary-"));
  try {
    const source = path.join(root, "Order.cls");
    await writeFile(source, [
      "public class Order {",
      "  void run() {",
      "    [SELECT Industry FROM Account WITH USER_MODE];",
      "  }",
      "}",
    ].join("\n"));
    let preparedCount = 0;
    const checked: string[] = [];
    const analyzer = {
      prepare: async () => {
        preparedCount++;
        return { tag: "shared" };
      },
      analyzePrepared: async (persona: Persona, prepared: { tag: string }) => {
        assert.equal(prepared.tag, "shared");
        checked.push(persona.name);
        if (persona.name === "System Administrator") return [];
        if (persona.name === "OMS View Only") return [
          finding(source, 3, "High"),
          finding(source, 5, "Low"), // Same field, but must NOT appear in high-only group.
          finding(source, 7, "High"),
          finding(source, 9, "Unable to verify"),
          finding(source, 11, "High", "Internal_Settings__mdt", "Key__c"), // Excluded metadata
        ];
        return [finding(source, 3, "High"), finding(source, 8, "Low", "Contact", "Name")];
      },
    } as unknown as SoqlSecurityAnalyzer;
    const service = new SoqlAnalysisService(root, analyzer, path.join(root, "out"));
    const result = await service.analyzeAllHighPriority(personas);

    assert.equal(preparedCount, 1);
    assert.deepEqual(checked, personaNames, "persona-specific checks must follow configured order");
    assert.equal(result.personaCount, 3);
    assert.equal(result.queryCount, 1);
    assert.equal(result.totalHighPriorityFindings, 2,
      "same Account.Industry issue is counted independently for two personas");
    assert.equal(result.totalHighPriorityOccurrences, 3);
    assert.deepEqual(result.personas.map(p => p.highPriorityCount), [1, 1, 0]);
    assert.deepEqual(result.personas.map(p => p.highPriorityOccurrences), [2, 1, 0]);
    assert.equal((await readdir(path.join(root, "out"))).length, 1,
      "must not write one workbook per persona");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.reportPath);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["High Priority Summary"]);
    const sheet = workbook.worksheets[0];
    assert.match(cellText(sheet.getCell("A1").value), /All Business Personas/i);
    assert.equal(sheet.getCell("B2").value, 3);
    assert.equal(sheet.getCell("B3").value, 2);
    assert.equal(sheet.getCell("E3").value, 3);
    assert.equal(sheet.autoFilter, undefined, "multiple persona sections must not use a global auto-filter");
    const headings = sheet.getColumn(1).values.map(cellText)
      .filter(text => text.startsWith("Persona "));
    assert.deepEqual(headings, personaNames.map((name, i) => `Persona ${i + 1}: ${name}`));
    const priorityCells = sheet.getColumn(5).values.map(cellText);
    assert.equal(priorityCells.filter(value => value === "High").length, 2);
    assert.ok(!priorityCells.includes("Low") && !priorityCells.includes("Unable to verify"));
    const apexTexts = sheet.getColumn(4).values.map(cellText).filter(value => value.includes("Line Number"));
    assert.equal(apexTexts.length, 2, "each persona retains its own file references");
    assert.match(apexTexts[0], /Line Number 3, 7/);
    assert.doesNotMatch(apexTexts.join("\n"), /Line Number (5|8|9|11)(?:\b|,)/);
    assert.ok(sheet.getColumn(1).values.map(cellText).includes("No high-priority findings"));
    assert.equal(sheet.views[0]?.ySplit, 5);
    const content = await readFile(result.reportPath);
    assert.ok(content.byteLength > 1000, "workbook should be nonempty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("High-only filter never promotes unverified/Low or mixed references to High", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-high-writer-"));
  try {
    const file = path.join(root, "Class.cls");
    const sections = [
      {
        personaName: "Only low and unknown",
        queryCount: 2,
        findings: [
          finding(file, 7, "Low"),
          finding(file, 8, "Unable to verify"),
        ],
      },
      {
        personaName: "Mixed same field",
        queryCount: 2,
        findings: [
          finding(file, 10, "High"),
          finding(file, 11, "Low"),
          finding(file, 12, "Unable to verify"),
        ],
      },
    ];
    const result = await writeAllPersonasHighPriorityReport(root, sections);
    assert.deepEqual(result.personas.map(p => p.highPriorityCount), [0, 1]);
    assert.deepEqual(result.personas.map(p => p.highPriorityOccurrences), [0, 1]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.summaryReportPath);
    const sheet = workbook.worksheets[0];
    const allText = sheet.getColumn(1).values.map(cellText);
    assert.ok(allText.includes("No high-priority findings"));
    const fileLines = sheet.getColumn(4).values.map(cellText).filter(t => t.includes("Line Number"));
    assert.equal(fileLines.length, 1);
    assert.match(fileLines[0], /Line Number 10/);
    assert.doesNotMatch(fileLines[0], /Line Number 11|Line Number 12/);
    assert.deepEqual(workbook.worksheets.map(s => s.name), ["High Priority Summary"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all-personas analysis fails closed on empty or duplicate persona configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-high-invalid-"));
  try {
    const analyzer = {
      prepare: () => { throw new Error("Preparation must not start"); },
    } as unknown as SoqlSecurityAnalyzer;
    const service = new SoqlAnalysisService(root, analyzer, root);
    await assert.rejects(service.analyzeAllHighPriority([]), /No business personas/);
    await assert.rejects(service.analyzeAllHighPriority([
      makePersona("CSR"), makePersona("csr"),
    ]), /unique, non-empty/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all-personas evaluations remain bounded to two concurrent workers and ordered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-high-parallel-"));
  try {
    await writeFile(path.join(root, "Simple.cls"),
      "public class Simple { [SELECT Id FROM Account WITH USER_MODE]; }");
    let active = 0;
    let maxActive = 0;
    const analyzer = {
      prepare: async () => ({ marker: true }),
      analyzePrepared: async (persona: Persona) => {
        active++;
        maxActive = Math.max(active, maxActive);
        // Deliberately finish in a different order from persona configuration.
        await new Promise<void>(resolve => setTimeout(resolve, persona.name === "P1" ? 25 : 5));
        active--;
        return [];
      },
    } as unknown as SoqlSecurityAnalyzer;
    const selected = ["P1", "P2", "P3", "P4", "P5"].map(makePersona);
    const service = new SoqlAnalysisService(root, analyzer, path.join(root, "output"));
    const result = await service.analyzeAllHighPriority(selected);
    assert.ok(maxActive > 1 && maxActive <= 2,
      "performance should use bounded, overlapping persona evaluations");
    assert.equal(active, 0);
    assert.deepEqual(result.personas.map(persona => persona.personaName),
      selected.map(persona => persona.name), "sections must preserve configured order");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.reportPath);
    assert.deepEqual(workbook.worksheets[0].getColumn(1).values.map(cellText)
      .filter(t => t.startsWith("Persona ")),
      selected.map((persona, index) => `Persona ${index + 1}: ${persona.name}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository-only high-priority report explicitly warns that zero confirmed issues is inconclusive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-high-repo-only-"));
  try {
    const file = path.join(root, "Missing.cls");
    const result = await writeAllPersonasHighPriorityReport(root, [{
      personaName: "Offline Persona",
      queryCount: 1,
      findings: [finding(file, 4, "Unable to verify")],
    }], "REPOSITORY_ONLY");
    assert.equal(result.totalHighPriorityFindings, 0);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.summaryReportPath);
    const sheet = workbook.worksheets[0];
    assert.match(cellText(sheet.getCell("A5").value), /REPOSITORY-ONLY/i);
    assert.match(cellText(sheet.getCell("A5").value), /does NOT mean permissions are safe/i);
    assert.ok(sheet.getColumn(1).values.map(cellText).includes("No high-priority findings"));
    assert.equal(sheet.getColumn(5).values.filter(value => value === "High").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("opt-in all-personas workers are bounded independently and keep configured report order",async()=>{
  const old=process.env.SALESFORCE_ALL_PERSONAS_CONCURRENCY;
  const root=await mkdtemp(path.join(os.tmpdir(),"sf-persona-scheduling-"));
  try{
    process.env.SALESFORCE_ALL_PERSONAS_CONCURRENCY="4";
    await writeFile(path.join(root,"Simple.cls"),"public class Simple { [SELECT Id FROM Account WITH USER_MODE]; }");
    let active=0,peak=0;
    const analyzer={
      prepare:async()=>({}),
      analyzePrepared:async(persona:Persona)=>{
        active++;peak=Math.max(peak,active);
        await new Promise<void>(resolve=>setTimeout(resolve,persona.name==="P1"?20:5));
        active--;return [];
      }
    } as unknown as SoqlSecurityAnalyzer;
    const selected=["P1","P2","P3","P4","P5","P6"].map(makePersona);
    const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"out")).analyzeAllHighPriority(selected);
    assert.equal(peak,4);
    assert.deepEqual(result.personas.map(p=>p.personaName),selected.map(p=>p.name));
  }finally{
    if(old===undefined)delete process.env.SALESFORCE_ALL_PERSONAS_CONCURRENCY;
    else process.env.SALESFORCE_ALL_PERSONAS_CONCURRENCY=old;
    await rm(root,{recursive:true,force:true});
  }
});
