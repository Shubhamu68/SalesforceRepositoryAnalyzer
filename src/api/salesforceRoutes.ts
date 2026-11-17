import { Router } from "express";
import { isLocalConfigurationRequest } from "./reportOutputRoutes.js";
import { SalesforceConnectionError, SalesforceOrgConnection } from "../salesforce/SalesforceOrgConnection.js";
import { SalesforceCliError } from "../salesforce/SalesforceCliAuth.js";

/** The CLI executes only in the user's local backend process, never in the browser. */
export function createSalesforceRouter(
  connection: SalesforceOrgConnection,
  onOrgChanged: () => void = () => undefined,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!isLocalConfigurationRequest(req.get("host"), req.get("origin"))) {
      res.status(403).json({ error: "Salesforce org setup is available on localhost only." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/status", (_req, res) => {
    res.json(connection.status);
  });

  router.get("/orgs", async (_req, res) => {
    try { res.json(await connection.listOrgs()); }
    catch (error) { sendError(error, res); }
  });

  router.post("/login", async (req, res) => {
    try {
      const environment = req.body?.environment;
      if (environment !== "sandbox" && environment !== "production") {
        res.status(400).json({ error: "Choose sandbox or production." });
        return;
      }
      res.json(await connection.login(environment));
      onOrgChanged();
    } catch (error) { sendError(error, res); }
  });

  router.post("/select", async (req, res) => {
    try {
      const username = req.body?.username;
      if (typeof username !== "string") {
        res.status(400).json({ error: "Choose an existing Salesforce CLI org." });
        return;
      }
      res.json(await connection.selectOrg(username));
      onOrgChanged();
    } catch (error) { sendError(error, res); }
  });

  router.post("/disconnect", (_req, res) => {
    res.json(connection.disconnect());
    onOrgChanged();
  });

  router.post("/reconnect", async (_req, res) => {
    try {
      await connection.connect(true);
      res.json(connection.status);
      onOrgChanged();
    } catch (error) { sendError(error, res); }
  });

  router.post("/query", async (req, res) => {
    try {
      const soql = typeof req.body?.soql === "string" ? req.body.soql : "";
      const api = req.body?.api;
      if (api !== "data" && api !== "tooling") {
        res.status(400).json({ error: "api must be 'data' or 'tooling'." });
        return;
      }
      res.json(await connection.query(soql, api));
    } catch (error) { sendError(error, res); }
  });

  return router;
}

function sendError(error: unknown, res: import("express").Response): void {
  const statusCode = error instanceof SalesforceConnectionError || error instanceof SalesforceCliError
    ? error.statusCode : 500;
  const message = error instanceof SalesforceConnectionError || error instanceof SalesforceCliError
    ? error.message : "Salesforce request failed.";
  res.status(statusCode).json({ error: message });
}
