import express from "express";
import path from "node:path";

import { scanRepository } from "../scanner/repositoryScanner.js";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { PersonaAccessService } from "../services/PersonaAccessService.js";
import { PersonaFieldAccessService } from "../services/PersonaFieldAccessService.js";
import { AccessQueryService } from "../services/AccessQueryService.js";
import { SoqlAnalysisService } from "../services/SoqlAnalysisService.js";
import { SoqlSecurityAnalyzer } from "../analyzer/soqlSecurityAnalyzer.js";
import { createMetadataRouter } from "./metadataRoutes.js";
import { ObjectAccessMatrixService } from "../services/ObjectAccessMatrixService.js";
import { StackTraceImpactService } from "../services/StackTraceImpactService.js";
import { SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import { createSalesforceRouter } from "./salesforceRoutes.js";
import { existsSync } from "node:fs";

// Optional local .env file; existing shell environment variables take precedence.
// Node.js 22+ is required for this dependency-free configuration loader.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const app = express();

app.use(express.json({ limit: "100kb" }));

// OAuth client credentials stay on the backend; only the access token is held in memory.
const salesforceOrgConnection = new SalesforceOrgConnection();
app.use("/api/salesforce", createSalesforceRouter(salesforceOrgConnection));

const PORT = 3000;

const repositoryPath =
  process.env.SALESFORCE_REPOSITORY_PATH;

if (!repositoryPath) {
  throw new Error(
    "SALESFORCE_REPOSITORY_PATH environment variable is not set."
  );
}

const outputDirectory =
  "C:\\Users\\703394232\\Desktop\\SalesforceAnalyzerOutputReports";

const paths =
  await scanRepository(repositoryPath);

app.use(
  "/api",
  createMetadataRouter(paths.defaultPath)
);

const personaConfigLoader =
  new PersonaConfigLoader(
    "./config/personas.json"
  );

const personaPermissionResolver =
  new PersonaPermissionResolver(
    paths.permissionSetsPath,
    paths.permissionSetGroupsPath,
    paths.mutingPermissionSetsPath,
    paths.profilesPath
  );

const personaAccessService =
  new PersonaAccessService(
    personaPermissionResolver
  );

const personaFieldAccessService =
  new PersonaFieldAccessService(
    personaPermissionResolver
  );

const accessQueryService =
  new AccessQueryService(
    personaAccessService,
    personaFieldAccessService
  );

const soqlSecurityAnalyzer =
  new SoqlSecurityAnalyzer(
    personaPermissionResolver,
    path.join(
      paths.defaultPath,
      "objects"
    )
  );

const soqlAnalysisService =
  new SoqlAnalysisService(
    repositoryPath,
    soqlSecurityAnalyzer,
    outputDirectory
  );

const objectAccessMatrixService = new ObjectAccessMatrixService(
  personaConfigLoader,
  personaPermissionResolver
);

const stackTraceImpactService = new StackTraceImpactService(
  repositoryPath,
  path.join(paths.defaultPath, "objects"),
  personaConfigLoader,
  personaPermissionResolver,
  paths.mutingPermissionSetsPath
);

// --------------------------------------------------
// Stack trace to recursive SOQL persona impact
// --------------------------------------------------
app.post("/api/stack-trace-impact", async (req, res) => {
  try {
    const stackTrace = typeof req.body?.stackTrace === "string" ? req.body.stackTrace : "";
    const result = await stackTraceImpactService.analyze(stackTrace);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Enter an Apex stack trace") || message.startsWith("No Apex Class frames") || message.startsWith("No unique Apex method")) {
      res.status(400).json({ error: message });
      return;
    }
    handleApiError(error, res);
  }
});

// --------------------------------------------------
// Personas
// --------------------------------------------------

app.get(
  "/api/personas",
  async (_req, res) => {
    try {
      const personas =
        await personaConfigLoader.getAllPersonas();

      res.json(personas);
    } catch (error) {
      handleApiError(error, res);
    }
  }
);

// --------------------------------------------------
// Object Access Matrix: all configured personas for one object
// --------------------------------------------------

app.get("/api/objects/:objectName/persona-access", async (req, res) => {
  try {
    const result = await objectAccessMatrixService.analyze(req.params.objectName);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Invalid object API name")) {
      res.status(400).json({ error: message });
      return;
    }
    handleApiError(error, res);
  }
});

// --------------------------------------------------
// Object access
// --------------------------------------------------

app.get(
  "/api/personas/:personaName/objects/:objectName",
  async (req, res) => {
    try {
      const persona =
        await personaConfigLoader.getPersona(
          req.params.personaName
        );

      const result =
        await accessQueryService.checkObject(
          persona,
          req.params.objectName
        );

      if (!result) {
        res.status(404).json({
          error: "Object not found",
        });

        return;
      }

      res.json(result);
    } catch (error) {
      handleApiError(error, res);
    }
  }
);

// --------------------------------------------------
// Field access
// --------------------------------------------------

app.get(
  "/api/personas/:personaName/objects/:objectName/fields/:fieldName",
  async (req, res) => {
    try {
      const persona =
        await personaConfigLoader.getPersona(
          req.params.personaName
        );

      const result =
        await accessQueryService.checkField(
          persona,
          req.params.objectName,
          req.params.fieldName
        );

      res.json(result);
    } catch (error) {
      handleApiError(error, res);
    }
  }
);

// --------------------------------------------------
// SOQL security analysis
// --------------------------------------------------

app.post(
  "/api/soql-analysis",
  async (req, res) => {
    try {
      const personaName =
        typeof req.body?.personaName === "string"
          ? req.body.personaName.trim()
          : "";

      if (!personaName) {
        res.status(400).json({
          error: "personaName is required",
        });

        return;
      }

      const persona =
        await personaConfigLoader.getPersona(
          personaName
        );

      const result =
        await soqlAnalysisService.analyze(
          persona
        );

      res.json({
        personaName: result.personaName,
        summary: result.summary,
        outputFolder: outputDirectory,
      });
    } catch (error) {
      handleApiError(error, res);
    }
  }
);

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      status: "ok",
      repositoryName:
        path.basename(repositoryPath),
    });
  }
);

function handleApiError(
  error: unknown,
  res: express.Response
): void {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  if (
    message.startsWith(
      "Persona not found:"
    )
  ) {
    res.status(404).json({
      error: message,
    });

    return;
  }

  res.status(500).json({
    error: message,
  });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Salesforce Repository Analyzer API running on http://localhost:${PORT}`
  );
  // Start authenticating without opening a browser or blocking repository analysis.
  void salesforceOrgConnection.connect().then(() => {
    console.log("Salesforce org authenticated (Client Credentials). ");
  }).catch((error: unknown) => {
    console.warn("Salesforce org auto-connect unavailable:", error instanceof Error ? error.message : "Unknown error");
  });
});
