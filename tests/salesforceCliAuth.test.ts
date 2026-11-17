import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceCliAuth, SalesforceCliError, type CliRunner } from "../src/salesforce/SalesforceCliAuth.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const sandbox = {
  username: "developer@example.com.sandbox",
  alias: "sandboxqa",
  orgId: "00D000000000001AAA",
  instanceUrl: "https://example--sandbox.sandbox.my.salesforce.com",
  connectedStatus: "Connected",
  type: "Sandbox",
};
const production = {
  username: "developer@example.com",
  alias: "production",
  orgId: "00D000000000002AAA",
  instanceUrl: "https://example.my.salesforce.com",
  connectedStatus: "Connected",
  type: "Production",
};
const expired = {
  username: "expired@example.com.sandbox",
  alias: "oldqa",
  instanceUrl: "https://example--oldqa.sandbox.my.salesforce.com",
  connectedStatus: "Unable to refresh session due to expired access/refresh token",
  type: "Sandbox",
};
const list = { status: 0, result: { nonScratchOrgs: [sandbox, expired, production] } };
const result = (data: object) => ({ status: 0, result: data });

test("lists sandbox, production and expired CLI auth without exposing tokens", async () => {
  const auth = new SalesforceCliAuth(async () => list);
  const orgs = await auth.listOrgs();
  assert.equal(orgs.length, 3);
  assert.equal(orgs.find(org => org.alias === "oldqa")?.status, "expired");
  assert.equal(orgs.find(org => org.alias === "production")?.environment, "production");
  assert.equal(orgs.find(org => org.alias === "sandboxqa")?.environment, "sandbox");
  assert.ok(!JSON.stringify(orgs).includes("accessToken"));
});

test("reads access token from legacy sf org display without using client credentials", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = async args => {
    calls.push(args);
    return result({
      instanceUrl: sandbox.instanceUrl,
      accessToken: "legacy-access-token",
      orgId: sandbox.orgId, userId: "005000000000001AAA",
    });
  };
  const auth = new SalesforceCliAuth(runner);
  const session = await auth.session(sandbox.username);
  assert.equal(session.accessToken, "legacy-access-token");
  assert.equal(session.userId, "005000000000001AAA");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].join(" "), "org display --target-org developer@example.com.sandbox --json");
});

test("new CLI uses dedicated show-access-token command after display redaction", async () => {
  const calls: string[][] = [];
  const auth = new SalesforceCliAuth(async args => {
    calls.push(args);
    if (args[1] === "display") return result({ instanceUrl: production.instanceUrl, orgId: production.orgId });
    return result({ accessToken: "new-token" });
  });
  const session = await auth.session(production.username);
  assert.equal(session.accessToken, "new-token");
  assert.equal(calls[1].join(" "), "org auth show-access-token --target-org developer@example.com --json");
});

test("rejects unsafe targets and untrusted instance origins", async () => {
  const auth = new SalesforceCliAuth(async () =>
    result({ instanceUrl: "https://attacker.example", accessToken: "unsafe-token" }));
  await assert.rejects(auth.session("x & whoami"), SalesforceCliError);
  await assert.rejects(auth.session("user@example.com"), /non-Salesforce instance URL/);
});

test("browser sign-in chooses official endpoint for sandbox and production", async () => {
  const calls: string[][] = [];
  const auth = new SalesforceCliAuth(async args => {
    calls.push(args);
    return result({ username: "developer@example.com" });
  });
  assert.equal(await auth.login("sandbox"), "developer@example.com");
  assert.ok(calls[0].includes("https://test.salesforce.com"));
  assert.equal(await auth.login("production"), "developer@example.com");
  assert.ok(calls[1].includes("https://login.salesforce.com"));
});

test("selected org is required and switching org clears active Salesforce session", async () => {
  const calls: string[][] = [];
  const runner: CliRunner = async args => {
    calls.push(args);
    if (args[1] === "list") return list;
    if (args[1] === "display") {
      const isProd = args[3] === production.username;
      return result({
        instanceUrl: isProd ? production.instanceUrl : sandbox.instanceUrl,
        orgId: isProd ? production.orgId : sandbox.orgId,
        userId: "005000000000001AAA",
        accessToken: isProd ? "prod-token" : "qa-token",
      });
    }
    throw new Error("Unexpected CLI invocation");
  };
  const connection = new SalesforceOrgConnection(new SalesforceCliAuth(runner));
  assert.equal(connection.status.configured, false);
  await assert.rejects(connection.connect(), /Select or sign in/);
  await connection.selectOrg(sandbox.username);
  assert.equal(connection.status.environment, "sandbox");
  assert.equal(connection.status.organizationId, sandbox.orgId);
  const oldScope = connection.cacheScope;
  await connection.selectOrg(production.username);
  assert.equal(connection.status.organizationId, production.orgId);
  assert.notEqual(connection.cacheScope, oldScope);
  assert.equal(connection.status.instanceUrl, production.instanceUrl);
  assert.equal(connection.disconnect().connected, false);
  assert.equal(connection.status.configured, false);
  assert.equal(calls.filter(args => args[1] === "display").length, 2);
});

test("expired CLI org is rejected and current selected org is preserved", async () => {
  const auth = new SalesforceCliAuth(async args => {
    if (args[1] === "list") return list;
    return result({
      instanceUrl: production.instanceUrl,
      orgId: production.orgId,
      accessToken: "prod-token",
    });
  });
  const connection = new SalesforceOrgConnection(auth);
  await connection.selectOrg(production.username);
  await assert.rejects(connection.selectOrg(expired.username), /expired/);
  assert.equal(connection.status.username, production.username);
  assert.equal(connection.status.connected, true);
});

test("derives current Salesforce User ID via org display user when org display omits it", async () => {
  const calls: string[][] = [];
  const auth = new SalesforceCliAuth(async args => {
    calls.push(args);
    if (args[1] === "display" && args[2] === "user") {
      return result({ id: "005000000000007AAA", username: production.username });
    }
    return result({
      instanceUrl: production.instanceUrl,
      orgId: production.orgId,
      accessToken: "legacy-token",
    });
  });
  const session = await auth.session(production.username);
  assert.equal(session.userId, "005000000000007AAA");
  assert.equal(calls[1].join(" "),
    "org display user --target-org developer@example.com --json");
});

test("missing user metadata does not block a valid CLI org session", async () => {
  const auth = new SalesforceCliAuth(async args => {
    if (args[2] === "user") throw new SalesforceCliError("User lookup not allowed");
    return result({
      instanceUrl: sandbox.instanceUrl,
      accessToken: "legacy-token",
      orgId: sandbox.orgId,
    });
  });
  const session = await auth.session(sandbox.username);
  assert.equal(session.accessToken, "legacy-token");
  assert.equal(session.userId, undefined);
});
