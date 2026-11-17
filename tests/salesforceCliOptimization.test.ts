import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SalesforceCliAuthProvider, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const ORG_ID = "00D000000000001";
const USER_ID = "005000000000001";
const USERNAME = "admin@example.com";
const INSTANCE = "https://qa--dev.sandbox.my.salesforce.com";
const SECRET = "never-log-access-token";
const org = { username: USERNAME, alias: "unifiedQA", orgId: ORG_ID, instanceUrl: INSTANCE, isSandbox: true };
const success = (result: unknown) => JSON.stringify({ status: 0, result });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("concurrent CLI version checks launch only one expensive process", async () => {
  const gate = deferred<string>();
  let versions = 0;
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] !== "--version") throw new Error("Unexpected command");
    versions++;
    return gate.promise;
  });
  const a = cli.version();
  const b = cli.version();
  assert.equal(versions, 1);
  gate.resolve("@salesforce/cli/2.158.7");
  assert.match(await a, /2\.158\.7/);
  assert.equal(await b, await a);
  assert.equal(await cli.version(), await a);
  assert.equal(versions, 1);
});

test("parallel org discovery shares the same process and later reads use short-lived cache", async () => {
  const gate = deferred<string>();
  let lists = 0;
  let versions = 0;
  const runner: CliRunner = async args => {
    if (args[0] === "--version") { versions++; return "@salesforce/cli/2.158.7"; }
    if (args.join(" ") === "org list --skip-connection-status --json") {
      lists++;
      return gate.promise;
    }
    throw new Error("Unexpected command");
  };
  const cli = new SalesforceCliAuthProvider(runner);
  const a = cli.listOrgs();
  const b = cli.listOrgs();
  gate.resolve(success({ nonScratchOrgs: [org] }));
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.length, 1);
  assert.deepEqual(second, first);
  assert.equal(lists, 1);
  assert.equal(versions, 1);
  const again = await cli.listOrgs();
  assert.equal(again.length, 1);
  assert.equal(lists, 1, "repeat display must not rerun a 10+ second CLI command");
  // Returned metadata is copied: callers cannot mutate the internal cache.
  again[0].alias = "tampered";
  assert.equal((await cli.listOrgs())[0].alias, "unifiedQA");
  assert.equal(cli.findListedOrg("unifiedQA")?.username, USERNAME);
  assert.equal(cli.findListedOrg(USERNAME)?.alias, "unifiedQA");
  assert.equal(cli.findListedOrg("not-authorized"), undefined);
  await cli.listOrgs(true);
  assert.equal(lists, 2, "manual Refresh orgs bypasses discovery cache");
});

test("selecting an org already shown in the dropdown skips CLI org discovery but still validates identity", async () => {
  let lists = 0;
  let tokens = 0;
  let displays = 0;
  let identityChecks = 0;
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args.join(" ") === "org list --skip-connection-status --json") {
      lists++; return success({ nonScratchOrgs: [org] });
    }
    if (args.includes("show-access-token")) { tokens++; return success({ accessToken: SECRET }); }
    if (args[1] === "display") {
      displays++; return success({ orgId: ORG_ID, username: USERNAME, instanceUrl: INSTANCE });
    }
    throw new Error("Unexpected command");
  });
  const conn = new SalesforceOrgConnection(cli);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    identityChecks++;
    return new Response(JSON.stringify({ organization_id: ORG_ID, user_id: USER_ID }), { status: 200 });
  };
  try {
    const initial = await conn.listAuthorizedOrgs();
    assert.equal(initial.orgs[0].alias, "unifiedQA");
    assert.equal(lists, 1);
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.organizationId, ORG_ID);
    assert.equal(conn.status.userId, USER_ID);
    assert.equal(lists, 1, "connecting should not list the same orgs again");
    assert.equal(tokens, 1, "real CLI access token is still required");
    assert.equal(displays, 1, "CLI org details are still checked");
    assert.equal(identityChecks, 1, "Salesforce UserInfo validates the session");
    const fresh = await conn.listAuthorizedOrgs(true);
    assert.equal(fresh.orgs.length, 1);
    assert.equal(lists, 2, "explicit refresh requests a new listing");
  } finally {
    globalThis.fetch = original;
  }
});

test("a previously listed org with expired CLI authorization cannot be reported connected", async () => {
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "list") return success({ nonScratchOrgs: [org] });
    if (args.includes("show-access-token")) throw new Error("Expired CLI authorization");
    if (args[1] === "display") return success({ orgId: ORG_ID, instanceUrl: INSTANCE });
    throw new Error("Unexpected command");
  });
  const conn = new SalesforceOrgConnection(cli);
  await conn.listAuthorizedOrgs();
  await assert.rejects(conn.selectOrg(USERNAME), /Expired CLI authorization/);
  assert.equal(conn.status.connected, false);
});

test("failed org discovery is retryable, not permanently cached", async () => {
  let attempts = 0;
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    attempts++;
    if (attempts < 3) throw new Error("CLI org listing failed");
    return success({ nonScratchOrgs: [org] });
  });
  await assert.rejects(cli.listOrgs(), /CLI org listing failed/);
  const recovered = await cli.listOrgs();
  assert.equal(recovered[0].username, USERNAME);
  assert.equal(attempts, 3);
});

test("browser login invalidates cached org discovery after a new authorization", async () => {
  let lists = 0;
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "list") {
      lists++;
      return success({ nonScratchOrgs: [org] });
    }
    if (args[1] === "login") return success({ username: USERNAME });
    throw new Error("Unexpected command");
  });
  await cli.listOrgs();
  assert.equal(lists, 1);
  await cli.loginWeb("sandbox");
  await cli.listOrgs();
  assert.equal(lists, 2);
});

test("the UI Refresh orgs action explicitly bypasses the server cache", () => {
  const ui = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  const routes = readFileSync("src/api/salesforceRoutes.ts", "utf8");
  assert.match(ui, /refresh\(true\)/);
  assert.match(ui, /\/api\/salesforce\/orgs\?refresh=1/);
  assert.match(routes, /req\.query\.refresh === "1"/);
});

test("reselecting the currently connected org is instant without new CLI or identity calls", async () => {
  const calls: string[] = [];
  let userInfoCalls = 0;
  const runner: CliRunner = async args => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "list") return success({ nonScratchOrgs: [org] });
    if (args.includes("show-access-token")) return success({ accessToken: SECRET });
    if (args[1] === "display") return success({
      orgId: ORG_ID, username: USERNAME, instanceUrl: INSTANCE,
    });
    throw new Error("Unexpected CLI command");
  };
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    userInfoCalls++;
    return new Response(JSON.stringify({ organization_id: ORG_ID, user_id: USER_ID }), { status: 200 });
  };
  try {
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.connected, true);
    assert.equal(userInfoCalls, 1);
    const firstConnectedAt = conn.status.connectedAt;
    const initialCommands = calls.length;
    // Both alias and username refer to the same verified session.
    await conn.selectOrg("UNIFIEDqa");
    await conn.selectOrg(USERNAME.toUpperCase());
    assert.equal(calls.length, initialCommands, "no extra sf processes for the connected org");
    assert.equal(userInfoCalls, 1, "no redundant user identity call");
    assert.equal(conn.status.connectedAt, firstConnectedAt);
    assert.equal(conn.status.username, USERNAME);
    // Disconnect must NOT cause the next selection to skip verification.
    conn.disconnect();
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.connected, true);
    assert.ok(calls.length > initialCommands);
    assert.equal(userInfoCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("switching away from the active org still fetches a fresh token and checks its identity", async () => {
  const secondOrg = {
    username: "new@example.com", alias: "otherQA", orgId: "00D000000000002",
    instanceUrl: "https://qa2--dev.sandbox.my.salesforce.com", isSandbox: true,
  };
  let tokenCalls = 0;
  let userInfoCalls = 0;
  const cli = new SalesforceCliAuthProvider(async args => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "list") return success({ nonScratchOrgs: [org, secondOrg] });
    if (args.includes("show-access-token")) { tokenCalls++; return success({ accessToken: SECRET }); }
    if (args[1] === "display") {
      const other = args.includes(secondOrg.username);
      return success({
        orgId: other ? secondOrg.orgId : ORG_ID,
        username: other ? secondOrg.username : USERNAME,
        instanceUrl: other ? secondOrg.instanceUrl : INSTANCE,
      });
    }
    throw new Error("Unexpected CLI command");
  });
  const conn = new SalesforceOrgConnection(cli);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => {
    userInfoCalls++;
    const other = String(request).includes("qa2--dev");
    return new Response(JSON.stringify({
      organization_id: other ? secondOrg.orgId : ORG_ID,
      user_id: USER_ID,
    }), { status: 200 });
  };
  try {
    await conn.listAuthorizedOrgs();
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.organizationId, ORG_ID);
    await conn.selectOrg("otherQA");
    assert.equal(conn.status.organizationId, secondOrg.orgId);
    assert.equal(conn.status.username, secondOrg.username);
    assert.equal(tokenCalls, 2, "different orgs still require fresh CLI tokens");
    assert.equal(userInfoCalls, 2, "different orgs still require Salesforce identity checks");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
