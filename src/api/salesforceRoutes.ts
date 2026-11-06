import { Router } from "express";
import { SalesforceConnectionError, SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";

/** Local-only backend access. No OAuth browser routes or client secrets exposed. */
export function createSalesforceRouter(connection: SalesforceOrgConnection): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      // Opening the UI also triggers connection if the startup attempt failed.
      if (!connection.status.connected && connection.status.configured) {
        void connection.connect().catch(() => undefined);
      }
      res.json(connection.status);
    } catch (error) {
      sendError(error, res);
    }
  });

  router.post("/reconnect", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      await connection.connect(true);
      res.json(connection.status);
    } catch (error) {
      sendError(error, res);
    }
  });

  router.post("/query", async (req, res) => {
    try {
      const soql = typeof req.body?.soql === "string" ? req.body.soql : "";
      const api = req.body?.api;
      if (api !== "data" && api !== "tooling") {
        res.status(400).json({ error: "api must be 'data' or 'tooling'." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(await connection.query(soql, api));
    } catch (error) {
      sendError(error, res);
    }
  });

  return router;
}

function sendError(error: unknown, res: import("express").Response): void {
  const statusCode = error instanceof SalesforceConnectionError ? error.statusCode : 500;
  res.status(statusCode).json({ error: error instanceof Error ? error.message : "Salesforce request failed." });
}
