import { mkdir } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { timeSoqlPhase, timeSoqlSync } from "../services/SoqlPerformanceMetrics.js";

import {
  SoqlSecurityFinding,
} from "../models/SoqlSecurityFinding.js";

export async function writeSoqlReport(
  outputDirectory: string,
  personaName: string,
  queryCount: number,
  findings: SoqlSecurityFinding[]
): Promise<{
  summaryReportPath: string;
}> {
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const safePersonaName =
    personaName.replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );

  // Include High, Low and Unable to verify. A successful Salesforce
  // verification is evidence worth keeping, not an error to suppress.
  const conciseFindings = timeSoqlSync("excel.grouping", () => buildConciseFindings(
    findings.filter((finding) => !isMetadataObject(finding.object))
  ));

  const baseName =
    `soql-fls-${safePersonaName}-${timestamp}`;

  const summaryReportPath =
    path.join(
      outputDirectory,
      `${baseName}-summary.xlsx`
    );

  await writeSummaryWorkbook(
    summaryReportPath,
    personaName,
    queryCount,
    conciseFindings
  );

  return { summaryReportPath };
}

/**
 * Persona sections contain only the analyzer's effective High findings. We
 * filter individual occurrences BEFORE grouping object+field findings, so a
 * mixed user-mode/system-mode group never pulls Low references into High.
 */
export interface PersonaHighPriorityReportSection {
  personaName: string;
  queryCount: number;
  findings: SoqlSecurityFinding[];
}

export interface PersonaHighPriorityReportSummary {
  personaName: string;
  queryCount: number;
  highPriorityCount: number;
  highPriorityOccurrences: number;
}

export async function writeAllPersonasHighPriorityReport(
  outputDirectory: string,
  sections: readonly PersonaHighPriorityReportSection[],
  verificationMode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY" = "ORG_AND_REPOSITORY",
): Promise<{
  summaryReportPath: string;
  totalHighPriorityFindings: number;
  totalHighPriorityOccurrences: number;
  personas: PersonaHighPriorityReportSummary[];
}> {
  if (!sections.length) throw new Error("Cannot create an all-personas report without configured personas.");
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryReportPath = path.join(outputDirectory, `soql-all-personas-high-priority-${timestamp}.xlsx`);

  const grouped = timeSoqlSync("excel.grouping", () => sections.map(section => ({
    personaName: section.personaName,
    queryCount: section.queryCount,
    findings: buildConciseFindings(section.findings.filter(
      finding => finding.criticality === "High" && !isMetadataObject(finding.object),
    )),
  })));
  const personas = grouped.map(section => ({
    personaName: section.personaName,
    queryCount: section.queryCount,
    highPriorityCount: section.findings.length,
    highPriorityOccurrences: section.findings.reduce((total, finding) => total + finding.references.length, 0),
  }));
  const totalHighPriorityFindings = personas.reduce((sum, persona) => sum + persona.highPriorityCount, 0);
  const totalHighPriorityOccurrences = personas.reduce((sum, persona) => sum + persona.highPriorityOccurrences, 0);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Salesforce Repository Analyzer";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("High Priority Summary");
  setSummaryColumnWidths(sheet);
  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").value = "SOQL High Priority Summary — All Business Personas";
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1F3654" } };
  sheet.getCell("A2").value = "Personas Analyzed";
  sheet.getCell("B2").value = sections.length;
  sheet.getCell("D2").value = "SOQL Queries per Persona";
  sheet.getCell("E2").value = sections[0].queryCount;
  sheet.getCell("A3").value = "Unique High Priority Issues";
  sheet.getCell("B3").value = totalHighPriorityFindings;
  sheet.getCell("D3").value = "High Priority Occurrences";
  sheet.getCell("E3").value = totalHighPriorityOccurrences;
  sheet.mergeCells("A4:H4");
  sheet.getCell("A4").value =
    "Only confirmed High-criticality references are included. Low and Unable to verify are excluded; duplicate findings across personas are retained. Dynamic SOQL uses repository initializer snapshots; detected static writes and direct collection aliases invalidate those snapshots. Indirect effects may remain unresolved.";
  sheet.getCell("A4").font = { italic: true, size: 10, color: { argb: "FF60748D" } };
  sheet.getCell("A4").alignment = { wrapText: true, vertical: "middle" };
  sheet.getRow(4).height = 32;
  sheet.mergeCells("A5:H5");
  sheet.getCell("A5").value = verificationMode === "REPOSITORY_ONLY"
    ? "REPOSITORY-ONLY: Salesforce Read access could not be verified. No confirmed High findings does NOT mean permissions are safe."
    : "Section headers repeat for each persona; Excel's single global auto-filter is disabled to avoid filtering across different sections.";
  sheet.getCell("A5").font = { italic: true, size: 10, color: { argb: "FF60748D" } };

  for (const [index, section] of grouped.entries()) {
    sheet.addRow([]);
    const personaRow = sheet.addRow([]);
    sheet.mergeCells(personaRow.number, 1, personaRow.number, 8);
    personaRow.getCell(1).value = `Persona ${index + 1}: ${section.personaName}`;
    personaRow.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    personaRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF294A70" } };
    personaRow.height = 26;

    const countRow = sheet.addRow([
      "SOQL Queries Analyzed", section.queryCount, "",
      "Unique High Priority Issues", personas[index].highPriorityCount, "",
      "High Occurrences", personas[index].highPriorityOccurrences,
    ]);
    countRow.font = { bold: true, size: 11 };
    countRow.height = 22;
    addSummaryFindingHeader(sheet);
    if (section.findings.length) {
      appendSummaryFindingRows(sheet, section.findings);
    } else {
      const empty = sheet.addRow(["No high-priority findings"]);
      sheet.mergeCells(empty.number, 1, empty.number, 8);
      empty.getCell(1).font = { italic: true, color: { argb: "FF60748D" } };
    }
  }
  // Freezing is meaningful only for the global summary: repeated persona
  // section headers must remain in place. Auto-filter is deliberately omitted.
  sheet.views = [{ state: "frozen", ySplit: 5 }];
  await timeSoqlPhase("excel.serialization", () => workbook.xlsx.writeFile(summaryReportPath));
  return { summaryReportPath, totalHighPriorityFindings, totalHighPriorityOccurrences, personas };
}

// --------------------------------------------------
// Concise finding model
// --------------------------------------------------

interface ConciseFinding {
  object: string;
  field: string;
  criticality: string;
  explanation: string;
  verificationSource: string;
  findingType: string;

  references: Array<{
    filePath: string;
    lineNumber: number;
    queryVariantId?: string;
    securityMode: string;
    effectiveMode: string;
    runtimeImpact: string;
    apiVersion?: number;
    relationshipPath?: string;
    queryLevel?: number;
    /** Severity and explanation are specific to this Apex query, not its group. */
    criticality: string;
    explanation: string;
  }>;
}

// --------------------------------------------------
// Group duplicate Object + Field issues
// --------------------------------------------------

function buildConciseFindings(
  findings: SoqlSecurityFinding[]
): ConciseFinding[] {
  const grouped =
    new Map<
      string,
      ConciseFinding
    >();

  for (const finding of findings) {
    const object =
      finding.object.trim();

    const field =
      finding.field.trim();

    const key =
      `${object.toLowerCase()}::${field.toLowerCase()}`;

    if (!grouped.has(key)) {
      grouped.set(
        key,
        {
          object,
          field,
          criticality: finding.criticality ?? (finding.severity === "ERROR" ? "High" : "Unable to verify"),
          explanation: finding.reason,
          verificationSource: finding.verificationSource ?? "UNVERIFIED",
          findingType: finding.findingType ?? "FIELD_READ",
          references: [],
        }
      );
    }

    const entry =
      grouped.get(key)!;

    const securityMode = finding.declaredMode ?? (finding.withUserMode ? "USER_MODE" : "UNSPECIFIED");

    const alreadyPresent =
      entry.references.some(
        (reference) =>
          reference.filePath ===
            finding.filePath &&
          reference.lineNumber ===
            finding.lineNumber &&
          (reference.queryVariantId ?? "") === (finding.queryVariantId ?? "") &&
          (reference.relationshipPath ?? "") === (finding.relationshipPath ?? "")
      );

    if (!alreadyPresent) {
      entry.references.push({
        filePath:
          finding.filePath,
        lineNumber:
          finding.lineNumber,
        ...(finding.queryVariantId ? { queryVariantId: finding.queryVariantId } : {}),
        securityMode,
        effectiveMode: finding.effectiveMode ?? "UNKNOWN",
        runtimeImpact: finding.runtimeImpact ?? "Undetermined",
        criticality: finding.criticality ?? (finding.severity === "ERROR" ? "High" : "Unable to verify"),
        explanation: finding.reason,
        ...(finding.relationshipPath ? { relationshipPath: finding.relationshipPath } : {}),
        ...(finding.queryLevel ? { queryLevel: finding.queryLevel } : {}),
        ...(finding.apiVersion !== undefined ? { apiVersion: finding.apiVersion } : {}),
      });
    }
  }

  // A field may be accessed by system-mode and user-mode queries. The Summary
  // displays the highest priority finding; retain per-query grades internally
  // so mixed execution modes are represented accurately in the one-sheet report.
  for (const entry of grouped.values()) {
    const priority = (criticality: string) => criticality === "High" ? 0 : criticality === "Unable to verify" ? 1 : 2;
    const highest = [...entry.references].sort((a, b) => priority(a.criticality) - priority(b.criticality))[0];
    if (!highest) continue;
    entry.criticality = highest.criticality;
    const isMixed = entry.references.some(ref => ref.criticality !== highest.criticality);
    entry.explanation = highest.explanation + (isMixed
      ? " Severity differs across SOQL queries. Highest severity shown; see the Apex Classes column for affected locations."
      : "");
  }

  return Array.from(
    grouped.values()
  ).sort((a, b) => {
    const priority = (criticality: string) => criticality === "High" ? 0 : criticality === "Unable to verify" ? 1 : 2;
    return priority(a.criticality) - priority(b.criticality) ||
      a.object.localeCompare(b.object) || a.field.localeCompare(b.field);
  });
}

function summariseReferenceProperty(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : "Mixed";
}

// --------------------------------------------------
// XLSX summary
// --------------------------------------------------

async function writeSummaryWorkbook(
  filePath: string,
  personaName: string,
  queryCount: number,
  findings: ConciseFinding[]
): Promise<void> {
  const workbook =
    new ExcelJS.Workbook();

  workbook.creator =
    "Salesforce Repository Analyzer";

  workbook.created =
    new Date();

  // ------------------------------------------------
  // Summary sheet
  // ------------------------------------------------

  const summarySheet =
    workbook.addWorksheet(
      "Summary"
    );

  summarySheet.mergeCells(
    "A1:H1"
  );

  summarySheet.getCell("A1").value =
    "SOQL Read Permission Verification Summary";

  summarySheet.getCell(
    "A1"
  ).font = {
    bold: true,
    size: 16,
  };

  summarySheet.getCell(
    "A2"
  ).value =
    "Persona";

  summarySheet.getCell(
    "B2"
  ).value =
    personaName;

  summarySheet.getCell(
    "A3"
  ).value =
    "SOQL Queries Analyzed";

  summarySheet.getCell(
    "B3"
  ).value =
    queryCount;

  summarySheet.getCell(
    "A4"
  ).value =
    "Unique Permission Findings";

  summarySheet.getCell(
    "B4"
  ).value =
    findings.length;

  summarySheet.addRow([]);
  summarySheet.mergeCells("A5:H5");
  summarySheet.getCell("A5").value = "High = confirmed missing Read with enforced SOQL access; Low = advisory or org-verified Read. Mixed findings show the highest severity. Dynamic SOQL uses repository initializer snapshots; detected static writes and direct collection aliases invalidate those snapshots. Indirect effects may remain unresolved; reconstructed queries are repository-based, not runtime traces.";
  summarySheet.getCell("A5").font = { italic: true, color: { argb: "FF60748D" }, size: 10 };
  summarySheet.getCell("A5").alignment = { wrapText: true, vertical: "middle" };
  summarySheet.getRow(5).height = 32;

  addSummaryFindingHeader(summarySheet);
  appendSummaryFindingRows(summarySheet, findings);

  summarySheet.views = [
    {
      state: "frozen",
      ySplit: 6,
    },
  ];

  setSummaryColumnWidths(summarySheet);

  // ------------------------------------------------
  // Auto filter
  // ------------------------------------------------

  summarySheet.autoFilter = {
    from: "A6",
    to: `H${Math.max(6, summarySheet.rowCount)}`,
  };

  await timeSoqlPhase("excel.serialization", () => workbook.xlsx.writeFile(
    filePath
  ));
}

function addSummaryFindingHeader(sheet: ExcelJS.Worksheet): void {
  const summaryHeader =
    sheet.addRow([
      "Object",
      "Field",
      "Occurrences",
      "Apex Classes",
      "Criticality / Severity",
      "Explanation",
      "Runtime Impact",
      "Effective Query Mode",
    ]);
  
  styleHeader(summaryHeader);
}

function appendSummaryFindingRows(sheet: ExcelJS.Worksheet, findings: ConciseFinding[]): void {
  for (
    const finding of findings
  ) {
    const groupedReferences =
      groupReferencesByFile(
        finding.references
      );
  

    const row =
      sheet.addRow([
        finding.object,
        finding.field,
        finding.references.length,
        "",
        finding.criticality,
        finding.explanation,
        summariseReferenceProperty(finding.references.map(ref => ref.runtimeImpact)),
        summariseReferenceProperty(finding.references.map(ref => ref.effectiveMode)),
      ]);
  
    const apexCell =
      row.getCell(4);
  
    apexCell.value =
      buildApexClassRichText(
        groupedReferences
      );
  
    apexCell.alignment = {
      wrapText: true,
      vertical: "top",
    };
    row.getCell(5).font = { bold: true, color: {
      argb: finding.criticality === "High" ? "FFB42332" :
        finding.criticality === "Low" ? "FF167349" : "FF916514",
    } };
    row.getCell(6).alignment = { wrapText: true, vertical: "top" };
    row.getCell(7).alignment = { wrapText: true, vertical: "top" };
    row.getCell(8).alignment = { wrapText: true, vertical: "top" };
    row.height = Math.min(112, Math.max(30,
      15 * Math.max(groupedReferences.length, Math.ceil(finding.explanation.length / 65))));
  }
}

function setSummaryColumnWidths(sheet: ExcelJS.Worksheet): void {
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 42;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 70;
  sheet.getColumn(5).width = 23;
  sheet.getColumn(6).width = 64;
  sheet.getColumn(7).width = 30;
  sheet.getColumn(8).width = 24;
  
  sheet.getColumn(4).alignment = {
    wrapText: true,
    vertical: "top",
  };
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function styleHeader(
  row: ExcelJS.Row
): void {
  row.font = {
    bold: true,
    color: {
      argb: "FFFFFFFF",
    },
  };

  row.alignment = {
    vertical: "middle",
    horizontal: "center",
  };

  row.eachCell((cell: ExcelJS.Cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: "FF1F4E78",
      },
    };

    cell.border = {
      bottom: {
        style: "thin",
        color: {
          argb: "FFB7C9D6",
        },
      },
    };
  });
}

function isMetadataObject(
  objectName: string
): boolean {
  return objectName
    .trim()
    .toLowerCase()
    .endsWith("__mdt");
}

interface GroupedReference {
  filePath: string;
  lineNumbers: number[];
}

function groupReferencesByFile(
  references: Array<{
    filePath: string;
    lineNumber: number;
    securityMode: string;
  }>
): GroupedReference[] {
  const grouped =
    new Map<string, number[]>();

  for (const reference of references) {
    if (!grouped.has(reference.filePath)) {
      grouped.set(
        reference.filePath,
        []
      );
    }

    grouped
      .get(reference.filePath)!
      .push(reference.lineNumber);
  }

  return Array.from(
    grouped.entries()
  ).map(
    ([filePath, lineNumbers]) => ({
      filePath: toRepositoryRelativePath(
        filePath
      ),
      lineNumbers: Array.from(
        new Set(lineNumbers)
      ).sort(
        (a, b) => a - b
      ),
    })
  );
}

function toRepositoryRelativePath(
  filePath: string
): string {
  const normalized =
    filePath.replace(
      /\\/g,
      "/"
    );

  const marker =
    "/force-app/";

  const markerIndex =
    normalized.toLowerCase().indexOf(
      marker
    );

  if (markerIndex === -1) {
    return filePath;
  }

  return (
    ".." +
    normalized.slice(markerIndex)
  ).replace(
    /\//g,
    "\\"
  );
}

function buildApexClassRichText(
  references: GroupedReference[]
): ExcelJS.CellRichTextValue {
  const richText: ExcelJS.RichText[] = [];

  references.forEach(
    (reference, index) => {
      if (index > 0) {
        richText.push({
          text: "\n",
        });
      }

      richText.push({
        text: reference.filePath,
      });

      richText.push({
        text: ` - `,
      });

      richText.push({
        text: `Line Number ${reference.lineNumbers.join(", ")}`,
        font: {
          bold: true,
        },
      });
    }
  );

  return {
    richText,
  };
}