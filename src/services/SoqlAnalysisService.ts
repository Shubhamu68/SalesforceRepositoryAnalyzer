
import { Persona } from "../models/Persona.js";
import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { scanApexSoql } from "../scanner/apexSoqlScanner.js";
import { selectScopedSoqlQueries, type SoqlScopeRequest, type SoqlScopeSummary } from "../analyzer/soqlAnalysisScope.js";
import { writeSoqlReport } from "../reporter/soqlReportWriter.js";

export interface SoqlAnalysisSummary {
  queriesAnalyzed: number;
  totalFindings: number;
  errors: number;
  reviews: number;
  affectedApexClasses: number;
  userModeQueries: number;
  noUserModeQueries: number;
}

export interface SoqlAnalysisReports {
  errorReportPath: string;
  otherReportPath: string;
  summaryReportPath: string;
}

export interface SoqlAnalysisResult {
  personaName: string;
  summary: SoqlAnalysisSummary;
  findings: SoqlSecurityFinding[];
  reports: SoqlAnalysisReports;
  scope: SoqlScopeSummary;
}

export class SoqlAnalysisService {
  constructor(
  private readonly repositoryPath: string,
  private readonly soqlSecurityAnalyzer: SoqlSecurityAnalyzer,
  private readonly outputDirectory: string
) {}

  async analyze(
    persona: Persona,
    options: SoqlScopeRequest = { mode: "FULL" }
  ): Promise<SoqlAnalysisResult> {
    const allQueries: SoqlQuery[] = await scanApexSoql(this.repositoryPath);
    const { queries, scope } = await selectScopedSoqlQueries(this.repositoryPath, allQueries, options);

    const findings =
      await this.soqlSecurityAnalyzer.analyze(
        persona,
        queries
      );

    const outputDirectory =
  this.outputDirectory;

    const reports =
      await writeSoqlReport(
        outputDirectory,
        persona.name,
        queries.length,
        findings,
        scope
      );

    const affectedApexClasses =
      new Set(
        findings.map(
          (finding) => finding.filePath
        )
      ).size;

    return {
      personaName: persona.name,
      scope,

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

        userModeQueries:
          queries.filter(
            (query) => query.withUserMode
          ).length,

        noUserModeQueries:
          queries.filter(
            (query) => !query.withUserMode
          ).length,
      },

      findings,
      reports,
    };
  }
}
