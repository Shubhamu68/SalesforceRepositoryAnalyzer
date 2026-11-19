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
  summarySheet.getCell("A5").value = "High = confirmed missing Read with enforced SOQL access; Low = advisory or org-verified Read. Mixed findings show the highest severity.";
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

  summarySheet.getColumn(4).alignment = {
    wrapText: true,
    vertical: "top",
  };

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