import { spawn } from "node:child_process";

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
export type CliRunner = (args: string[], timeoutMs: number) => Promise<string>;

const ARG_SAFE = /^[a-zA-Z0-9_@.+:/-]+$/;
const ORG_NAME_SAFE = /^[a-zA-Z0-9_.@+-]{1,255}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CLI_TIMEOUT = 60000;
const WEB_LOGIN_TIMEOUT = 300000;

/** Arguments are shell-safe because Windows needs its sf.cmd wrapper. */
export function assertCliArguments(args: string[]): void {
  if (!args.length || args.some(arg => !ARG_SAFE.test(arg))) {
    throw new Error("Invalid Salesforce CLI command argument.");
  }
  const joined = args.join(" ");
  const permitted =
    /^--version$/.test(joined) ||
    joined === "org list --skip-connection-status --json" ||
    /^org display --target-org [a-zA-Z0-9_.@+-]+ --json$/.test(joined) ||
    /^org auth show-access-token --target-org [a-zA-Z0-9_.@+-]+ --json$/.test(joined) ||
    /^org login web --instance-url https:\/\/(test|login)\.salesforce\.com --json$/.test(joined);
  if (!permitted) throw new Error("Unsupported Salesforce CLI command.");
}

export const runSalesforceCli: CliRunner = async (args, timeoutMs) => {
  assertCliArguments(args);
  return new Promise<string>((resolve, reject) => {
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
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Salesforce CLI timed out. Complete browser sign-in and try again."));
    }, timeoutMs);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    }
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
      finish(new Error("Salesforce CLI is unavailable. Install or update Salesforce CLI and ensure 'sf' is on PATH."));
    });
    child.on("close", code => {
      if (code !== 0) {
        finish(new Error(stderrSeen
          ? "Salesforce CLI could not complete authentication. Check the org authorization or reauthenticate in the browser."
          : "Salesforce CLI command failed. Confirm the CLI is installed and the org is accessible."));
      } else finish();
    });
  });
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function parseCliResult(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Salesforce CLI returned invalid JSON. Update Salesforce CLI and try again."); }
  const root = record(parsed);
  if (!root || root.status !== 0 || !record(root.result)) {
    throw new Error("Salesforce CLI could not authorize this org. Reauthenticate using the browser.");
  }
  return root.result as Record<string, unknown>;
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
  constructor(private readonly run: CliRunner = runSalesforceCli) {}

  async version(): Promise<string> {
    const output = (await this.run(["--version"], 10000)).trim().slice(0, 120);
    const match = output.match(/@salesforce\/cli\/(\d+)\.(\d+)\.(\d+)/);
    if (!match) throw new Error("Cannot determine Salesforce CLI version. Update Salesforce CLI with 'sf update'.");
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 2 || (major === 2 && minor < 136)) {
      throw new Error("Salesforce CLI " + match[0].split("/")[1] +
        " is too old for secure token retrieval. Run 'sf update' to install version 2.136 or newer.");
    }
    return output;
  }

  async listOrgs(): Promise<CliOrg[]> {
    await this.version();
    const rows = parseCliResult(await this.run(
      ["org", "list", "--skip-connection-status", "--json"], CLI_TIMEOUT));
    const all = ["nonScratchOrgs", "scratchOrgs", "devHubs", "other", "orgs"]
      .flatMap(key => Array.isArray(rows[key]) ? rows[key] as unknown[] : []);
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

  async loginWeb(environment: "sandbox" | "production"): Promise<string> {
    await this.version();
    if (environment !== "sandbox" && environment !== "production") {
      throw new Error("Choose Sandbox or Production.");
    }
    // Salesforce CLI opens the regular Salesforce login page; passwords and
    // MFA/SSO data never enter this local Analyzer.
    const loginHost = environment === "sandbox" ? "test" : "login";
    const result = parseCliResult(await this.run(
      ["org", "login", "web", "--instance-url", "https://" + loginHost + ".salesforce.com", "--json"],
      WEB_LOGIN_TIMEOUT,
    ));
    const username = text(result.username);
    if (!username || !ORG_NAME_SAFE.test(username)) {
      throw new Error("Salesforce CLI completed login without a usable username.");
    }
    return username;
  }
}
