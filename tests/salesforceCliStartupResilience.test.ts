import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceCliAuthProvider, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const ORG_ID = "00D000000000001";
const USER_ID = "005000000000001";
const USERNAME = "qa@example.com";
const INSTANCE = "https://qa--dev.sandbox.my.salesforce.com";
const success = (result: unknown) => JSON.stringify({ status: 0, result });

test("slow Windows Salesforce CLI version startup has an explicit longer timeout", async () => {
  const timeouts: number[] = [];
  const cli = new SalesforceCliAuthProvider(async (args, timeout) => {
    assert.deepEqual(args, ["--version"]);
    timeouts.push(timeout);
    return "@salesforce/cli/2.158.7";
  });
  assert.match(await cli.version(), /2\.158\.7/);
  assert.match(await cli.version(), /2\.158\.7/);
  assert.deepEqual(timeouts, [45000], "version is verified once and cached");
});

test("CLI startup timeout degrades org discovery without falsely denying authorization", async () => {
  let attempts = 0;
  let listCalls = 0;
  const runner: CliRunner = async args => {
    if (args[0] === "--version") {
      attempts++;
      if (attempts === 1) throw new Error("Salesforce CLI command timed out. Retry.");
      return "@salesforce/cli/2.158.7";
    }
    if (args.join(" ") === "org list --skip-connection-status --json") {
      listCalls++;
      return success({ nonScratchOrgs: [{
        username: USERNAME, alias: "qa", isSandbox: true, orgId: ORG_ID, instanceUrl: INSTANCE,
      }] });
    }
    throw new Error("Unexpected CLI command");
  };
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
  const degraded = await conn.listAuthorizedOrgs();
  assert.equal(degraded.cliVersion, "");
  assert.deepEqual(degraded.orgs, []);
  assert.match(degraded.warning ?? "", /taking longer than expected/);
  assert.equal(conn.status.connected, false, "a timeout never implies valid authorization");
  assert.equal(listCalls, 0, "do not launch org discovery until CLI responds");
  const recovered = await conn.listAuthorizedOrgs();
  assert.equal(recovered.orgs.length, 1);
  assert.equal(recovered.orgs[0].alias, "qa");
  assert.equal(attempts, 2, "a failed version check is retryable");
  assert.equal(listCalls, 1);
  assert.equal(conn.status.connected, false, "discovery never grants an OAuth session");
});

test("an outdated CLI still fails explicitly rather than being hidden as a slow-start warning", async () => {
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(
    async () => "@salesforce/cli/2.51.6"));
  await assert.rejects(conn.listAuthorizedOrgs(), /too old/);
  assert.equal(conn.status.connected, false);
});

test("browser login bypasses unrelated CLI version timeout and verifies user identity", async () => {
  let attempts = 0;
  const runner: CliRunner = async args => {
    if (args[0] === "--version") {
      attempts++;
      if (attempts === 1) throw new Error("Salesforce CLI command timed out.");
      return "@salesforce/cli/2.158.7";
    }
    if (args[1] === "login") return success({ username: USERNAME });
    if (args.includes("show-access-token")) return success({ accessToken: "private-test-token" });
    if (args[1] === "display") return success({
      username: USERNAME, orgId: ORG_ID, instanceUrl: INSTANCE,
    });
    throw new Error("Unexpected command");
  };
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
  const warning = await conn.listAuthorizedOrgs();
  assert.match(warning.warning ?? "", /taking longer/);
  const oldFetch = globalThis.fetch;
  let identityChecks = 0;
  globalThis.fetch = async () => {
    identityChecks++;
    return new Response(JSON.stringify({ organization_id: ORG_ID, user_id: USER_ID }), { status: 200 });
  };
  try {
    await conn.loginWeb("sandbox");
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.organizationId, ORG_ID);
    assert.equal(conn.status.userId, USER_ID);
    assert.equal(attempts, 1, "direct OAuth login must not repeat a failed version preflight");
    assert.equal(identityChecks, 1, "Salesforce UserInfo still verifies the session");
    assert.doesNotMatch(JSON.stringify(conn.status), /private-test-token/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
