import assert from "node:assert/strict";
import { test } from "node:test";
import { OrgAnalysisPreflightService, OrgAnalysisGuardError } from "../src/services/OrgAnalysisPreflightService.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import { buildWindowsFolderPickerScript } from "../src/services/windowsReportFolderPicker.js";

function fake(connected: boolean, connect: () => Promise<void> = async () => {}) {
  return { status: { configured: connected } as SalesforceOrgConnection["status"], connect };
}

test("no CLI org selected permits repository-only analysis only with confirmation", async () => {
  let calls = 0;
  const service = new OrgAnalysisPreflightService(fake(false, async () => { calls++; }));
  const status = await service.check();
  assert.equal(status.mode, "REPOSITORY_ONLY");
  assert.deepEqual(status.missing, []);
  assert.match(status.warning ?? "", /choose|connect|select|CLI/i);
  await assert.rejects(service.authorize(false), (error: unknown) =>
    error instanceof OrgAnalysisGuardError && error.code === "ORG_REPOSITORY_ONLY_CONFIRMATION_REQUIRED");
  assert.equal((await service.authorize(true)).mode, "REPOSITORY_ONLY");
  assert.equal(calls, 0);
});

test("selected Salesforce CLI org enables existing org-backed analysis", async () => {
  let calls = 0;
  const service = new OrgAnalysisPreflightService(fake(true, async () => { calls++; }));
  const verdict = await service.authorize(false);
  assert.equal(verdict.mode, "ORG_AND_REPOSITORY");
  assert.deepEqual(verdict.missing, []);
  assert.equal(calls, 1);
});

test("expired selected CLI session fails closed, even with repo-only acknowledgment", async () => {
  const service = new OrgAnalysisPreflightService(fake(true, async () => {
    throw new Error("CLI token expired");
  }));
  await assert.rejects(service.authorize(true), (error: unknown) =>
    error instanceof OrgAnalysisGuardError &&
    error.code === "SALESFORCE_SESSION_INVALID" &&
    /Reauthenticate/.test(error.message) &&
    !/CLI token expired/.test(error.message));
});

test("missing CLI org selection is independent of any environment variables", async () => {
  const service = new OrgAnalysisPreflightService(fake(false));
  assert.equal((await service.authorize(true)).mode, "REPOSITORY_ONLY");
});

test("repository-specific folder picker uses same topmost native dialog", () => {
  const source = buildWindowsFolderPickerScript("repository");
  assert.match(source, /force-app\/main\/default/);
  assert.match(source, /\$owner\.TopMost = \$true/);
  assert.match(source, /\$dialog\.ShowDialog\(\$owner\)/);
  assert.doesNotMatch(source, /Excel reports/);
  const reports = buildWindowsFolderPickerScript();
  assert.match(reports, /Excel reports/);
});
