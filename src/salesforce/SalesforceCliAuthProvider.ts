import { spawn } from "node:child_process";
import { cliAuthPhase, timedAuthStep } from "./SalesforceAuthTiming.js";

/**
 * Salesforce CLI is installed by each developer and owns OAuth authorization.
 * Never read CLI auth files or expose tokens, refresh URLs or passwords in APIs.
 * All commands run locally using fixed verbs and strictly validated arguments.
 */
export type CliOrg = {
  alias?: string;
  username: string;
  orgId?: string;
  instanceUrl?: string;
  environment: "sandbox" | "production";
  status: "saved" | "expired";
};
export type CliToken = { accessToken: string; instanceUrl: string; orgId?: string; username?: string };
export type CliRunner = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;

export class SalesforceCliLoginCancelledError extends Error {
  constructor() {
    super("Salesforce browser login was cancelled.");
    this.name = "SalesforceCliLoginCancelledError";
  }
}

const ARG_SAFE = /^[a-zA-Z0-9_@.+:/-]+$/;
const ORG_NAME_SAFE = /^[a-zA-Z0-9_.@+-]{1,255}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CLI_TIMEOUT = 60000;
// Windows CLI process launch may exceed the original 10-second version
// budget, especially when a packaged app or security tools are starting.
// The UI discovers orgs in the background; longer budgets do not block login
// controls. OAuth and token checks remain mandatory for real connections.
const CLI_VERSION_TIMEOUT = 45000;
const LOCAL_DISCOVERY_TIMEOUT = 30000;
// Saved orgs are only a UI hint; every selected session is still validated.
const SAVED_ORGS_CACHE_MS = 120000;
const WEB_LOGIN_TIMEOUT = 300000;

/** Arguments are shell-safe because Windows needs its sf.cmd wrapper. */
export function assertCliArguments(args: string[]): void {
  if (!args.length || args.some(arg => !ARG_SAFE.test(arg))) {
    throw new Error("Invalid Salesforce CLI command argument.");
  }
  const joined = args.join(" ");
  const permitted =
    /^--version$/.test(joined) ||
    (joined === "org list --json" || joined === "org list --skip-connection-status --json" ||
      joined === "org list auth --json") ||
    /^org display --target-org [a-zA-Z0-9_.@+-]+ --json$/.test(joined) ||
    /^org auth show-access-token --target-org [a-zA-Z0-9_.@+-]+ --json$/.test(joined) ||
    /^org login web --instance-url https:\/\/(test|login)\.salesforce\.com --json$/.test(joined);
  if (!permitted) throw new Error("Unsupported Salesforce CLI command.");
}

export const runSalesforceCli: CliRunner = async (args, timeoutMs, signal) => {
  assertCliArguments(args);
  if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
  // Includes CLI startup, Windows sf.cmd overhead and command execution.
  return timedAuthStep(cliAuthPhase(args), () => new Promise<string>((resolve, reject) => {
    // sf.cmd is a Windows command shim. All arguments are allowlisted above;
    // never pass user-supplied commands, paths, credentials or shell syntax.
    const child = spawn(process.platform === "win32" ? "sf.cmd" : "sf", args, {
      shell: process.platform === "win32", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SF_DISABLE_TELEMETRY: "true" },
    });
    let output = "";
    let stderrSeen = false;
    let finished = false;
    let terminating = false;

    function terminateProcessTree(): Promise<void> {
      return new Promise(resolveTermination => {
        // sf.cmd launches another process. Wait for taskkill to finish before
        // allowing a replacement login, or both can compete for OAuth ports.
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore",
          });
          killer.once("error", () => { child.kill(); resolveTermination(); });
          killer.once("close", () => resolveTermination());
        } else {
          child.kill();
          resolveTermination();
        }
      });
    }

    const onAbort = () => {
      if (finished || terminating) return;
      terminating = true;
      void terminateProcessTree().then(() => finish(new SalesforceCliLoginCancelledError()));
    };
    const timer = setTimeout(() => {
      if (finished || terminating) return;
      terminating = true;
      const action = args[0] === "org" && args[1] === "login" ? "Salesforce browser login"
        : args[0] === "org" && args[1] === "list" ? "Reading saved Salesforce CLI orgs"
        : "Salesforce CLI command";
      void terminateProcessTree().then(() =>
        finish(new Error(action + " timed out. Retry or check CLI availability.")));
    }, timeoutMs);

    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (output.length > MAX_JSON_BYTES) {
        child.kill();
        finish(new Error("Salesforce CLI returned an unexpectedly large response."));
      }
    });
    // Do not echo stdout or stderr: CLI output can include OAuth tokens.
    child.stderr.on("data", () => { stderrSeen = true; });
    child.on("error", () => {
      if (!terminating) finish(new Error("Salesforce CLI is unavailable. Install or update Salesforce CLI and ensure 'sf' is on PATH."));
    });
    child.on("close", code => {
      if (terminating) return;
      if (code !== 0) {
        finish(new Error(stderrSeen
          ? "Salesforce CLI could not complete authentication. Check the org authorization or reauthenticate in the browser."
          : "Salesforce CLI command failed. Confirm the CLI is installed and the org is accessible."));
      } else finish();
    });
  }));
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function parseCliPayload(raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Salesforce CLI returned invalid JSON. Update Salesforce CLI and try again."); }
  const root = record(parsed);
  if (!root || root.status !== 0 || root.result === undefined || root.result === null) {
    throw new Error("Salesforce CLI could not complete the command. Retry or reauthenticate.");
  }
  return root.result;
}
function parseCliResult(raw: string): Record<string, unknown> {
  const result = record(parseCliPayload(raw));
  if (!result) throw new Error("Salesforce CLI returned an unexpected response.");
  return result;
}
function normalizeOrg(raw: unknown): CliOrg | undefined {
  const row = record(raw);
  if (!row) return undefined;
  const username = text(row.username);
  if (!username || !ORG_NAME_SAFE.test(username)) return undefined;
  const alias = text(row.alias);
  const orgId = text(row.orgId);
  const instanceUrl = text(row.instanceUrl);
  const environment = row.isSandbox === true || /--|\.sandbox\.|test\.salesforce\.com/i.test(instanceUrl || "")
    ? "sandbox" : "production";
  const state = String(row.connectedStatus ?? row.status ?? "").toLowerCase();
  return {
    username, ...(alias && ORG_NAME_SAFE.test(alias) ? {alias} : {}),
    ...(orgId ? {orgId} : {}), ...(instanceUrl ? {instanceUrl} : {}),
    environment,
    status: state.includes("unable") || state.includes("expired") || state.includes("invalid")
      ? "expired" : "saved",
  };
}

export class SalesforceCliAuthProvider {
  private versionCache: string | null = null;
  private pendingVersion: Promise<string> | null = null;
  private savedOrgs: CliOrg[] | null = null;
  private savedOrgsExpiresAt = 0;
  private pendingOrgs: Promise<CliOrg[]> | null = null;

  constructor(private readonly run: CliRunner = runSalesforceCli) {}

  async version(): Promise<string> {
    if (this.versionCache) return this.versionCache;
    if (this.pendingVersion) return this.pendingVersion;
    // Concurrent /orgs calls must not spawn two expensive sf --version processes.
    const pending = (async () => {
      const output = (await this.run(["--version"], CLI_VERSION_TIMEOUT)).trim().slice(0, 120);
      const match = output.match(/@salesforce\/cli\/(\d+)\.(\d+)\.(\d+)/);
      if (!match) throw new Error("Cannot determine Salesforce CLI version. Update Salesforce CLI with 'sf update'.");
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major < 2 || (major === 2 && minor < 136)) {
        throw new Error("Salesforce CLI " + [match[1], match[2], match[3]].join(".") +
          " is too old for secure token retrieval. Run 'sf update' to install version 2.136 or newer.");
      }
      this.versionCache = output;
      return output;
    })();
    this.pendingVersion = pending;
    try { return await pending; }
    finally { if (this.pendingVersion === pending) this.pendingVersion = null; }
  }

  /**
   * Cached CLI org data is for display/selection only. It is never treated
   * as proof of an active or authorized session: showToken and UserInfo remain
   * required. A manual refresh bypasses the short-lived discovery cache.
   */
  async listOrgs(refresh = false): Promise<CliOrg[]> {
    if (this.pendingOrgs) return (await this.pendingOrgs).map(org => ({ ...org }));
    if (!refresh && this.savedOrgs && Date.now() < this.savedOrgsExpiresAt) {
      return this.savedOrgs.map(org => ({ ...org }));
    }
    const pending = this.discoverSavedOrgs();
    this.pendingOrgs = pending;
    try {
      const orgs = await pending;
      this.savedOrgs = orgs.map(org => ({ ...org }));
      this.savedOrgsExpiresAt = Date.now() + SAVED_ORGS_CACHE_MS;
      return orgs.map(org => ({ ...org }));
    } finally {
      if (this.pendingOrgs === pending) this.pendingOrgs = null;
    }
  }

  /** Use the last user-visible org selection without re-running CLI discovery. */
  findListedOrg(target: string): CliOrg | undefined {
    const found = this.savedOrgs?.find(org =>
      org.username.toLowerCase() === target.toLowerCase() ||
      org.alias?.toLowerCase() === target.toLowerCase());
    return found ? { ...found } : undefined;
  }

  private invalidateSavedOrgs(): void {
    this.savedOrgs = null;
    this.savedOrgsExpiresAt = 0;
  }

  private async discoverSavedOrgs(): Promise<CliOrg[]> {
    await this.version();
    // Only local discovery: avoid a live status check of every saved org.
    let all: unknown[];
    try {
      const rows = parseCliResult(await this.run(
        ["org", "list", "--skip-connection-status", "--json"], LOCAL_DISCOVERY_TIMEOUT));
      all = ["nonScratchOrgs", "scratchOrgs", "devHubs", "other", "orgs"]
        .flatMap(key => Array.isArray(rows[key]) ? rows[key] as unknown[] : []);
    } catch {
      const payload = parseCliPayload(await this.run(
        ["org", "list", "auth", "--json"], LOCAL_DISCOVERY_TIMEOUT));
      if (Array.isArray(payload)) all = payload;
      else {
        const rows = record(payload);
        if (!rows) throw new Error("Salesforce CLI returned invalid saved-org metadata.");
        all = ["nonScratchOrgs", "scratchOrgs", "devHubs", "other", "orgs"]
          .flatMap(key => Array.isArray(rows[key]) ? rows[key] as unknown[] : []);
      }
    }
    const unique = new Map<string, CliOrg>();
    for (const raw of all) {
      const org = normalizeOrg(raw);
      if (org) unique.set(org.username.toLowerCase(), org);
    }
    return [...unique.values()].sort((a, b) =>
      (a.alias ?? a.username).localeCompare(b.alias ?? b.username));
  }

  async showToken(username: string): Promise<CliToken> {
    if (!ORG_NAME_SAFE.test(username)) throw new Error("Invalid Salesforce CLI org username.");
    const [secret, display] = await Promise.all([
      this.run(["org", "auth", "show-access-token", "--target-org", username, "--json"], CLI_TIMEOUT),
      this.run(["org", "display", "--target-org", username, "--json"], CLI_TIMEOUT),
    ]);
    const token = parseCliResult(secret);
    const details = parseCliResult(display);
    const accessToken = text(token.accessToken);
    const instanceUrl = text(details.instanceUrl) ?? text(token.instanceUrl);
    if (!accessToken || !instanceUrl) {
      throw new Error("Salesforce CLI did not provide a valid session. Reauthenticate in the browser.");
    }
    return {
      accessToken, instanceUrl,
      ...(text(details.orgId) ? {orgId: text(details.orgId)} : {}),
      ...(text(details.username) ? {username: text(details.username)} : {username}),
    };
  }

  async loginWeb(environment: "sandbox" | "production", signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
    await this.version();
    if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
    if (environment !== "sandbox" && environment !== "production") {
      throw new Error("Choose Sandbox or Production.");
    }
    // Salesforce CLI opens the regular Salesforce login page; passwords and
    // MFA/SSO data never enter this local Analyzer.
    const loginHost = environment === "sandbox" ? "test" : "login";
    const result = parseCliResult(await this.run(
      ["org", "login", "web", "--instance-url", "https://" + loginHost + ".salesforce.com", "--json"],
      WEB_LOGIN_TIMEOUT, signal,
    ));
    if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
    const username = text(result.username);
    if (!username || !ORG_NAME_SAFE.test(username)) {
      throw new Error("Salesforce CLI completed login without a usable username.");
    }
    this.invalidateSavedOrgs();
    return username;
  }
}
