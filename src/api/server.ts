import { PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON } from "../config/fieldSecurityPolicy.js";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";

import { createMetadataRouter } from "./metadataRoutes.js";
import { createSalesforceRouter } from "./salesforceRoutes.js";
import { timeSoqlPhase, withSoqlPerformance } from "../services/SoqlPerformanceMetrics.js";
import { SoqlProgressRegistry, withSoqlProgress, type SoqlAnalysisProgress } from "../services/SoqlAnalysisProgress.js";
import { createReportOutputRouter } from "./reportOutputRoutes.js";
import { createRepositoryRouter } from "./repositoryRoutes.js";
import { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import { ReportOutputConfigurationService } from "../services/ReportOutputConfigurationService.js";
import { RepositoryConfigurationService } from "../services/RepositoryConfigurationService.js";
import { AnalyzerRuntimeService } from "../services/AnalyzerRuntimeService.js";
import { OrgAnalysisPreflightService, OrgAnalysisGuardError } from "../services/OrgAnalysisPreflightService.js";
import { RepositorySetupError } from "../services/SalesforceRepositoryValidator.js";
import { removeLegacySalesforceOauthEnvironment, removeLegacySalesforceOauthSettings } from "../services/LocalEnvFileService.js";

// The desktop edition persists settings in its user-data folder; the existing
// browser/CLI editions continue using the project's local .env by default.
const localEnvPath = path.resolve(process.env.SALESFORCE_ANALYZER_ENV_PATH?.trim() || ".env");
if (existsSync(localEnvPath)) {
  await removeLegacySalesforceOauthSettings(localEnvPath);
  process.loadEnvFile(localEnvPath);
}
// The Salesforce CLI owns OAuth. Ignore stale user/system shell variables, too.
removeLegacySalesforceOauthEnvironment();

const app = express();
app.use(express.json({ limit: "100kb" }));
// The portable Windows launcher selects an available local port. Dev remains on 3000.
const PORT = Number(process.env.SALESFORCE_ANALYZER_PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("SALESFORCE_ANALYZER_PORT must be a valid TCP port.");
}

const salesforceOrgConnection = new SalesforceOrgConnection();
const reportOutputConfiguration = new ReportOutputConfigurationService();
const repositoryConfiguration = new RepositoryConfigurationService();
const runtime = new AnalyzerRuntimeService(repositoryConfiguration, reportOutputConfiguration, salesforceOrgConnection);
const orgPreflight = new OrgAnalysisPreflightService(salesforceOrgConnection);

// These configuration and connectivity routes are usable before repo setup.
app.use("/api/repository", createRepositoryRouter(repositoryConfiguration, () => runtime.invalidate()));
app.use("/api/report-output", createReportOutputRouter(reportOutputConfiguration));
app.use("/api/salesforce", createSalesforceRouter(salesforceOrgConnection, () => runtime.invalidate()));

// Fast liveness probe for desktop startup. Unlike the existing health endpoint,
// this never scans the user's Salesforce repository on every readiness poll.
app.get("/api/health/live", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok" });
});

app.get("/api/health", async (_req, res) => {
  const status = await repositoryConfiguration.status();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    repositoryConfigured: status.configured,
    repositoryName: status.repositoryName,
  });
});

const soqlProgressRegistry = new SoqlProgressRegistry();

// The opaque UUID is created by the browser before starting the existing POST.
// Progress polling never returns usernames, repo paths, SOQL or permission data.
// Serve directly: this read-only lookup must not revalidate repository paths.
app.get("/api/soql-analysis/progress/:id", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const snapshot = soqlProgressRegistry.get(req.params.id);
  if (!snapshot) { res.status(404).json({ error: "Progress not found." }); return; }
  res.json(snapshot);
});

// All metadata lookups and analysis actions are gated centrally, including
// direct API calls that bypass the frontend's setup modal.
app.use("/api", async (_req, res, next) => {
  try {
    await repositoryConfiguration.resolvePaths();
    next();
  } catch (error) {
    res.status(409).json({
      code: "REPOSITORY_NOT_CONFIGURED",
      error: error instanceof Error ? error.message : "Configure a valid Salesforce repository before using this feature.",
    });
  }
});

app.get("/api/personas", async (_req, res) => {
  try { res.json(await runtime.personas.getAllPersonas()); }
  catch (error) { handleApiError(error, res); }
});

app.use("/api", createMetadataRouter(async () => (await runtime.get(false)).paths.defaultPath));

app.get("/api/analysis/preflight", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await orgPreflight.check());
  } catch (error) { handleApiError(error, res); }
});

app.post("/api/stack-trace-impact", async (req, res) => {
  try {
    const stackTrace = typeof req.body?.stackTrace === "string" ? req.body.stackTrace : "";
    const verdict = await orgPreflight.authorize(req.body?.acknowledgeRepoOnly === true);
    const analyzer = await runtime.get(verdict.mode === "ORG_AND_REPOSITORY");
    const result = await analyzer.stackTraceImpactService.analyze(stackTrace);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Enter an Apex stack trace") ||
        message.startsWith("No Apex Class frames") ||
        message.startsWith("No unique Apex method")) {
      res.status(400).json({ error: message }); return;
    }
    handleApiError(error, res);
  }
});

app.get("/api/objects/:objectName/persona-access", async (req, res) => {
  try {
    const analyzer = await runtime.get();
    res.json(await analyzer.objectAccessMatrixService.analyze(req.params.objectName));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Invalid object API name") ||
        message === PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON) {
      res.status(400).json({ error: message }); return;
    }
    handleApiError(error, res);
  }
});

app.get("/api/personas/:personaName/objects/:objectName", async (req, res) => {
  try {
    const persona = await runtime.personas.getPersona(req.params.personaName);
    const analyzer = await runtime.get();
    const result = await analyzer.accessQueryService.checkObject(persona, req.params.objectName);
    if (!result) { res.status(404).json({ error: "Object not found" }); return; }
    res.json(result);
  } catch (error) { handleApiError(error, res); }
});

app.get("/api/personas/:personaName/objects/:objectName/fields/:fieldName", async (req, res) => {
  try {
    const persona = await runtime.personas.getPersona(req.params.personaName);
    const analyzer = await runtime.get();
    res.json(await analyzer.accessQueryService.checkField(
      persona, req.params.objectName, req.params.fieldName,
    ));
  } catch (error) { handleApiError(error, res); }
});

// The desktop API uses one process. Reject conflicting analyses even when two
// browser tabs or direct API callers bypass disabled frontend buttons.
let soqlAnalysisInProgress = false;
async function runSoqlAnalysisRequest(
  req: express.Request,
  res: express.Response,
  allPersonas: boolean,
): Promise<void> {
  if (soqlAnalysisInProgress) {
    res.status(409).json({
      code: "ANALYSIS_IN_PROGRESS",
      error: "A SOQL analysis is already running. Wait for it to finish before starting another.",
    });
    return;
  }
  soqlAnalysisInProgress = true;
  let progress: SoqlAnalysisProgress | undefined;
  let progressId: string | undefined;
  try {
    // Optional, for backward compatibility with existing API/desktop callers.
    if (req.body?.progressId !== undefined) {
      if (typeof req.body.progressId !== "string") {
        res.status(400).json({ error: "Invalid progress request identifier." });
        return;
      }
      progressId = req.body.progressId;
      try {
        progress = soqlProgressRegistry.start(progressId!, allPersonas ? "all" : "single");
      } catch {
        res.status(400).json({ error: "Invalid or duplicate progress request identifier." });
        return;
      }
    }
    const personaName = typeof req.body?.personaName === "string" ? req.body.personaName.trim() : "";
    if (!allPersonas && !personaName) {
      res.status(400).json({ error: "personaName is required" });
      return;
    }

    await withSoqlProgress(progress, () => withSoqlPerformance(async () => {
      const verdict = await timeSoqlPhase("api.preflight", () =>
        orgPreflight.authorize(req.body?.acknowledgeRepoOnly === true));
      progress?.setMode(verdict.mode);
      const outputStatus = await reportOutputConfiguration.getStatus();
      if (!outputStatus.configured || !outputStatus.directory) {
        res.status(409).json({ code: "REPORT_OUTPUT_NOT_CONFIGURED", error: outputStatus.message });
        return;
      }
      const analyzer = await timeSoqlPhase("api.runtime", () =>
        runtime.get(verdict.mode === "ORG_AND_REPOSITORY"));
      if (allPersonas) {
        // Always load from the canonical config on the server. Never trust the
        // selected dropdown or a client-supplied list of personas.
        const personas = await runtime.personas.getAllPersonas();
        const result = await analyzer.soqlAnalysisService.analyzeAllHighPriority(personas, verdict.mode, progress);
        progress?.complete();
        res.json({
          personaCount: result.personaCount,
          queryCount: result.queryCount,
          totalHighPriorityFindings: result.totalHighPriorityFindings,
          totalHighPriorityOccurrences: result.totalHighPriorityOccurrences,
          personas: result.personas,
          reportFileName: path.basename(result.reportPath),
          outputFolder: outputStatus.directory,
          verificationMode: verdict.mode,
        });
        return;
      }
      const persona = await runtime.personas.getPersona(personaName);
      const result = await analyzer.soqlAnalysisService.analyze(persona, progress);
      progress?.complete();
      res.json({
        personaName: result.personaName,
        summary: result.summary,
        outputFolder: outputStatus.directory,
        verificationMode: verdict.mode,
      });
    }));
  } catch (error) {
    progress?.fail();
    handleApiError(error, res);
  } finally {
    // Also finalize early validation/configuration exits from the existing POST.
    if (progress && !progress.isFinished) progress.fail();
    if (progressId && progress) soqlProgressRegistry.finish(progressId);
    soqlAnalysisInProgress = false;
  }
}
app.post("/api/soql-analysis", (req, res) => {
  void runSoqlAnalysisRequest(req, res, false);
});
app.post("/api/soql-analysis/high-priority", (req, res) => {
  void runSoqlAnalysisRequest(req, res, true);
});

function handleApiError(error: unknown, res: express.Response): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OrgAnalysisGuardError) {
    res.status(409).json({ code: error.code, error: message }); return;
  }
  if (error instanceof RepositorySetupError) {
    res.status(error.statusCode).json({ code: "REPOSITORY_NOT_CONFIGURED", error: message }); return;
  }
  if (message === PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON) {
    res.status(400).json({ error: message }); return;
  }
  if (message.startsWith("Persona not found:")) {
    res.status(404).json({ error: message }); return;
  }
  res.status(500).json({ error: message });
}

// Serve the production React UI only for the self-contained portable distribution.
// Dev still runs Vite separately; /api routes and their guards are unchanged.
const staticDirectory = process.env.SALESFORCE_ANALYZER_STATIC_DIR?.trim();
if (staticDirectory) {
  const resolved = path.resolve(staticDirectory);
  const indexFile = path.join(resolved, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error("Packaged React UI is missing: " + indexFile);
  }
  app.use(express.static(resolved, { index: false }));
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") ||
        req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(indexFile);
  });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log("Salesforce Repository Analyzer API running on http://localhost:" + PORT);
  console.log("Salesforce CLI browser login is available from the Analyzer UI.");
});
