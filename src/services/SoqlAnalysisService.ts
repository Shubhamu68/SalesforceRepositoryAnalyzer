import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
import { countDeclaredSoqlModes, type DeclaredSoqlModeCounts } from "../analyzer/soqlDeclaredModeSummary.js";

import { Persona } from "../models/Persona.js";
import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { scanApexSoql } from "../scanner/apexSoqlScanner.js";
import { writeSoqlReport, writeAllPersonasHighPriorityReport, type PersonaHighPriorityReportSection } from "../reporter/soqlReportWriter.js";
import { recordSoqlCount, timeSoqlPhase, withSoqlPerformance } from "./SoqlPerformanceMetrics.js";

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

export interface AllPersonasHighPriorityResult {
  reportPath: string;
  personaCount: number;
  queryCount: number;
  totalHighPriorityFindings: number;
  totalHighPriorityOccurrences: number;
  personas: Array<{
    personaName: string;
    queryCount: number;
    highPriorityCount: number;
    highPriorityOccurrences: number;
  }>;
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
    return withSoqlPerformance(async () => {
    const queries: SoqlQuery[] =
      (await timeSoqlPhase("repository.scan", () => scanApexSoql(
        this.repositoryPath
      ))).filter((query) => isDataAccessAnalysisObject(query.object));
    recordSoqlCount("queries.analyzed", queries.length);

    const findings =
      await timeSoqlPhase("security.total", () => this.soqlSecurityAnalyzer.analyze(
        persona,
        queries
      ));
    recordSoqlCount("findings", findings.length);

    const outputDirectory = typeof this.outputDirectory === "function"
      ? this.outputDirectory()
      : this.outputDirectory;

    const reports =
      await timeSoqlPhase("excel.total", () => writeSoqlReport(
        outputDirectory,
        persona.name,
        queries.length,
        findings
      ));

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
    });
  }

  /**
   * One repository scan / relationship inventory for every configured persona.
   * Effective permissions are still evaluated independently for each persona.
   * Evaluate sequentially to bound live Salesforce work across large orgs.
   * Fail the entire report if a persona cannot be evaluated: never produce a
   * misleadingly incomplete "all personas" workbook.
   */
  async analyzeAllHighPriority(personas: readonly Persona[]): Promise<AllPersonasHighPriorityResult> {
    if (personas.length === 0) throw new Error("No business personas are configured for SOQL analysis.");
    const names = new Set<string>();
    for (const persona of personas) {
      const name = persona.name.trim().toLowerCase();
      if (!name || names.has(name)) throw new Error("Business personas must have unique, non-empty names.");
      names.add(name);
    }
    return withSoqlPerformance(async () => {
      const queries = (await timeSoqlPhase("repository.scan",
        () => scanApexSoql(this.repositoryPath)))
        .filter((query) => isDataAccessAnalysisObject(query.object));
      recordSoqlCount("queries.analyzed", queries.length);
      recordSoqlCount("personas.analyzed", personas.length);

      const prepared = await timeSoqlPhase("security.prepare",
        () => this.soqlSecurityAnalyzer.prepare(queries));
      const sections: PersonaHighPriorityReportSection[] = [];
      for (const persona of personas) {
        const findings = await timeSoqlPhase("security.personas_cumulative_ms",
          () => this.soqlSecurityAnalyzer.analyzePrepared(persona, prepared));
        // Only the analyzer's explicit effective High criticality qualifies.
        // REVIEW/UNVERIFIED and Low references can never be elevated here.
        const high = findings.filter((finding) => finding.criticality === "High");
        recordSoqlCount("findings.high", high.length);
        sections.push({ personaName: persona.name, queryCount: queries.length, findings: high });
      }

      const outputDirectory = typeof this.outputDirectory === "function"
        ? this.outputDirectory() : this.outputDirectory;
      const report = await timeSoqlPhase("excel.total",
        () => writeAllPersonasHighPriorityReport(outputDirectory, sections));
      return {
        reportPath: report.summaryReportPath,
        personaCount: sections.length,
        queryCount: queries.length,
        totalHighPriorityFindings: report.totalHighPriorityFindings,
        totalHighPriorityOccurrences: report.totalHighPriorityOccurrences,
        personas: report.personas,
      };
    });
  }
}
