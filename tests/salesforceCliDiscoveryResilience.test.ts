import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SalesforceCliAuthProvider, assertCliArguments, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

function ok(result: unknown): string { return JSON.stringify({ status: 0, result }); }
const ORG = "00D000000000001";
const USER = "005000000000001";
const URL = "https://qa--dev.sandbox.my.salesforce.com";
const saved = { username: "admin@example.com", alias: "unifiedQA", orgId: ORG, isSandbox: true, instanceUrl: URL };

test("startup lists saved CLI orgs locally, never refreshing every org over the network", async () => {
  const commands: Array<{ args: string; timeout: number }> = [];
  const cli = new SalesforceCliAuthProvider(async (args, timeout) => {
    commands.push({ args: args.join(" "), timeout });
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args.join(" ") === "org list --skip-connection-status --json") {
      return ok({ nonScratchOrgs: [saved] });
    }
    throw new Error("Unexpected live CLI command");
  });
  const orgs = await cli.listOrgs();
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].alias, "unifiedQA");
  assert.deepEqual(commands.slice(1), [
    { args: "org list --skip-connection-status --json", timeout: 30000 },
  ]);
  assert.ok(commands.every(item => item.args !== "org list --json"));
  assert.doesNotThrow(() => assertCliArguments(["org", "list", "auth", "--json"]));
});

test("double discovery timeout is degraded warning, not login-screen dead end", async () => {
  const commands: string[] = [];
  const run: CliRunner = async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (command.startsWith("org list")) throw new Error("offline CLI list timed out");
    if (command.startsWith("org login web")) return ok({ username: "admin@example.com" });
    if (command.startsWith("org auth show-access-token")) return ok({ accessToken: "test-token" });
    if (command.startsWith("org display")) return ok({
      orgId: ORG, username: "admin@example.com", instanceUrl: URL,
    });
    throw new Error("Unknown command");
  };
  const connection = new SalesforceOrgConnection(new SalesforceCliAuthProvider(run));
  const list = await connection.listAuthorizedOrgs();
  assert.equal(list.orgs.length, 0);
  assert.match(list.cliVersion, /2\.158\.7/);
  assert.match(list.warning ?? "", /sign in to Sandbox\/Production/);
  assert.equal(connection.status.connected, false);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ organization_id: ORG, user_id: USER }), { status: 200 });
  try {
    // A successful browser login must NOT attempt to run org list again.
    await connection.loginWeb("sandbox");
    assert.equal(connection.status.connected, true);
    assert.equal(connection.status.username, "admin@example.com");
    assert.equal(connection.status.organizationId, ORG);
    assert.equal(connection.status.userId, USER);
    assert.equal(commands.filter(command => command.startsWith("org list")).length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed subsequent org list does not clear an already established session", async () => {
  let offlineAvailable = true;
  const runner: CliRunner = async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "list") {
      if (!offlineAvailable) throw new Error("CLI list unavailable");
      return ok({ nonScratchOrgs: [saved] });
    }
    if (args.includes("show-access-token")) return ok({ accessToken: "test-token" });
    if (args[1] === "display") return ok({ instanceUrl: URL, orgId: ORG, username: saved.username });
    throw new Error("Unexpected CLI command");
  };
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ organization_id: ORG, user_id: USER }), { status: 200 });
  try {
    await conn.selectOrg(saved.username);
    assert.equal(conn.status.connected, true);
    offlineAvailable = false;
    // Ordinary discovery is deliberately served from local cache. Only an
    // explicit Refresh orgs should attempt the failed CLI commands again.
    assert.equal((await conn.listAuthorizedOrgs()).orgs.length, 1);
    const list = await conn.listAuthorizedOrgs(true);
    assert.match(list.warning ?? "", /Saved CLI orgs could not be loaded/);
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.organizationId, ORG);
  } finally {
    globalThis.fetch = original;
  }
});

test("login UI shows recovery instructions for list failure instead of trapping both buttons", () => {
  const component = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  const backend = readFileSync("src/salesforce/SalesforceOrgConnection.ts", "utf8");
  const cli = readFileSync("src/salesforce/SalesforceCliAuthProvider.ts", "utf8");
  assert.match(component, /setDiscoveryWarning\(typeof list\.warning/);
  assert.match(component, /Saved CLI orgs unavailable/);
  assert.match(component, /canStartBrowserLogin\(\{/);
  assert.doesNotMatch(component, /setFailedSavedSelection|hasActiveCliOrgs/);
  assert.doesNotMatch(component, /checking: loading/);
  assert.match(component, /busy: busy === "select" \|\| busy === "switching" \|\| busy === "cancelling"/);
  assert.match(component, /setCurrent\(session\)/);
  assert.match(component, /if \(autoContinueConnected && session\.connected && loginAttempt\.current === 0\)/);
  assert.match(backend, /this\.activateOrg\(\{ \.\.\.browserOrg, environment, status: "saved" \}, controller\.signal, browserOrg\)/);
  assert.match(cli, /"org", "list", "--skip-connection-status", "--json"/);
  assert.match(cli, /"org", "list", "auth", "--json"/);
  assert.doesNotMatch(cli, /this\.run\(\["org", "list", "--json"\]/);
  assert.doesNotMatch(cli, /Complete browser sign-in and try again/);
});
