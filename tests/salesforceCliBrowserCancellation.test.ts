import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceCliAuthProvider, SalesforceCliLoginCancelledError, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const ORG_ID = "00D000000000001";
const USER_ID = "005000000000001";
const USERNAME = "qa@example.com";
const INSTANCE = "https://qa--dev.sandbox.my.salesforce.com";
const success = (result: unknown) => JSON.stringify({ status: 0, result });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setupPendingProduction() {
  const productionStarted = deferred<void>();
  const cancelled = deferred<void>();
  let cancelledProduction = 0;
  let startedSandbox = 0;
  const runner: CliRunner = async (args, _timeout, signal) => {
    if (args[0] === "--version") return "@salesforce/cli/2.158.7";
    if (args[1] === "login") {
      if (args.includes("https://login.salesforce.com")) {
        return new Promise<string>((_resolve, reject) => {
          const abort = () => {
            cancelledProduction++;
            cancelled.resolve();
            reject(new SalesforceCliLoginCancelledError());
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          productionStarted.resolve();
        });
      }
      startedSandbox++;
      return success({ username: USERNAME });
    }
    if (args.includes("show-access-token")) return success({ accessToken: "unexposed-secret" });
    if (args[1] === "display") return success({
      orgId: ORG_ID, username: USERNAME, instanceUrl: INSTANCE,
    });
    throw new Error("Unexpected CLI command " + args.join(" "));
  };
  return {
    connection: new SalesforceOrgConnection(new SalesforceCliAuthProvider(runner)),
    productionStarted: productionStarted.promise,
    cancelled: cancelled.promise,
    metrics: () => ({ cancelledProduction, startedSandbox }),
  };
}

test("abandoning Production browser login terminates the old attempt without waiting five minutes", async () => {
  const { connection, productionStarted, cancelled, metrics } = setupPendingProduction();
  const pending = connection.loginWeb("production");
  const observed = assert.rejects(pending, /cancelled/i);
  await productionStarted;
  assert.equal(await connection.cancelLoginWeb(), true);
  await cancelled;
  await observed;
  assert.equal(connection.status.connected, false);
  assert.equal(connection.status.configured, false);
  assert.deepEqual(metrics(), { cancelledProduction: 1, startedSandbox: 0 });
  assert.equal(await connection.cancelLoginWeb(), false);
});

test("Production to Sandbox switch cancels the old CLI login before activating Sandbox", async () => {
  const { connection, productionStarted, metrics } = setupPendingProduction();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ organization_id: ORG_ID, user_id: USER_ID }), { status: 200 });
  try {
    const pendingProduction = connection.loginWeb("production");
    const observed = assert.rejects(pendingProduction, /cancelled/i);
    await productionStarted;
    await connection.loginWeb("sandbox");
    await observed;
    assert.deepEqual(metrics(), { cancelledProduction: 1, startedSandbox: 1 });
    assert.equal(connection.status.connected, true);
    assert.equal(connection.status.environment, "sandbox");
    assert.equal(connection.status.username, USERNAME);
    assert.equal(connection.status.organizationId, ORG_ID);
    assert.equal(connection.status.userId, USER_ID);
    assert.doesNotMatch(JSON.stringify(connection.status), /unexposed-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an already-aborted browser sign-in never starts a CLI command", async () => {
  const seen: string[] = [];
  const runner: CliRunner = async args => {
    seen.push(args.join(" "));
    return "@salesforce/cli/2.158.7";
  };
  const cli = new SalesforceCliAuthProvider(runner);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cli.loginWeb("production", controller.signal),
    error => error instanceof SalesforceCliLoginCancelledError);
  assert.deepEqual(seen, []);
});
