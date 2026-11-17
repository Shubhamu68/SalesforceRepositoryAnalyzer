import path from "node:path";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { loadOrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { PersonaAccessService } from "./PersonaAccessService.js";
import { PersonaFieldAccessService } from "./PersonaFieldAccessService.js";
import { AccessQueryService } from "./AccessQueryService.js";
import { SoqlAnalysisService } from "./SoqlAnalysisService.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { StackTraceImpactService } from "./StackTraceImpactService.js";
import { ObjectAccessMatrixService } from "./ObjectAccessMatrixService.js";
import { OrgObjectReadVerificationService } from "./OrgObjectReadVerificationService.js";
import { SalesforcePersonaAccessVerifier } from "../salesforce/SalesforcePersonaAccessVerifier.js";
import { SalesforceEffectivePermissionVerifier } from "../salesforce/SalesforceEffectivePermissionVerifier.js";
import { SalesforceUserFieldAccessGateway } from "../salesforce/SalesforceUserFieldAccessGateway.js";
import { SalesforceFieldMetadataService } from "../salesforce/SalesforceFieldMetadataService.js";
import { OrgPermissionFallbackService } from "./OrgPermissionFallbackService.js";
import { SalesforceRelationshipMetadataService } from "../salesforce/SalesforceRelationshipMetadataService.js";
import type { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import type { SalesforceMetadataPaths } from "../scanner/repositoryScanner.js";
import type { OrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import type { RepositoryConfigurationService } from "./RepositoryConfigurationService.js";
import type { ReportOutputConfigurationService } from "./ReportOutputConfigurationService.js";

export interface AnalyzerRuntime {
  paths: SalesforceMetadataPaths;
  accessQueryService: AccessQueryService;
  objectAccessMatrixService: ObjectAccessMatrixService;
  soqlAnalysisService: SoqlAnalysisService;
  stackTraceImpactService: StackTraceImpactService;
}

/**
 * Avoid a startup dependency on SALESFORCE_REPOSITORY_PATH. All analysis
 * services load lazily once a valid repository has been chosen.
 *
 * Services are shared across analyzers and keyed by repository + whether live
 * org verification is allowed, so repo-only mode never accidentally uses org
 * Describe or active-user verification.
 */
export class AnalyzerRuntimeService {
  private contexts = new Map<string, AnalyzerRuntime>();
  private readonly metadataPolicy: Promise<OrgVerificationStatusPolicy>;
  readonly personas = new PersonaConfigLoader("./config/personas.json");

  constructor(
    private readonly repository: RepositoryConfigurationService,
    private readonly reportOutput: ReportOutputConfigurationService,
    private readonly connection: SalesforceOrgConnection,
  ) {
    this.metadataPolicy = loadOrgVerificationStatusPolicy("./config/org-verification-status-policy.json");
  }

  async get(useOrg = true): Promise<AnalyzerRuntime> {
    // Validate on every access to detect removed/moved repositories and fail
    // before any scanner or permission lookup starts.
    const paths = await this.repository.resolvePaths();
    const session = this.connection.status;
    // Cache never crosses Salesforce orgs, authenticated administrators or
    // reconnects. Repository-only mode remains independent of org sessions.
    const scope = useOrg
      ? [session.organizationId ?? "", session.userId ?? "", session.instanceUrl ?? "",
          session.connectedAt ?? ""].join("|")
      : "";
    const key = paths.repositoryPath + "|" + String(useOrg) + "|" + scope;
    const existing = this.contexts.get(key);
    if (existing) return existing;

    const resolver = new PersonaPermissionResolver(
      paths.permissionSetsPath,
      paths.permissionSetGroupsPath,
      paths.mutingPermissionSetsPath,
      paths.profilesPath,
    );
    // One FLS gateway is shared by all analysis features in this runtime.
    const fieldMetadata = new SalesforceFieldMetadataService(useOrg ? this.connection : undefined);
    const userFieldAccess = useOrg ? new SalesforceUserFieldAccessGateway(this.connection, fieldMetadata) : undefined;
    const personaVerifier = useOrg ? new SalesforcePersonaAccessVerifier(this.connection, userFieldAccess) : undefined;
    const verification = new OrgObjectReadVerificationService(
      await this.metadataPolicy, personaVerifier, fieldMetadata,
    );
    const fallback = new OrgPermissionFallbackService(
      personaVerifier ? new SalesforceEffectivePermissionVerifier(this.connection, personaVerifier, userFieldAccess) : undefined,
    );
    const relationships = useOrg
      ? new SalesforceRelationshipMetadataService(this.connection)
      : undefined;
    const accessQueryService = new AccessQueryService(
      new PersonaAccessService(resolver, verification, fallback),
      new PersonaFieldAccessService(resolver, verification, fallback, fieldMetadata),
    );
    const soqlAnalysisService = new SoqlAnalysisService(
      paths.repositoryPath,
      new SoqlSecurityAnalyzer(
        resolver,
        path.join(paths.defaultPath, "objects"),
        verification,
        undefined,
        relationships,
        fieldMetadata,
      ),
      () => this.reportOutput.requireConfiguredDirectory(),
    );
    const objectAccessMatrixService = new ObjectAccessMatrixService(this.personas, resolver, verification, fallback);
    const stackTraceImpactService = new StackTraceImpactService(
      paths.repositoryPath, path.join(paths.defaultPath, "objects"),
      this.personas, resolver, paths.mutingPermissionSetsPath,
      verification, relationships, await this.metadataPolicy, fieldMetadata,
    );
    const context = {
      paths, accessQueryService, soqlAnalysisService,
      objectAccessMatrixService, stackTraceImpactService,
    };
    // Keep just the selected repository contexts; don't accumulate access
    // caches indefinitely as the user switches repositories.
    if (this.contexts.size > 3) this.contexts.clear();
    this.contexts.set(key, context);
    return context;
  }

  invalidate(): void {
    this.contexts.clear();
  }
}
