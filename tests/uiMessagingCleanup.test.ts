import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  WORKFLOW_COPY, analysisModeHint, orgPreflightMessage, reportOutputHint,
  repositorySetupMessage, salesforceConnectionLabel,
  type SalesforceConnectionState,
} from "../web/src/utils/uiMessaging.js";

const source = (name: string) =>
  readFile(new URL("../web/src/" + name, import.meta.url), "utf8");

test("analysis copy distinguishes a live org connection from verified permissions", () => {
  const states: SalesforceConnectionState[] = ["connected", "connecting", "unavailable", "not-configured"];
  assert.deepEqual(states.map(salesforceConnectionLabel), [
    "Salesforce connected", "Salesforce connecting…",
    "Salesforce unavailable", "Salesforce not connected",
  ]);
  for (const screen of ["access", "soql", "matrix", "stack"] as const) {
    const connected = analysisModeHint(screen, "connected");
    assert.match(connected, /verification available/);
    assert.doesNotMatch(connected, /verified|granted|allowed/i);
    assert.match(analysisModeHint(screen, "not-configured"), /not connected/);
    assert.match(analysisModeHint(screen, "connecting"), /connecting/);
  }
  assert.match(analysisModeHint("soql", "unavailable"), /connection required/);
  assert.match(analysisModeHint("stack", "unavailable"), /connection required/);
  assert.match(analysisModeHint("access", "unavailable"), /verification unavailable/);
  assert.match(analysisModeHint("matrix", "unavailable"), /verification unavailable/);
});

test("repository-only mode is explicit about unselected CLI org, not missing secrets", () => {
  assert.match(orgPreflightMessage([]), /No Salesforce org is connected/);
  assert.match(orgPreflightMessage([]), /CLI/);
  assert.doesNotMatch(orgPreflightMessage([]), /client secret|password|denied/i);
});

test("first-run setup avoids generic duplicate error banners but preserves real errors", () => {
  assert.equal(repositorySetupMessage("MISSING", "Choose a valid repository root."), "");
  assert.equal(repositorySetupMessage("INVALID_REPOSITORY", "Missing objects folder."), "Missing objects folder.");
  assert.equal(reportOutputHint("MISSING", "Choose a folder to save the Excel report."), "");
  assert.equal(reportOutputHint(undefined, "Choose a folder to save the Excel report."), "");
  assert.equal(reportOutputHint("NOT_WRITABLE", "Folder not writable."), "Folder not writable.");
});

test("screens use concise copy and retain Excel-only and access distinctions", async () => {
  const app = await source("App.tsx");
  const matrix = await source("components/ObjectAccessMatrix.tsx");
  const stack = await source("components/StackTraceImpact.tsx");
  const org = await source("components/SalesforceOrgConnection.tsx");
  const report = await source("components/ReportOutputSetupModal.tsx");
  const repository = await source("components/RepositorySetupModal.tsx");
  const warning = await source("components/OrgAnalysisWarningModal.tsx");

  assert.equal(WORKFLOW_COPY.soql.description, "Scan Apex queries and save one Excel workbook.");
  assert.match(app, /salesforceConnectionLabel\(salesforceConnection\)/);
  assert.match(app, /analysisModeHint\(page === "soql" \? "soql" : "access", salesforceConnection\)/);
  assert.match(app, /<ObjectAccessMatrix[^>]*connection=\{salesforceConnection\}/);
  assert.match(app, /<StackTraceImpact connection=\{salesforceConnection\}/);
  assert.match(matrix, /analysisModeHint\("matrix", connection\)/);
  assert.match(stack, /analysisModeHint\("stack", connection\)/);
  assert.match(matrix, /persona\.permissionEvidence\?\.\[permission\.key\]/);
  assert.match(matrix, /No repository grant/);
  assert.match(matrix, /Review = insufficient evidence/);
  assert.match(app, /<details className="source-section">/);
  assert.match(org, /<details className="sf-detail-disclosure">/);
  assert.match(org, /role="status"/);
  assert.match(report, /Excel workbook/);
  assert.match(report, /report-folder-title/);
  assert.match(repository, /force-app\/main\/default/);
  assert.match(repository, /role="dialog"/);
  assert.match(warning, /role="alertdialog"/);
  assert.match(stack, /Static analysis may include unexecuted branches/);

  for (const [name, code] of [["App", app], ["Matrix", matrix], ["Stack", stack], ["Org", org], ["Report", report]]) {
    assert.doesNotMatch(code, /Uses repository metadata · No Salesforce org connection required|Proof of concept|TXT report|References worksheet|security reports\.\.\./i, name);
  }
});

test("loading and completion states are concise without invented durations", async () => {
  const app = await source("App.tsx");
  const stack = await source("components/StackTraceLoadingOverlay.tsx");
  assert.match(app, /SOQL ANALYSIS COMPLETE/);
  assert.match(app, /Excel report saved for/);
  assert.doesNotMatch(app, /This may take 20–30 seconds/);
  assert.doesNotMatch(stack, /This may take 20–30 seconds/);
  assert.match(stack, /aria-describedby="stack-ux-loading-description"/);
  assert.doesNotMatch(stack, /aria-describedby="[^"]*stack-ux-loading-time/);
});
