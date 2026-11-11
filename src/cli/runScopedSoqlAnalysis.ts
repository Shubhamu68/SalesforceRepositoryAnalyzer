import path from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { scanRepository } from "../scanner/repositoryScanner.js";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { SoqlAnalysisService } from "../services/SoqlAnalysisService.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { normalizeSoqlScope } from "../analyzer/soqlAnalysisScope.js";
import { ApexExecutionSecurityModeResolver } from "../services/ApexExecutionSecurityModeResolver.js";
import { OrgObjectReadVerificationService } from "../services/OrgObjectReadVerificationService.js";
import { loadOrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import { SalesforceRelationshipMetadataService } from "../salesforce/SalesforceRelationshipMetadataService.js";
import { SalesforcePersonaAccessVerifier } from "../salesforce/SalesforcePersonaAccessVerifier.js";

if (existsSync(".env")) process.loadEnvFile(".env");

/** Same selection engine used by the UI; suitable for Azure Pipelines checkout. */
function argsOf(argv: string[]) {
  const result = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error("Unexpected argument: " + arg);
    const name = arg.slice(2);
    if (!["repository", "persona", "mode", "manifest", "component", "output", "json"].includes(name)) {
      throw new Error("Unknown option: " + arg);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
    result.set(name, [...(result.get(name) ?? []), value]);
  }
  return result;
}

async function main(): Promise<void> {
  const args = argsOf(process.argv.slice(2));
  const first = (key: string) => args.get(key)?.[0];
  const repository = first("repository") ?? process.env.SALESFORCE_REPOSITORY_PATH;
  const personaName = first("persona");
  if (!repository || !personaName) {
    throw new Error("Usage: npm run soql:scope -- --repository <checkout> --persona <name> " +
      "--mode FULL|SELECTIVE [--manifest manifest/package.xml] [--component ApexClass:SomeClass] " +
      "[--output reports] [--json reports/scope.json]");
  }
  const scope = normalizeSoqlScope({
    mode: (first("mode") ?? "FULL").toUpperCase(),
    ...(first("manifest") ? { manifestPath: first("manifest") } : {}),
    components: args.get("component") ?? [],
  });
  const paths = await scanRepository(path.resolve(repository));
  const connection = new SalesforceOrgConnection();
  const verifier = new OrgObjectReadVerificationService(
    await loadOrgVerificationStatusPolicy("./config/org-verification-status-policy.json"),
    new SalesforcePersonaAccessVerifier(connection),
  );
  const service = new SoqlAnalysisService(
    paths.repositoryPath,
    new SoqlSecurityAnalyzer(
      new PersonaPermissionResolver(
        paths.permissionSetsPath, paths.permissionSetGroupsPath,
        paths.mutingPermissionSetsPath, paths.profilesPath,
      ),
      path.join(paths.defaultPath, "objects"),
      verifier,
      new ApexExecutionSecurityModeResolver(),
      new SalesforceRelationshipMetadataService(connection),
    ),
    path.resolve(first("output") ?? process.env.SALESFORCE_ANALYZER_OUTPUT_DIRECTORY ?? "reports"),
  );
  const persona = await new PersonaConfigLoader("./config/personas.json").getPersona(personaName);
  const report = await service.analyze(persona, scope);
  const result = {
    personaName: report.personaName,
    scope: report.scope,
    summary: report.summary,
    findings: report.findings,
    reports: report.reports,
    /**
     * This output is not an automatic deployment pass/fail verdict:
     * missing post-deployment permission modeling is a separate planned feature.
     */
    deploymentGateReady: false,
  };
  const jsonPath = path.resolve(first("json") ?? path.join(
    path.dirname(report.reports.summaryReportPath), "soql-scope-result.json",
  ));
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({
    scope: report.scope, summary: report.summary,
    excel: report.reports.summaryReportPath, json: jsonPath,
  }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
