import assert from "node:assert/strict";
import { test } from "node:test";
import { cliAuthPhase, timedAuthStep } from "../src/salesforce/SalesforceAuthTiming.js";
import { SalesforceCliAuthProvider, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const ORG = "00D000000000001";
const USER = "005000000000001";
const USERNAME = "admin@example.com";
const URL = "https://qa--dev.sandbox.my.salesforce.com";
const TOKEN = "secret-token-never-print-this";
const success = (value: unknown) => JSON.stringify({ status: 0, result: value });

test("auth timing is disabled by default and does not change task results", async () => {
  const previous = process.env.SALESFORCE_AUTH_TIMING;
  const original = console.info;
  const messages: string[] = [];
  try {
    delete process.env.SALESFORCE_AUTH_TIMING;
    console.info = (line: unknown) => { messages.push(String(line)); };
    assert.equal(await timedAuthStep("auth.session", async () => 42), 42);
    await assert.rejects(timedAuthStep("auth.session", async () => {
      throw new Error("original failure");
    }), /original failure/);
    assert.deepEqual(messages, []);
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.SALESFORCE_AUTH_TIMING;
    else process.env.SALESFORCE_AUTH_TIMING = previous;
  }
});

test("enabled timing only prints fixed operation labels, duration, and outcome", async () => {
  const previous = process.env.SALESFORCE_AUTH_TIMING;
  const original = console.info;
  const messages: string[] = [];
  try {
    process.env.SALESFORCE_AUTH_TIMING = "1";
    console.info = (line: unknown) => { messages.push(String(line)); };
    const secret = "user@company.example TOKEN=abcdef https://instance.example";
    assert.equal(await timedAuthStep("auth.session", async () => secret), secret);
    await assert.rejects(timedAuthStep("auth.userInfo", async () => {
      throw new Error(secret);
    }), /TOKEN=abcdef/);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /^\[SF Auth Timing\] auth\.session: \d+ ms \(ok\)$/);
    assert.match(messages[1], /^\[SF Auth Timing\] auth\.userInfo: \d+ ms \(failed\)$/);
    assert.doesNotMatch(messages.join("\n"), /user@company|TOKEN=|instance\.example/);
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.SALESFORCE_AUTH_TIMING;
    else process.env.SALESFORCE_AUTH_TIMING = previous;
  }
});

test("CLI timing phases are derived from fixed commands, not target username", () => {
  assert.equal(cliAuthPhase(["--version"]), "cli.version");
  assert.equal(cliAuthPhase(["org", "list", "--skip-connection-status", "--json"]), "cli.savedOrgs");
  assert.equal(cliAuthPhase(["org", "list", "auth", "--json"]), "cli.savedOrgsFallback");
  assert.equal(cliAuthPhase(["org", "login", "web", "--instance-url", "https://test.salesforce.com", "--json"]), "cli.browserLogin");
  assert.equal(cliAuthPhase(["org", "auth", "show-access-token", "--target-org", USERNAME, "--json"]), "cli.accessToken");
  assert.equal(cliAuthPhase(["org", "display", "--target-org", USERNAME, "--json"]), "cli.orgDisplay");
});

test("browser login retains token and org identity checks while timing each phase", async () => {
  const previous = process.env.SALESFORCE_AUTH_TIMING;
  const originalInfo = console.info;
  const originalFetch = globalThis.fetch;
  const messages: string[] = [];
  const calls: string[] = [];
  try {
    process.env.SALESFORCE_AUTH_TIMING = "1";
    console.info = (line: unknown) => { messages.push(String(line)); };
    const runner: CliRunner = async args => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return "@salesforce/cli/2.158.7";
      if (args[1] === "login") return success({ username: USERNAME });
      if (args.includes("show-access-token")) return success({ accessToken: TOKEN });
      if (args[1] === "display") return success({ orgId: ORG, username: USERNAME, instanceUrl: URL });
      throw new Error("Unexpected command");
    };
    globalThis.fetch = async () => new Response(
      JSON.stringify({ organization_id: ORG, user_id: USER }), { status: 200 },
    );
    const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
    await conn.loginWeb("sandbox");
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.userId, USER);
    assert.equal(conn.status.organizationId, ORG);
    assert.ok(calls.some(call => call.startsWith("org auth show-access-token")));
    assert.ok(calls.some(call => call.startsWith("org display")));
    for (const phase of [
      "auth.browserLogin", "auth.session", "auth.userInfo", "auth.activateOrg", "auth.totalLogin",
    ]) assert.ok(messages.some(line => line.includes(` ${phase}:`)), `missing timing ${phase}`);
    assert.doesNotMatch(messages.join("\n"), /secret-token|admin@|qa--dev|005000|00D000/);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.SALESFORCE_AUTH_TIMING;
    else process.env.SALESFORCE_AUTH_TIMING = previous;
  }
});

test("timing diagnostics never weaken identity mismatch blocking", async () => {
  const previous = process.env.SALESFORCE_AUTH_TIMING;
  const originalInfo = console.info;
  const originalFetch = globalThis.fetch;
  const logs: string[] = [];
  try {
    process.env.SALESFORCE_AUTH_TIMING = "1";
    console.info = (line: unknown) => { logs.push(String(line)); };
    const runner: CliRunner = async args => {
      if (args[0] === "--version") return "@salesforce/cli/2.158.7";
      if (args[1] === "login") return success({ username: USERNAME });
      if (args.includes("show-access-token")) return success({ accessToken: TOKEN });
      if (args[1] === "display") return success({ orgId: ORG, username: USERNAME, instanceUrl: URL });
      throw new Error("Unexpected command");
    };
    globalThis.fetch = async () => new Response(JSON.stringify({
      organization_id: "00D000000000002", user_id: USER,
    }), { status: 200 });
    const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
    await assert.rejects(conn.loginWeb("sandbox"), /different org/);
    assert.equal(conn.status.connected, false);
    assert.ok(logs.some(line => line.includes("auth.totalLogin") && line.endsWith("(failed)")));
    assert.doesNotMatch(logs.join("\n"), /secret-token|admin@|qa--dev/);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.SALESFORCE_AUTH_TIMING;
    else process.env.SALESFORCE_AUTH_TIMING = previous;
  }
});
