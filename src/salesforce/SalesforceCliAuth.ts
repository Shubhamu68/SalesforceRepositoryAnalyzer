import { spawn } from "node:child_process";

export type CliOrg = {
  username: string;
  alias?: string;
  orgId?: string;
  instanceUrl?: string;
  environment: "sandbox" | "production";
  status: "connected" | "expired";
};

export type CliSession = {
  accessToken: string;
  instanceUrl: string;
  orgId?: string;
  userId?: string;
};

export class SalesforceCliError extends Error {
  constructor(message: string, readonly statusCode = 503) {
    super(message);
  }
}

type CliJson = { status?: number; result?: unknown };
export type CliRunner = (args: string[], timeoutMs?: number) => Promise<unknown>;
const DEFAULT_TIMEOUT_MS = 45000;
const WEB_LOGIN_TIMEOUT_MS = 240000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Arguments containing shell metacharacters are never sent to Windows sf.cmd.
function validateTarget(value: string): string {
  if (!/^[A-Za-z0-9@._+\-]{1,255}$/.test(value)) {
    throw new SalesforceCliError("Invalid Salesforce CLI username or alias.", 400);
  }
  return value;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function valueOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function cliResult(payload: unknown): Record<string, unknown> {
  const top = objectOf(payload) as CliJson;
  if (typeof top.status === "number" && top.status !== 0) {
    throw new SalesforceCliError("Salesforce CLI could not complete the command. Reauthorize the org and retry.");
  }
  return objectOf(top.result);
}
function classifyOrg(row: Record<string, unknown>): "sandbox" | "production" {
  const type = (valueOf(row, "type") || "").toLowerCase();
  const host = (valueOf(row, "instanceUrl") || "").toLowerCase();
  return row.isSandbox === true || type.includes("sandbox") || type.includes("scratch") ||
    host.includes(".sandbox.") || host.includes("--") ? "sandbox" : "production";
}
function validInstanceUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new SalesforceCliError("Salesforce CLI returned an invalid instance URL."); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") ||
      !["salesforce.com", "force.com", "salesforce.mil"].some(
        domain => hostname === domain || hostname.endsWith("." + domain))) {
    throw new SalesforceCliError("Salesforce CLI returned a non-Salesforce instance URL.");
  }
  return url.origin;
}

/** Uses an argument array; never executes a command composed from arbitrary UI text. */
export const runSalesforceCli: CliRunner = (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    // Windows installs sf as sf.cmd. Every variable CLI argument is validated
    // before reaching this runner, so shell parsing cannot execute user input.
    const child = spawn(process.platform === "win32" ? "sf.cmd" : "sf", args, {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SF_DISABLE_TELEMETRY: "true" },
    });
    let output = "";
    let excess = false;
    const timeout = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length + chunk.length > MAX_OUTPUT_BYTES) { excess = true; child.kill(); }
      else output += chunk;
    });
    // Never persist or log CLI stderr/stdout. CLI output can contain bearer tokens.
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new SalesforceCliError("Salesforce CLI (sf) was not found. Install it and restart the Analyzer."));
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (excess) { reject(new SalesforceCliError("Salesforce CLI returned too much data.")); return; }
      if (code !== 0) {
        // Do not reflect CLI output/errors: versions can include sensitive auth data.
        reject(new SalesforceCliError(
          args[1] === "login"
            ? "Salesforce browser login did not complete. Retry the login in your browser."
            : "Salesforce CLI could not access this org. Its authorization may have expired; sign in again."
        ));
        return;
      }
      try { resolve(JSON.parse(output) as unknown); }
      catch { reject(new SalesforceCliError("Salesforce CLI did not return valid JSON. Update the Salesforce CLI.")); }
    });
  });

/** All auth remains on the loopback backend; browsers receive metadata only. */
export class SalesforceCliAuth {
  constructor(private readonly run: CliRunner = runSalesforceCli) {}

  async listOrgs(): Promise<CliOrg[]> {
    const result = cliResult(await this.run(["org", "list", "--json"]));
    const groups = ["nonScratchOrgs", "scratchOrgs", "devHubs", "other", "sandboxes", "productionOrgs"];
    const found = new Map<string, CliOrg>();
    for (const key of groups) {
      const rows = result[key];
      if (!Array.isArray(rows)) continue;
      for (const entry of rows) {
        const row = objectOf(entry);
        const username = valueOf(row, "username");
        if (!username || !/^[A-Za-z0-9@._+\-]{1,255}$/.test(username)) continue;
        const statusText = valueOf(row, "connectedStatus") || valueOf(row, "status") || "";
        const connected = /^connected$/i.test(statusText);
        const orgId = valueOf(row, "orgId");
        const origin = valueOf(row, "instanceUrl");
        const instanceUrl = origin ? (() => { try { return validInstanceUrl(origin); } catch { return undefined; } })() : undefined;
        const alias = valueOf(row, "alias");
        const candidate: CliOrg = {
          username, ...(alias ? { alias } : {}), ...(orgId ? { orgId } : {}),
          ...(instanceUrl ? { instanceUrl } : {}),
          environment: classifyOrg(row), status: connected ? "connected" : "expired",
        };
        const previous = found.get(username);
        if (!previous || (candidate.status === "connected" && previous.status !== "connected")) {
          found.set(username, candidate);
        }
      }
    }
    return [...found.values()].sort((a, b) =>
      a.environment.localeCompare(b.environment) ||
      (a.alias || a.username).localeCompare(b.alias || b.username));
  }

  async login(environment: "sandbox" | "production"): Promise<string> {
    if (environment !== "sandbox" && environment !== "production") {
      throw new SalesforceCliError("Select sandbox or production.", 400);
    }
    const loginHost = environment === "sandbox"
      ? "https://test.salesforce.com" : "https://login.salesforce.com";
    const result = cliResult(await this.run(
      ["org", "login", "web", "--instance-url", loginHost, "--json"],
      WEB_LOGIN_TIMEOUT_MS,
    ));
    const username = valueOf(result, "username");
    if (!username) throw new SalesforceCliError("CLI login completed without a username. Refresh the org list.");
    return validateTarget(username);
  }

  async session(username: string): Promise<CliSession> {
    const target = validateTarget(username);
    // Display gives us instance/user/org details. On older CLI versions it
    // also includes the token; on newer versions that token is redacted.
    const display = cliResult(await this.run(["org", "display", "--target-org", target, "--json"]));
    const rawInstance = valueOf(display, "instanceUrl");
    if (!rawInstance) throw new SalesforceCliError("Salesforce CLI did not return an instance URL.");
    const instanceUrl = validInstanceUrl(rawInstance);
    let accessToken = valueOf(display, "accessToken");
    if (!accessToken || /^\*+$|^\[?redacted\]?$/i.test(accessToken)) {
      // Introduced when Salesforce removed secrets from org display (2026).
      // The token is received only by this backend process, never returned to UI.
      const explicit = cliResult(await this.run([
        "org", "auth", "show-access-token", "--target-org", target, "--json",
      ]));
      accessToken = valueOf(explicit, "accessToken") || valueOf(explicit, "access_token");
    }
    if (!accessToken || /^\*+$|^\[?redacted\]?$/i.test(accessToken)) {
      throw new SalesforceCliError("Salesforce CLI did not provide a usable access token. Reauthorize this org.");
    }
    const orgId = valueOf(display, "orgId") || valueOf(display, "id");
    // sf org display does not reliably expose the Salesforce User record ID.
    // Keep the existing UserEntityAccess test query working by reading the
    // documented `sf org display user` result.id (no token reaches the UI).
    let userId = valueOf(display, "userId");
    if (!userId) {
      try {
        const user = cliResult(await this.run([
          "org", "display", "user", "--target-org", target, "--json",
        ]));
        const candidate = valueOf(user, "id") || valueOf(user, "userId");
        if (candidate && /^005[A-Za-z0-9]{12,15}$/.test(candidate)) userId = candidate;
      } catch {
        // Profile/User lookup can be blocked for an otherwise valid CLI user.
        // The connection and all normal org queries remain usable.
      }
    }
    return { accessToken, instanceUrl, ...(orgId ? { orgId } : {}), ...(userId ? { userId } : {}) };
  }
}
