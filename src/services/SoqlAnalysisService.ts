import path from "node:path";
import { isDataAccessAnalysisObject } from "../config/fieldSecurityPolicy.js";
import { countDeclaredSoqlModes, type DeclaredSoqlModeCounts } from "../analyzer/soqlDeclaredModeSummary.js";

import { Persona } from "../models/Persona.js";
import { SoqlQuery } from "../models/SoqlQuery.js";
import { SoqlSecurityFinding } from "../models/SoqlSecurityFinding.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { scanApexSoqlWithUnresolved } from "../scanner/apexSoqlScanner.js";
import type { UnresolvedDynamicSoql } from "../scanner/dynamicSoqlScanner.js";
import {explainSoqlReview} from "../analyzer/soqlReviewExplanation.js";
import {needsDynamicCoverageReview} from "../analyzer/soqlReferenceCoverage.js";
import {applyLimitedCoverageReporting} from "../analyzer/soqlExistingVariantReporting.js";
import type { ApexMetadataProvider } from "../core/metadata/ApexMetadataProvider.js";
import { writeSoqlReport, writeAllPersonasHighPriorityReport, type PersonaHighPriorityReportSection } from "../reporter/soqlReportWriter.js";
import { recordSoqlCount, timeSoqlPhase, withSoqlPerformance } from "./SoqlPerformanceMetrics.js";
import type { SoqlAnalysisProgress } from "./SoqlAnalysisProgress.js";
import {captureVerificationUsers} from "./SoqlVerificationProvenance.js";
import { ALL_PERSONAS_CONCURRENCY } from "../config/salesforceConcurrency.js";

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
    findingType: site.securityModeConflict ? "QUERY_MODE" : "PARSER",
    filePath: site.filePath,
    lineNumber: site.lineNumber,
    ...(site.siteId ? { queryVariantId: site.siteId } : {}),
    object: "Dynamic SOQL",
    field: `(${site.securityModeConflict ? "Security mode conflict" : "Unresolved query"}: ${path.basename(site.filePath)}:${site.lineNumber}${site.siteId ? "@" + site.siteId.split("@").at(-1) : ""})`,
    query: site.securityModeConflict ? "(dynamic SOQL security-mode conflict)" : "(dynamic SOQL could not be reconstructed)",
    withUserMode: false,
    declaredMode: "UNSPECIFIED",
    effectiveMode: "UNKNOWN",
    runtimeImpact: site.securityModeConflict ? "Undetermined" : "Not assessed",
    reason: site.reportReason ?? explainSoqlReview({...site,...(site.securityModeConflict?{conflict:"Security-mode conflict; effective enforcement and conflicting query permissions not verified."}:{})}),
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
    recordSoqlCount("queries.aggregated_permission_inventory", queries.filter(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE").length);
    recordSoqlCount("queries.known_caller", queries.filter(q=>q.coverage==="KNOWN_CALLER_CONTEXT").length);
    recordSoqlCount("queries.complete", queries.filter(q=>!q.coverage).length);
    recordSoqlCount("queries.conditional_framework", queries.filter(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT").length);

    // Keep the pre-existing analyzer path for callers without progress
    // (including CLI/tests). With progress, the SAME preparation/evaluation
    // methods are split to report real milestones and per-object completion.
    progress?.moveTo("preparing");
    const {result:evaluatedFindings,users:verificationUsers} = await captureVerificationUsers(()=>timeSoqlPhase("security.total", async () => {
      if (!progress) return this.soqlSecurityAnalyzer.analyze(persona, queries);
      const prepared = await this.soqlSecurityAnalyzer.prepare(queries);
      progress.moveTo("permissions");
      return this.soqlSecurityAnalyzer.analyzePrepared(persona, prepared,
        (completed, total) => progress.reportObjects(completed, total));
    }));
    // Coverage advisories for accepted runtime-field inventories are emitted
    // by the security analyzer using its already resolved API-version mode.
    const {findings,handledSiteIds,existingSiteIds,partialSiteIds}=applyLimitedCoverageReporting(scanned.unresolvedDynamic,queries,evaluatedFindings);
    const runtimeSites=new Set(queries.filter(q=>q.runtimeFieldCoverage).map(q=>q.querySiteId));
    const incompleteSites=scanned.unresolvedDynamic.filter(site=>needsDynamicCoverageReview(site,queries));
    const reviewSites=incompleteSites.filter(site=>!site.siteId||!handledSiteIds.has(site.siteId));
    recordSoqlCount("coverage.complete_finite_sites",scanned.unresolvedDynamic.length-incompleteSites.length);
    recordSoqlCount("coverage.existing_variant_sites",existingSiteIds.size);
    recordSoqlCount("coverage.partial_reference_sites",partialSiteIds.size);
    recordSoqlCount("coverage.dynamic_review_sites",reviewSites.length);
    findings.push(...unresolvedDynamicFindings(reviewSites.filter(site=>!site.runtimeFieldCoverage||!runtimeSites.has(site.siteId))));
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
        findings,
        verificationUsers
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
    recordSoqlCount("queries.aggregated_permission_inventory", queries.filter(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE").length);
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
          const {result:evaluated,users:verificationUsers}=await captureVerificationUsers(()=>timeSoqlPhase("security.personas_cumulative_ms",
            () => this.soqlSecurityAnalyzer.analyzePrepared(persona, prepared)));
          // Apply the same persona-specific reporting policy as the normal
          // report. Only confirmed denials in the scoped variant domain can
          // change priority; unknown verification results remain reviews.
          const {findings}=applyLimitedCoverageReporting(scanned.unresolvedDynamic,queries,evaluated);
          const high = findings.filter((finding) => finding.criticality === "High");
          recordSoqlCount("findings.high", high.length);
          sections[index] = { personaName: persona.name, queryCount: queries.length, findings: high, verificationUsers };
          progress?.personaCompleted();
        }
      };
      await timeSoqlPhase("security.all_personas_wall_ms", () =>
        Promise.all(Array.from({ length: Math.min(ALL_PERSONAS_CONCURRENCY, personas.length) }, () => worker())));

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
