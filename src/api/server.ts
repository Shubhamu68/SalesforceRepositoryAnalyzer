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

const app = express();

app.use(express.json());

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
    paths.mutingPermissionSetsPath
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

app.listen(PORT, () => {
  console.log(
    `Salesforce Repository Analyzer API running on http://localhost:${PORT}`
  );
});
