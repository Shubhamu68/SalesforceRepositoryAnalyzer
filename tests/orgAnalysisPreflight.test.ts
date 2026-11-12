import assert from "node:assert/strict";
import { test } from "node:test";
import { OrgAnalysisPreflightService, OrgAnalysisGuardError } from "../src/services/OrgAnalysisPreflightService.js";
import { buildWindowsFolderPickerScript } from "../src/services/windowsReportFolderPicker.js";

test("both missing credentials permit repo-only analysis only after explicit confirmation", async () => {
  let connectionCalls = 0;
  const service = new OrgAnalysisPreflightService({ connect: async () => { connectionCalls++; } }, {});
  const status = await service.check();
  assert.equal(status.mode, "REPOSITORY_ONLY");
  assert.deepEqual(status.missing, ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"]);
  assert.match(status.warning ?? "", /repository metadata only/);
  await assert.rejects(service.authorize(false), (error: unknown) => error instanceof OrgAnalysisGuardError &&
    error.code === "ORG_REPOSITORY_ONLY_CONFIRMATION_REQUIRED");
  assert.equal((await service.authorize(true)).mode, "REPOSITORY_ONLY");
  assert.equal(connectionCalls, 0);
});

test("one missing client credential warns with exact missing key and does not authenticate", async () => {
  let invoked = 0;
  const service = new OrgAnalysisPreflightService({ connect: async () => { invoked++; } },
    { SALESFORCE_CLIENT_ID: "configured" });
  const result = await service.check();
  assert.deepEqual(result.missing, ["SALESFORCE_CLIENT_SECRET"]);
  assert.equal(invoked, 0);
});

test("configured valid credentials authorize org-backed checks", async () => {
  let invoked = 0;
  const service = new OrgAnalysisPreflightService({ connect: async () => { invoked++; } },
    { SALESFORCE_CLIENT_ID: "valid-client", SALESFORCE_CLIENT_SECRET: "valid-secret" });
  const status = await service.authorize(false);
  assert.equal(status.mode, "ORG_AND_REPOSITORY");
  assert.deepEqual(status.missing, []);
  assert.equal(invoked, 1);
});

test("invalid client credentials block with an error; no repo-only bypass", async () => {
  const service = new OrgAnalysisPreflightService({
    connect: async () => { throw new Error("invalid_client"); },
  }, { SALESFORCE_CLIENT_ID: "bad", SALESFORCE_CLIENT_SECRET: "wrong" });
  await assert.rejects(service.authorize(true), (error: unknown) =>
    error instanceof OrgAnalysisGuardError &&
    error.code === "SALESFORCE_CREDENTIALS_INVALID" &&
    /Invalid Salesforce credentials/.test(error.message));
});

test("unavailable Salesforce authentication endpoint also blocks when creds are configured", async () => {
  const service = new OrgAnalysisPreflightService({
    connect: async () => { throw new Error("Unable to reach the Salesforce OAuth endpoint"); },
  }, { SALESFORCE_CLIENT_ID: "x", SALESFORCE_CLIENT_SECRET: "y" });
  await assert.rejects(service.check(), (error: unknown) =>
    error instanceof OrgAnalysisGuardError && /unavailable org connection/.test(error.message));
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
