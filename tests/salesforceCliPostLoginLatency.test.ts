import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceCliAuthProvider, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const USER = "sandbox@example.com";
const ORG = "00D000000000001";
const OTHER_ORG = "00D000000000002";
const USER_ID = "005000000000001";
const INSTANCE = "https://qa--dev.sandbox.my.salesforce.com";
const TOKEN = "redacted-test-token";
const success = (result: unknown) => JSON.stringify({ status: 0, result });

function mockCli(loginResult: Record<string, unknown>) {
  const calls: string[] = [];
  const runner: CliRunner = async (args) => {
    const command = args.join(" ");
    calls.push(command);
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "login") return success(loginResult);
    if (args.includes("show-access-token")) return success({ accessToken: TOKEN });
    if (args[1] === "display") return success({
      username: USER, orgId: ORG, instanceUrl: INSTANCE,
    });
    throw new Error("Unexpected CLI operation");
  };
  return { calls, cli: new SalesforceCliAuthProvider(runner) };
}

test("fresh browser login reuses CLI OAuth org metadata, without a redundant org display process", async () => {
  const { cli, calls } = mockCli({ username: USER, orgId: ORG, instanceUrl: INSTANCE });
  const conn = new SalesforceOrgConnection(cli);
  const previousFetch = globalThis.fetch;
  let identityCalls = 0;
  globalThis.fetch = async (url, init) => {
    identityCalls++;
    assert.equal(String(url), INSTANCE + "/services/oauth2/userinfo");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + TOKEN);
    return new Response(JSON.stringify({ organization_id: ORG, user_id: USER_ID }), { status: 200 });
  };
  try {
    await conn.loginWeb("sandbox");
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.organizationId, ORG);
    assert.equal(conn.status.userId, USER_ID);
    assert.equal(identityCalls, 1, "Salesforce identity verification must not be skipped");
    assert.equal(calls.filter(cmd => cmd.startsWith("org display ")).length, 0);
    assert.equal(calls.filter(cmd => cmd.startsWith("org auth show-access-token ")).length, 1);
    assert.equal(calls.filter(cmd => cmd.startsWith("org login web ")).length, 1);
    assert.doesNotMatch(JSON.stringify(conn.status), /redacted-test-token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("browser login without complete org metadata falls back to the original CLI display checks", async () => {
  const { cli, calls } = mockCli({ username: USER });
  const conn = new SalesforceOrgConnection(cli);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    organization_id: ORG, user_id: USER_ID,
  }), { status: 200 });
  try {
    await conn.loginWeb("sandbox");
    assert.equal(conn.status.connected, true);
    assert.equal(calls.filter(cmd => cmd.startsWith("org display ")).length, 1);
    assert.equal(calls.filter(cmd => cmd.startsWith("org auth show-access-token ")).length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("invalid or mismatched browser-login metadata never suppresses CLI org display", async () => {
  for (const invalid of [
    { username: "another@example.com", orgId: ORG, instanceUrl: INSTANCE },
    { username: USER, orgId: "invalid", instanceUrl: INSTANCE },
    { username: USER, orgId: ORG },
  ]) {
    const { cli, calls } = mockCli({ username: USER });
    const session = await cli.showToken(USER, invalid);
    assert.equal(session.instanceUrl, INSTANCE);
    assert.equal(calls.filter(cmd => cmd.startsWith("org display ")).length, 1);
  }
});

test("fresh browser login still rejects a Salesforce UserInfo org mismatch", async () => {
  const { cli, calls } = mockCli({ username: USER, orgId: ORG, instanceUrl: INSTANCE });
  const conn = new SalesforceOrgConnection(cli);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    organization_id: OTHER_ORG, user_id: USER_ID,
  }), { status: 200 });
  try {
    await assert.rejects(conn.loginWeb("sandbox"), /different org/);
    assert.equal(conn.status.connected, false);
    assert.equal(calls.some(cmd => cmd.startsWith("org display ")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fresh browser login rejects a token that is invalid at Salesforce", async () => {
  const { cli } = mockCli({ username: USER, orgId: ORG, instanceUrl: INSTANCE });
  const conn = new SalesforceOrgConnection(cli);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  try {
    await assert.rejects(conn.loginWeb("sandbox"), /session expired/);
    assert.equal(conn.status.connected, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fresh browser login never sends the retrieved token to an unapproved CLI URL", async () => {
  const { cli } = mockCli({
    username: USER, orgId: ORG, instanceUrl: "https://unapproved.example.com",
  });
  const conn = new SalesforceOrgConnection(cli);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("{}", { status: 200 }); };
  try {
    await assert.rejects(conn.loginWeb("sandbox"), /Salesforce instance URL.*approved Salesforce HTTPS origin/);
    assert.equal(requests, 0, "the token must never be sent to an unapproved URL");
    assert.equal(conn.status.connected, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fresh browser login uses OAuth result without launching a separate CLI version process", async () => {
  const commands: string[] = [];
  const cli = new SalesforceCliAuthProvider(async args => {
    commands.push(args.join(" "));
    if (args[1] === "login") return success({ username: USER, orgId: ORG, instanceUrl: INSTANCE });
    throw new Error("Only the browser login command should run");
  });
  assert.deepEqual(await cli.loginWeb("sandbox"), { username: USER, orgId: ORG, instanceUrl: INSTANCE });
  assert.deepEqual(commands, ["org login web --instance-url https://test.salesforce.com --json"]);
});

test("unsupported token retrieval cannot establish a connected Analyzer session", async () => {
  const commands: string[] = [];
  const cli = new SalesforceCliAuthProvider(async args => {
    commands.push(args.join(" "));
    if (args[1] === "login") return success({ username: USER, orgId: ORG, instanceUrl: INSTANCE });
    if (args.includes("show-access-token")) throw new Error("Required secure CLI token command is unavailable");
    throw new Error("Unexpected operation");
  });
  const conn = new SalesforceOrgConnection(cli);
  await assert.rejects(conn.loginWeb("sandbox"), /token command is unavailable/);
  assert.equal(conn.status.connected, false);
  assert.equal(commands.some(cmd => cmd === "--version"), false);
  assert.equal(commands.filter(cmd => cmd.includes("show-access-token")).length, 1);
});
