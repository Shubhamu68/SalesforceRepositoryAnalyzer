import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { SoqlScopeSummary } from "../analyzer/soqlAnalysisScope.js";

import {
  SoqlSecurityFinding,
} from "../models/SoqlSecurityFinding.js";

const EXCLUDED_ERROR_OBJECT_SUFFIX = "__mdt";

export async function writeSoqlReport(
  outputDirectory: string,
  personaName: string,
  queryCount: number,
  findings: SoqlSecurityFinding[],
  scope?: SoqlScopeSummary,
): Promise<{
  errorReportPath: string;
  otherReportPath: string;
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

  const errorFindings =
    findings.filter(
      (finding) =>
        finding.severity === "ERROR" &&
        !isMetadataObject(
          finding.object
        )
    );

  const otherFindings =
    findings.filter(
      (finding) =>
        finding.severity !== "ERROR"
    );

  // Include High, Low and Unable to verify. A successful Salesforce
  // verification is evidence worth keeping, not an error to suppress.
  const conciseFindings = buildConciseFindings(
    findings.filter((finding) => !isMetadataObject(finding.object))
  );

  const baseName =
    `soql-fls-${safePersonaName}-${timestamp}`;

  const errorReportPath =
    path.join(
      outputDirectory,
      `${baseName}-errors.txt`
    );

  const otherReportPath =
    path.join(
      outputDirectory,
      `${baseName}-other.txt`
    );

  const summaryReportPath =
    path.join(
      outputDirectory,
      `${baseName}-summary.xlsx`
    );

  await writeFile(
    errorReportPath,
    buildDetailedReport(
      personaName,
      queryCount,
      "ERROR",
      errorFindings
    ),
    "utf-8"
  );

  await writeFile(
    otherReportPath,
    buildDetailedReport(
      personaName,
      queryCount,
      "OTHER",
      otherFindings
    ),
    "utf-8"
  );

  await writeSummaryWorkbook(
    summaryReportPath,
    personaName,
    queryCount,
    conciseFindings,
    scope
  );

  return {
    errorReportPath,
    otherReportPath,
    summaryReportPath,
  };
}

// --------------------------------------------------
// Detailed TXT report
// --------------------------------------------------

function buildDetailedReport(
  personaName: string,
  queryCount: number,
  reportType: "ERROR" | "OTHER",
  findings: SoqlSecurityFinding[]
): string {
  const lines: string[] = [];

  lines.push(
    "Salesforce Repository Analyzer - SOQL FLS Vulnerability Report"
  );
  lines.push("=".repeat(70));
  lines.push(`Persona: ${personaName}`);
  lines.push(`Queries analyzed: ${queryCount}`);
  lines.push(`Report type: ${reportType}`);
  lines.push(`Findings: ${findings.length}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  for (
    const [index, finding] of
      findings.entries()
  ) {
    lines.push(
      `Finding ${index + 1}`
    );
    lines.push("-".repeat(70));
    lines.push(`Severity: ${finding.criticality ?? (finding.severity === "ERROR" ? "High" : "Unable to verify")}`);
    lines.push(`Verification: ${finding.verificationSource ?? "UNVERIFIED"}`);
    lines.push(`Finding Type: ${finding.findingType ?? "FIELD_READ"}`);
    lines.push(`Runtime Impact: ${finding.runtimeImpact ?? "Undetermined"}`);
    lines.push(`Effective Query Mode: ${finding.effectiveMode ?? "UNKNOWN"}`);
    lines.push(`Apex API Version: ${finding.apiVersion ?? "Unknown"}`);
    lines.push(`Relationship Path: ${finding.relationshipPath ?? finding.object}`);
    lines.push(`Query Level: ${finding.queryLevel ?? 1}`);
    lines.push(
      `File: ${finding.filePath}`
    );
    lines.push(
      `Line: ${finding.lineNumber}`
    );
    lines.push(
      `Object: ${finding.object}`
    );
    lines.push(
      `Field: ${finding.field}`
    );
    lines.push(`Explicit Query Mode: ${finding.declaredMode ?? (finding.withUserMode ? "USER_MODE" : "UNSPECIFIED")}`);
    lines.push("");
    lines.push("Reason:");
    lines.push(finding.reason);
    lines.push("");
    lines.push("SOQL:");
    lines.push(finding.query);
    lines.push("");
    lines.push("");
  }

  return lines.join("\n");
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
          (reference.relationshipPath ?? "") === (finding.relationshipPath ?? "")
      );

    if (!alreadyPresent) {
      entry.references.push({
        filePath:
          finding.filePath,
        lineNumber:
          finding.lineNumber,
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
  // displays the highest priority finding; References keeps each query's own
  // grade and explanation so no system-mode reference is falsely marked High.
  for (const entry of grouped.values()) {
    const priority = (criticality: string) => criticality === "High" ? 0 : criticality === "Unable to verify" ? 1 : 2;
    const highest = [...entry.references].sort((a, b) => priority(a.criticality) - priority(b.criticality))[0];
    if (!highest) continue;
    entry.criticality = highest.criticality;
    const isMixed = entry.references.some(ref => ref.criticality !== highest.criticality);
    entry.explanation = highest.explanation + (isMixed
      ? " Severity differs across SOQL references. The Summary shows the highest; see References for individual query severity."
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
  return unique.length === 1 ? unique[0] : "Mixed (see References)";
}

// --------------------------------------------------
// XLSX summary
// --------------------------------------------------

async function writeSummaryWorkbook(
  filePath: string,
  personaName: string,
  queryCount: number,
  findings: ConciseFinding[],
  scope?: SoqlScopeSummary,
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
    "A1:K1"
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
  summarySheet.mergeCells("A5:K5");
  summarySheet.getCell("A5").value = "High = confirmed missing Read with enforced SOQL access; Low = advisory or org-verified Read. Mixed findings show the highest severity here; see References.";
  summarySheet.getCell("A5").font = { italic: true, color: { argb: "FF60748D" }, size: 10 };

  const summaryHeader =
    summarySheet.addRow([
      "Object",
      "Field",
      "Occurrences",
      "Apex Classes",
      "Criticality / Severity",
      "Explanation",
      "Runtime Impact",
      "Effective Query Mode",
      "Apex API Version",
      "Relationship Path",
      "Query Level",
    ]);

  styleHeader(summaryHeader);

  for (
    const finding of findings
  ) {
    const groupedReferences =
      groupReferencesByFile(
        finding.references
      );

    const apexClasses =
      groupedReferences
        .map(
          (reference) =>
            `${reference.filePath} - Line Number ${reference.lineNumbers.join(", ")}`
        )
        .join("\n");

    const row =
      summarySheet.addRow([
        finding.object,
        finding.field,
        finding.references.length,
        "",
        finding.criticality,
        finding.explanation,
        summariseReferenceProperty(finding.references.map(ref => ref.runtimeImpact)),
        summariseReferenceProperty(finding.references.map(ref => ref.effectiveMode)),
        summariseReferenceProperty(finding.references.map(ref => ref.apiVersion?.toString() ?? "Unknown")),
        summariseReferenceProperty(finding.references.map(ref => ref.relationshipPath ?? finding.object)),
        summariseReferenceProperty(finding.references.map(ref => String(ref.queryLevel ?? 1))),
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

  summarySheet.views = [
    {
      state: "frozen",
      ySplit: 6,
    },
  ];

  summarySheet.getColumn(1).width = 28;
  summarySheet.getColumn(2).width = 42;
  summarySheet.getColumn(3).width = 14;
  summarySheet.getColumn(4).width = 70;
  summarySheet.getColumn(5).width = 23;
  summarySheet.getColumn(6).width = 64;
  summarySheet.getColumn(7).width = 30;
  summarySheet.getColumn(8).width = 24;
  summarySheet.getColumn(9).width = 20;
  summarySheet.getColumn(10).width = 46;
  summarySheet.getColumn(11).width = 14;

  summarySheet.getColumn(4).alignment = {
    wrapText: true,
    vertical: "top",
  };

  // ------------------------------------------------
  // References sheet
  // ------------------------------------------------

  const referenceSheet =
    workbook.addWorksheet(
      "References"
    );

  const referenceHeader =
    referenceSheet.addRow([
      "Object",
      "Field",
      "Apex File",
      "Line",
      "Security Mode",
      "Criticality / Severity",
      "Explanation",
      "Effective Query Mode",
      "Runtime Impact",
      "Apex API Version",
      "Relationship Path",
      "Query Level",
    ]);

  styleHeader(referenceHeader);

  for (
    const finding of findings
  ) {
    for (
      const reference
        of finding.references
    ) {
      const row = referenceSheet.addRow([
        finding.object,
        finding.field,
        reference.filePath,
        reference.lineNumber,
        reference.securityMode,
        reference.criticality,
        reference.explanation,
        reference.effectiveMode,
        reference.runtimeImpact,
        reference.apiVersion ?? "Unknown",
        reference.relationshipPath ?? finding.object,
        reference.queryLevel ?? 1,
      ]);
      row.getCell(6).font = { bold: true, color: {
        argb: reference.criticality === "High" ? "FFB42332" :
          reference.criticality === "Low" ? "FF167349" : "FF916514",
      } };
      row.height = Math.min(84, Math.max(30, 15 * Math.ceil(reference.explanation.length / 65)));
    }
  }

  referenceSheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  referenceSheet.getColumn(1).width = 28;
  referenceSheet.getColumn(2).width = 42;
  referenceSheet.getColumn(3).width = 80;
  referenceSheet.getColumn(4).width = 10;
  referenceSheet.getColumn(5).width = 18;
  referenceSheet.getColumn(6).width = 23;
  referenceSheet.getColumn(7).width = 64;
  referenceSheet.getColumn(7).alignment = { wrapText: true, vertical: "top" };
  referenceSheet.getColumn(8).width = 25;
  referenceSheet.getColumn(9).width = 28;
  referenceSheet.getColumn(10).width = 19;
  referenceSheet.getColumn(11).width = 46;
  referenceSheet.getColumn(12).width = 14;

  // ------------------------------------------------
  // Auto filter
  // ------------------------------------------------

  summarySheet.autoFilter = {
    from: "A6",
    to: `K${Math.max(6, summarySheet.rowCount)}`,
  };

  referenceSheet.autoFilter = {
    from: "A1",
    to: `L${Math.max(1, referenceSheet.rowCount)}`,
  };

  if (scope) {
    const sheet = workbook.addWorksheet("Analysis Scope");
    sheet.addRow(["Analysis scope", "Value"]);
    sheet.addRow(["Mode", scope.mode === "FULL" ? "Full Repository" : "Selective Metadata"]);
    sheet.addRow(["All static SOQL queries", scope.totalQueriesFound]);
    sheet.addRow(["Selected SOQL queries", scope.queriesSelected]);
    sheet.addRow(["Expanded to full scan", scope.expandedToFull ? "Yes" : "No"]);
    sheet.addRow(["Manifest", scope.manifestPath ?? "Not specified"]);
    sheet.addRow(["Selected metadata members", scope.components.join("\n") || "All supported"]);
    sheet.addRow(["Scope warnings", scope.warnings.join("\n") || "None"]);
    sheet.addRow(["Limitations", "Checks static Apex .cls SOQL. This is not yet a post-deployment permission-state simulation."]);
    sheet.getColumn(1).width = 29;
    sheet.getColumn(2).width = 95;
    sheet.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(7).height = Math.min(160, Math.max(25, scope.components.length * 15));
    sheet.getRow(8).height = Math.min(140, Math.max(25, scope.warnings.length * 30));
  }

  await workbook.xlsx.writeFile(
    filePath
  );
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