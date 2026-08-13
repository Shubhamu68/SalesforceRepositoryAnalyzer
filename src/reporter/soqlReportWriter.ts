import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

import {
  SoqlSecurityFinding,
} from "../models/SoqlSecurityFinding.js";

const EXCLUDED_ERROR_OBJECT_SUFFIX = "__mdt";

export async function writeSoqlReport(
  outputDirectory: string,
  personaName: string,
  queryCount: number,
  findings: SoqlSecurityFinding[]
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

  const conciseFindings =
    buildConciseFindings(
      errorFindings
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
    conciseFindings
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
    lines.push(
      `Severity: ${finding.severity}`
    );
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
    lines.push(
      `Security Mode: ${
        finding.withUserMode
          ? "USER_MODE"
          : "NO_USER_MODE"
      }`
    );
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

  references: Array<{
    filePath: string;
    lineNumber: number;
    securityMode: string;
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
          references: [],
        }
      );
    }

    const entry =
      grouped.get(key)!;

    const securityMode =
      finding.withUserMode
        ? "USER_MODE"
        : "NO_USER_MODE";

    const alreadyPresent =
      entry.references.some(
        (reference) =>
          reference.filePath ===
            finding.filePath &&
          reference.lineNumber ===
            finding.lineNumber
      );

    if (!alreadyPresent) {
      entry.references.push({
        filePath:
          finding.filePath,
        lineNumber:
          finding.lineNumber,
        securityMode,
      });
    }
  }

  return Array.from(
    grouped.values()
  ).sort(
    (a, b) =>
      a.object.localeCompare(
        b.object
      ) ||
      a.field.localeCompare(
        b.field
      )
  );
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
    "A1:D1"
  );

  summarySheet.getCell("A1").value =
    "SOQL FLS Vulnerability Summary";

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
    "Unique Object/Field Issues";

  summarySheet.getCell(
    "B4"
  ).value =
    findings.length;

  summarySheet.addRow([]);

  const summaryHeader =
    summarySheet.addRow([
      "Object",
      "Field",
      "Occurrences",
      "Apex Classes",
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
    ]);

  styleHeader(referenceHeader);

  for (
    const finding of findings
  ) {
    for (
      const reference
        of finding.references
    ) {
      referenceSheet.addRow([
        finding.object,
        finding.field,
        reference.filePath,
        reference.lineNumber,
        reference.securityMode,
      ]);
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

  // ------------------------------------------------
  // Auto filter
  // ------------------------------------------------

  summarySheet.autoFilter = {
    from: "A6",
    to: `D${summarySheet.rowCount}`,
  };

  referenceSheet.autoFilter = {
    from: "A1",
    to: `E${referenceSheet.rowCount}`,
  };

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

  row.eachCell((cell) => {
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