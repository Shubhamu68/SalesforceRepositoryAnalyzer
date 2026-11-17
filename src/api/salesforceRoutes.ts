import { Router } from "express";
import { isLocalConfigurationRequest } from "./reportOutputRoutes.js";
import { SalesforceConnectionError, SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";

/**
 * Localhost-only Salesforce CLI session management. These endpoints never
 * return OAuth tokens; sign-in occurs on Salesforce's own browser login page.
 */
export function createSalesforceRouter(
  connection: SalesforceOrgConnection,
  onConnectionChange: () => void = () => {},
): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!isLocalConfigurationRequest(req.get("host"), req.get("origin"))) {
      res.status(403).json({ error: "Salesforce org access is available on localhost only." });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.header("Origin");
      if (origin) {
        let allowed = false;
        try {
          const url = new URL(origin);
          allowed = url.protocol === "http:" &&
            (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
        } catch { /* fail closed on malformed origins */ }
        if (!allowed) { res.status(403).json({ error: "Salesforce actions require the local Analyzer UI." }); return; }
      }
      if (req.method === "POST" && !req.is("application/json")) {
        res.status(415).json({ error: "Use application/json for Salesforce actions." }); return;
      }
    }
    next();
  });

  router.get("/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(connection.status);
  });

  router.get("/orgs", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      // Explicit Refresh orgs bypasses the temporary local discovery cache.
      res.json(await connection.listAuthorizedOrgs(req.query.refresh === "1"));
    } catch (error) { sendError(error, res); }
  });

  router.post("/select", async (req, res) => {
    try {
      const target = typeof req.body?.target === "string" ? req.body.target : "";
      if (!/^[a-zA-Z0-9_.@+-]{1,255}$/.test(target)) {
        res.status(400).json({ error: "Select a valid Salesforce CLI org." }); return;
      }
      onConnectionChange();
      await connection.selectOrg(target);
      onConnectionChange();
      res.setHeader("Cache-Control", "no-store");
      res.json(connection.status);
    } catch (error) {
      onConnectionChange();
      sendError(error, res);
    }
  });

  router.post("/login-web", async (req, res) => {
    try {
      const environment = req.body?.environment;
      if (environment !== "sandbox" && environment !== "production") {
        res.status(400).json({ error: "Choose Sandbox or Production for Salesforce login." }); return;
      }
      onConnectionChange();
      await connection.loginWeb(environment);
      onConnectionChange();
      res.setHeader("Cache-Control", "no-store");
      res.json(connection.status);
    } catch (error) {
      onConnectionChange();
      sendError(error, res);
    }
  });

  router.post("/disconnect", (_req, res) => {
    connection.disconnect();
    onConnectionChange();
    res.setHeader("Cache-Control", "no-store");
    res.json(connection.status);
  });

  router.post("/reconnect", async (_req, res) => {
    try {
      await connection.connect(true);
      onConnectionChange();
      res.setHeader("Cache-Control", "no-store");
      res.json(connection.status);
    } catch (error) { sendError(error, res); }
  });

  router.post("/query", async (req, res) => {
    try {
      const soql = typeof req.body?.soql === "string" ? req.body.soql : "";
      const api = req.body?.api;
      if (api !== "data" && api !== "tooling") {
        res.status(400).json({ error: "api must be 'data' or 'tooling'." }); return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(await connection.query(soql, api));
    } catch (error) { sendError(error, res); }
  });

  return router;
}

function sendError(error: unknown, res: import("express").Response): void {
  const status = error instanceof SalesforceConnectionError ? error.statusCode : 503;
  res.status(status).json({
    error: error instanceof Error ? error.message : "Salesforce CLI action failed.",
  });
}
