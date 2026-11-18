import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
import { countDeclaredSoqlModes, type DeclaredSoqlModeCounts } from "../analyzer/soqlDeclaredModeSummary.js";

import { Persona } from "../models/Persona.js";
import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { scanApexSoql } from "../scanner/apexSoqlScanner.js";
import { writeSoqlReport } from "../reporter/soqlReportWriter.js";

export interface SoqlAnalysisSummary extends DeclaredSoqlModeCounts {
  queriesAnalyzed: number;
  totalFindings: number;
  errors: number;
  reviews: number;
  affectedApexClasses: number;
}

export interface SoqlAnalysisReports {
  summaryReportPath: string;
}

export interface SoqlAnalysisResult {
  personaName: string;
  summary: SoqlAnalysisSummary;
  findings: SoqlSecurityFinding[];
  reports: SoqlAnalysisReports;
}

export class SoqlAnalysisService {
  constructor(
  private readonly repositoryPath: string,
  private readonly soqlSecurityAnalyzer: SoqlSecurityAnalyzer,
  private readonly outputDirectory: string | (() => string)
) {}

  async analyze(
    persona: Persona
  ): Promise<SoqlAnalysisResult> {
    const queries: SoqlQuery[] =
      (await scanApexSoql(
        this.repositoryPath
      )).filter((query) => isDataAccessAnalysisObject(query.object));

    const findings =
      await this.soqlSecurityAnalyzer.analyze(
        persona,
        queries
      );

    const outputDirectory = typeof this.outputDirectory === "function"
      ? this.outputDirectory()
      : this.outputDirectory;

    const reports =
      await writeSoqlReport(
        outputDirectory,
        persona.name,
        queries.length,
        findings
      );

    const affectedApexClasses =
      new Set(
        findings.map(
          (finding) => finding.filePath
        )
      ).size;

    const declaredModeCounts = countDeclaredSoqlModes(queries);

    return {
      personaName: persona.name,

      summary: {
        queriesAnalyzed: queries.length,
        totalFindings: findings.length,

        errors:
          findings.filter(
            (finding) =>
              finding.severity === "ERROR"
          ).length,

        reviews:
          findings.filter(
            (finding) =>
              finding.severity === "REVIEW"
          ).length,

        affectedApexClasses,
        ...declaredModeCounts,
      },

      findings,
      reports,
    };
  }
}
