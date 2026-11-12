import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";

import { createMetadataRouter } from "./metadataRoutes.js";
import { createSalesforceRouter } from "./salesforceRoutes.js";
import { createReportOutputRouter } from "./reportOutputRoutes.js";
import { createRepositoryRouter } from "./repositoryRoutes.js";
import { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import { ReportOutputConfigurationService } from "../services/ReportOutputConfigurationService.js";
import { RepositoryConfigurationService } from "../services/RepositoryConfigurationService.js";
import { AnalyzerRuntimeService } from "../services/AnalyzerRuntimeService.js";
import { OrgAnalysisPreflightService, OrgAnalysisGuardError } from "../services/OrgAnalysisPreflightService.js";
import { RepositorySetupError } from "../services/SalesforceRepositoryValidator.js";

// Backend can start without any repository configured. Existing shell values
// still take precedence over .env at startup, as before.
if (existsSync(".env")) process.loadEnvFile(".env");

const app = express();
app.use(express.json({ limit: "100kb" }));
const PORT = 3000;

const salesforceOrgConnection = new SalesforceOrgConnection();
const reportOutputConfiguration = new ReportOutputConfigurationService();
const repositoryConfiguration = new RepositoryConfigurationService();
const runtime = new AnalyzerRuntimeService(repositoryConfiguration, reportOutputConfiguration, salesforceOrgConnection);
const orgPreflight = new OrgAnalysisPreflightService(salesforceOrgConnection);

// These configuration and connectivity routes are usable before repo setup.
app.use("/api/repository", createRepositoryRouter(repositoryConfiguration, () => runtime.invalidate()));
app.use("/api/report-output", createReportOutputRouter(reportOutputConfiguration));
app.use("/api/salesforce", createSalesforceRouter(salesforceOrgConnection));

app.get("/api/health", async (_req, res) => {
  const status = await repositoryConfiguration.status();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    repositoryConfigured: status.configured,
    repositoryName: status.repositoryName,
  });
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
    if (message.startsWith("Invalid object API name")) {
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

app.post("/api/soql-analysis", async (req, res) => {
  try {
    const personaName = typeof req.body?.personaName === "string" ? req.body.personaName.trim() : "";
    if (!personaName) { res.status(400).json({ error: "personaName is required" }); return; }

    const verdict = await orgPreflight.authorize(req.body?.acknowledgeRepoOnly === true);
    const outputStatus = await reportOutputConfiguration.getStatus();
    if (!outputStatus.configured || !outputStatus.directory) {
      res.status(409).json({ code: "REPORT_OUTPUT_NOT_CONFIGURED", error: outputStatus.message });
      return;
    }
    const persona = await runtime.personas.getPersona(personaName);
    const analyzer = await runtime.get(verdict.mode === "ORG_AND_REPOSITORY");
    const result = await analyzer.soqlAnalysisService.analyze(persona);
    res.json({
      personaName: result.personaName,
      summary: result.summary,
      outputFolder: outputStatus.directory,
      verificationMode: verdict.mode,
    });
  } catch (error) { handleApiError(error, res); }
});

function handleApiError(error: unknown, res: express.Response): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OrgAnalysisGuardError) {
    res.status(409).json({ code: error.code, error: message }); return;
  }
  if (error instanceof RepositorySetupError) {
    res.status(error.statusCode).json({ code: "REPOSITORY_NOT_CONFIGURED", error: message }); return;
  }
  if (message.startsWith("Persona not found:")) {
    res.status(404).json({ error: message }); return;
  }
  res.status(500).json({ error: message });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log("Salesforce Repository Analyzer API running on http://localhost:" + PORT);
  if (process.env.SALESFORCE_CLIENT_ID?.trim() && process.env.SALESFORCE_CLIENT_SECRET?.trim()) {
    void salesforceOrgConnection.connect().then(() => {
      console.log("Salesforce org authenticated (Client Credentials).");
    }).catch((error: unknown) => {
      console.warn("Salesforce org auto-connect unavailable:",
        error instanceof Error ? error.message : "Unknown error");
    });
  }
});
