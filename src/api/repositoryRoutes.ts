import { Router } from "express";
import { RepositoryConfigurationService } from "../services/RepositoryConfigurationService.js";
import { RepositorySetupError } from "../services/SalesforceRepositoryValidator.js";
import { isLocalConfigurationRequest } from "./reportOutputRoutes.js";

/** Local-only browser-initiated folder selection; never accepts a raw path. */
export function createRepositoryRouter(
  config: RepositoryConfigurationService,
  onSaved: () => void = () => undefined,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!isLocalConfigurationRequest(req.get("host"), req.get("origin"))) {
      res.status(403).json({ error: "Repository setup is available on localhost only." });
      return;
    }
    next();
  });
  router.get("/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await config.status());
  });
  router.post("/choose", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const selection = await config.chooseAndSave();
      if (selection.saved) onSaved();
      res.json(selection);
    } catch (error) {
      const code = error instanceof RepositorySetupError ? error.statusCode : 500;
      res.status(code).json({
        code: "INVALID_REPOSITORY",
        error: error instanceof Error ? error.message : "Invalid repository selection.",
      });
    }
  });
  return router;
}
