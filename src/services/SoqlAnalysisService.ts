import path from "node:path";
import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
import { countDeclaredSoqlModes, type DeclaredSoqlModeCounts } from "../analyzer/soqlDeclaredModeSummary.js";

import { Persona } from "../models/Persona.js";
import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { scanApexSoqlWithUnresolved } from "../scanner/apexSoqlScanner.js";
import type { UnresolvedDynamicSoql } from "../scanner/dynamicSoqlScanner.js";
import type { ApexMetadataProvider } from "../core/metadata/ApexMetadataProvider.js";
import { writeSoqlReport, writeAllPersonasHighPriorityReport, type PersonaHighPriorityReportSection } from "../reporter/soqlReportWriter.js";
import { recordSoqlCount, timeSoqlPhase, withSoqlPerformance } from "./SoqlPerformanceMetrics.js";
import type { SoqlAnalysisProgress } from "./SoqlAnalysisProgress.js";

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

/** Use existing Excel findings schema: unresolved dynamic SOQL is a parser REVIEW. */
function unresolvedDynamicFindings(sites: readonly UnresolvedDynamicSoql[]): SoqlSecurityFinding[] {
  return sites.map(site => ({
    severity: "REVIEW",
    criticality: "Unable to verify",
    verificationSource: "UNVERIFIED",
    findingType: "PARSER",
    filePath: site.filePath,
    lineNumber: site.lineNumber,
    ...(site.siteId ? { queryVariantId: site.siteId } : {}),
    object: "Dynamic SOQL",
    field: `(Unresolved query: ${path.basename(site.filePath)}:${site.lineNumber}${site.siteId ? "@" + site.siteId.split("@").at(-1) : ""})`,
    query: "(dynamic SOQL could not be reconstructed)",
    withUserMode: false,
    declaredMode: "UNSPECIFIED",
    effectiveMode: "UNKNOWN",
    runtimeImpact: "Not assessed",
    reason: site.knownVariants || site.partialStructureVariants || site.conditionalFrameworkVariants ? `Dynamic SOQL execution coverage is incomplete: ${site.reason} OLS/FLS findings apply only to the proven caller variants, conditional framework scenarios or proven partial structures; unproven paths were not assessed.` : `Dynamic SOQL could not be parsed and verified because ${site.reason} OLS/FLS analysis was not performed for this query.`,
  }));
}

export class SoqlAnalysisService {
  constructor(
  private readonly repositoryPath: string,
  private readonly soqlSecurityAnalyzer: SoqlSecurityAnalyzer,
  private readonly outputDirectory: string | (() => string),
  private readonly metadata?: ApexMetadataProvider,
) {}

  async analyze(
    persona: Persona,
    progress?: SoqlAnalysisProgress,
  ): Promise<SoqlAnalysisResult> {
    return withSoqlPerformance(async () => {
    progress?.moveTo("scanning");
    const scanned = await timeSoqlPhase("repository.scan", () => scanApexSoqlWithUnresolved(
      this.repositoryPath, this.metadata, progress?(completed,total)=>progress.reportClasses(completed,total):undefined
    ));
    const queries: SoqlQuery[] = scanned.queries
      .filter((query) => isDataAccessAnalysisObject(query.object));
    recordSoqlCount("queries.analyzed", queries.length);
    recordSoqlCount("queries.partial_structure", queries.filter(q=>q.coverage==="PROVEN_PARTIAL_STRUCTURE").length);
    recordSoqlCount("queries.known_caller", queries.filter(q=>q.coverage==="KNOWN_CALLER_CONTEXT").length);
    recordSoqlCount("queries.complete", queries.filter(q=>!q.coverage).length);
    recordSoqlCount("queries.conditional_framework", queries.filter(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT").length);

    // Keep the pre-existing analyzer path for callers without progress
    // (including CLI/tests). With progress, the SAME preparation/evaluation
    // methods are split to report real milestones and per-object completion.
    progress?.moveTo("preparing");
    const findings = await timeSoqlPhase("security.total", async () => {
      if (!progress) return this.soqlSecurityAnalyzer.analyze(persona, queries);
      const prepared = await this.soqlSecurityAnalyzer.prepare(queries);
      progress.moveTo("permissions");
      return this.soqlSecurityAnalyzer.analyzePrepared(persona, prepared,
        (completed, total) => progress.reportObjects(completed, total));
    });
    findings.push(...unresolvedDynamicFindings(scanned.unresolvedDynamic));
    recordSoqlCount("findings", findings.length);

    const outputDirectory = typeof this.outputDirectory === "function"
      ? this.outputDirectory()
      : this.outputDirectory;

    progress?.moveTo("excel");
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
   * Evaluate at most two personas concurrently; the shared verifier enforces
   * its own global Salesforce request limit. Preserve configured output order.
   * Fail the entire report if a persona cannot be evaluated: never produce a
   * misleadingly incomplete "all personas" workbook.
   */
  async analyzeAllHighPriority(
    personas: readonly Persona[],
    verificationMode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY" = "ORG_AND_REPOSITORY",
    progress?: SoqlAnalysisProgress,
  ): Promise<AllPersonasHighPriorityResult> {
    if (personas.length === 0) throw new Error("No business personas are configured for SOQL analysis.");
    const names = new Set<string>();
    for (const persona of personas) {
      const name = persona.name.trim().toLowerCase();
      if (!name || names.has(name)) throw new Error("Business personas must have unique, non-empty names.");
      names.add(name);
    }
    return withSoqlPerformance(async () => {
      progress?.setTotalPersonas(personas.length);
      progress?.moveTo("scanning");
      const scanned = await timeSoqlPhase("repository.scan",
        () => scanApexSoqlWithUnresolved(this.repositoryPath, this.metadata,progress?(completed,total)=>progress.reportClasses(completed,total):undefined));
      const queries = scanned.queries
        .filter((query) => isDataAccessAnalysisObject(query.object));
      recordSoqlCount("queries.analyzed", queries.length);
    recordSoqlCount("queries.partial_structure", queries.filter(q=>q.coverage==="PROVEN_PARTIAL_STRUCTURE").length);
    recordSoqlCount("queries.known_caller", queries.filter(q=>q.coverage==="KNOWN_CALLER_CONTEXT").length);
    recordSoqlCount("queries.complete", queries.filter(q=>!q.coverage).length);
    recordSoqlCount("queries.conditional_framework", queries.filter(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT").length);
      recordSoqlCount("personas.analyzed", personas.length);

      progress?.moveTo("preparing");
      const prepared = await timeSoqlPhase("security.prepare",
        () => this.soqlSecurityAnalyzer.prepare(queries));
      progress?.moveTo("permissions");
      const sections = new Array<PersonaHighPriorityReportSection>(personas.length);
      let nextPersona = 0;
      const worker = async (): Promise<void> => {
        while (nextPersona < personas.length) {
          const index = nextPersona++;
          const persona = personas[index];
          const findings = await timeSoqlPhase("security.personas_cumulative_ms",
            () => this.soqlSecurityAnalyzer.analyzePrepared(persona, prepared));
          // Only the analyzer's explicit effective High criticality qualifies.
          // REVIEW/UNVERIFIED and Low references can never be elevated here.
          const high = findings.filter((finding) => finding.criticality === "High");
          recordSoqlCount("findings.high", high.length);
          sections[index] = { personaName: persona.name, queryCount: queries.length, findings: high };
          progress?.personaCompleted();
        }
      };
      await timeSoqlPhase("security.all_personas_wall_ms", () =>
        Promise.all(Array.from({ length: Math.min(2, personas.length) }, () => worker())));

      const outputDirectory = typeof this.outputDirectory === "function"
        ? this.outputDirectory() : this.outputDirectory;
      progress?.moveTo("excel");
      const report = await timeSoqlPhase("excel.total",
        () => writeAllPersonasHighPriorityReport(outputDirectory, sections, verificationMode));
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
