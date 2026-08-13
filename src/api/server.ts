import express from "express";
import path from "node:path";

import { scanRepository } from "../scanner/repositoryScanner.js";
import { PersonaConfigLoader } from "../config/PersonaConfigLoader.js";
import { PersonaPermissionResolver } from "../analyzer/PersonaPermissionResolver.js";
import { PersonaAccessService } from "../services/PersonaAccessService.js";
import { PersonaFieldAccessService } from "../services/PersonaFieldAccessService.js";
import { AccessQueryService } from "../services/AccessQueryService.js";
import { createMetadataRouter } from "./metadataRoutes.js";

const app = express();

app.use(express.json());

const PORT = 3000;

// --------------------------------------------------
// Repository configuration
// --------------------------------------------------

const repositoryPath =
  process.env.SALESFORCE_REPOSITORY_PATH;

if (!repositoryPath) {
  throw new Error(
    "SALESFORCE_REPOSITORY_PATH environment variable is not set."
  );
}

const paths = await scanRepository(repositoryPath);
app.use(
  "/api",
  createMetadataRouter(paths.defaultPath)
);
// --------------------------------------------------
// Services
// --------------------------------------------------

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

// --------------------------------------------------
// Personas
// --------------------------------------------------

app.get("/api/personas", async (_req, res) => {
  try {
    const personas =
      await personaConfigLoader.getAllPersonas();

    res.json(personas);
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
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
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
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

      if (!result) {
        res.status(404).json({
          error: "Field not found",
        });

        return;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }
);

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

app.listen(PORT, () => {
  console.log(
    `Salesforce Repository Analyzer API running on http://localhost:${PORT}`
  );
});