import { Router } from "express";
import {
  ReportOutputConfigurationError,
  ReportOutputConfigurationService,
} from "../services/ReportOutputConfigurationService.js";

/** Writable local configuration must never be exposed to arbitrary web origins. */
export function createReportOutputRouter(config: ReportOutputConfigurationService): Router {
  const router = Router();

  // Reject DNS-rebinding hosts and cross-site requests to local configuration.
  router.use((req, res, next) => {
    if (!isLocalConfigurationRequest(req.get("host"), req.get("origin"))) {
      res.status(403).json({ error: "Report output configuration is accessible from localhost only." });
      return;
    }
    next();
  });

  router.get("/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await config.getStatus());
  });

  router.post("/choose", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await config.chooseAndSave();
      res.json(result);
    } catch (error) {
      const statusCode = error instanceof ReportOutputConfigurationError ? error.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "Unable to choose report output directory.",
      });
    }
  });

  return router;
}

function isLocalHost(value: string): boolean {
  return /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(value);
}

function isLocalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLocalHost(url.host) &&
      url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isLocalConfigurationRequest(host: string | undefined, origin: string | undefined): boolean {
  return isLocalHost(host ?? "") && (origin === undefined || isLocalOrigin(origin));
}
