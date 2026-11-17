import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SalesforceCliAuthProvider, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";

test("outdated Salesforce CLI is blocked with a useful upgrade error", async () => {
  const cli = new SalesforceCliAuthProvider(async args =>
    args[0] === "--version" ? "@salesforce/cli/2.51.6" :
      JSON.stringify({ status: 0, result: { nonScratchOrgs: [] } }));
  await assert.rejects(cli.listOrgs(), /2\.51\.6 is too old.*sf update/i);
  await assert.rejects(cli.loginWeb("sandbox"), /2\.136 or newer/i);
});

test("refreshing CLI after upgrade succeeds without clearing existing Analyzer settings", async () => {
  let currentVersion = "@salesforce/cli/2.51.6";
  const run: CliRunner = async args => {
    if (args[0] === "--version") return currentVersion;
    return JSON.stringify({ status: 0, result: { nonScratchOrgs: [{
      alias: "unifiedQA", username: "admin@example.com.unifiedqa",
      instanceUrl: "https://example--unifiedqa.sandbox.my.salesforce.com",
      isSandbox: true, connectedStatus: "Connected",
    }] } });
  };
  const cli = new SalesforceCliAuthProvider(run);
  await assert.rejects(cli.listOrgs(), /too old/);
  currentVersion = "@salesforce/cli/2.157.8";
  const orgs = await cli.listOrgs();
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].alias, "unifiedQA");
});

test("login UI does not silently disable sandbox and production buttons after CLI errors", () => {
  const ui = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  const styles = readFileSync("web/src/components/SalesforceCliLogin.css", "utf8");
  assert.equal((ui.match(/disabled=\{Boolean\(busy\) \|\| loading\}/g) ?? []).length, 2);
  assert.doesNotMatch(ui, /disabled=\{[^\n]*error\s*&&\s*!cliVersion/);
  assert.match(ui, /Salesforce CLI update required/);
  assert.match(ui, /sf update/);
  assert.match(ui, /sf --version/);
  assert.match(ui, /Refresh orgs/);
  assert.match(ui, /Update Salesforce CLI to load saved orgs/);
  assert.match(ui, /Cannot load CLI orgs/);
  assert.match(ui, /Installed: " \+ detectedVersion \+ " · update required"/);
  assert.match(ui, /setError\(message\)/);
  assert.match(styles, /\.sf-cli-upgrade\{/);
});
