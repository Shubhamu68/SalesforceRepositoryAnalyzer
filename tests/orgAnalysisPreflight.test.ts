import assert from "node:assert/strict";
import { test } from "node:test";
import { OrgAnalysisPreflightService, OrgAnalysisGuardError } from "../src/services/OrgAnalysisPreflightService.js";
import { buildWindowsFolderPickerScript } from "../src/services/windowsReportFolderPicker.js";

test("no selected CLI org permits repository-only analysis only after confirmation", async () => {
  let calls = 0;
  const service = new OrgAnalysisPreflightService({
    status: { configured: false },
    connect: async () => { calls++; },
  } as never);
  const status = await service.check();
  assert.equal(status.mode, "REPOSITORY_ONLY");
  assert.deepEqual(status.missing, ["SALESFORCE_ORG_SELECTION"]);
  assert.match(status.warning ?? "", /repository metadata only/);
  await assert.rejects(service.authorize(false), (error: unknown) =>
    error instanceof OrgAnalysisGuardError && error.code === "ORG_REPOSITORY_ONLY_CONFIRMATION_REQUIRED");
  assert.equal((await service.authorize(true)).mode, "REPOSITORY_ONLY");
  assert.equal(calls, 0);
});

test("selected and working CLI org permits live verification", async () => {
  let calls = 0;
  const service = new OrgAnalysisPreflightService({
    status: { configured: true, connected: true },
    connect: async () => { calls++; },
  } as never);
  assert.equal((await service.authorize(false)).mode, "ORG_AND_REPOSITORY");
  assert.equal(calls, 1);
});

test("expired CLI org blocks live verification even if repository-only is acknowledged", async () => {
  const service = new OrgAnalysisPreflightService({
    status: { configured: true, connected: false },
    connect: async () => { throw new Error("expired access/refresh token"); },
  } as never);
  await assert.rejects(service.authorize(true), (error: unknown) =>
    error instanceof OrgAnalysisGuardError &&
    error.code === "SALESFORCE_CONNECTION_INVALID" &&
    /reauthorize/i.test(error.message));
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
