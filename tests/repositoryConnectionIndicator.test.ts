import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { repositoryConnectionIndicator } from "../web/src/utils/repositoryConnectionIndicator.js";

test("API connected is not sufficient evidence of Salesforce repository access", () => {
  assert.deepEqual(repositoryConnectionIndicator(true, true, false), {
    connected: false,
    label: "Repository not configured",
  });
});

test("verified repository status is displayed independently of Salesforce org credentials", () => {
  assert.deepEqual(repositoryConnectionIndicator(true, true, true), {
    connected: true,
    label: "Repository connected",
  });
});

test("API unavailable never displays a positive repository indicator", () => {
  assert.deepEqual(repositoryConnectionIndicator(false, true, true), {
    connected: false,
    label: "Repository unavailable",
  });
});

test("initial repository check does not falsely show connected", () => {
  assert.deepEqual(repositoryConnectionIndicator(true, false, false), {
    connected: false,
    label: "Repository checking…",
  });
});

test("repository status is rendered in the header, not from API health in sidebar", async () => {
  const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /repositoryConnectionIndicator\(apiConnected, repoChecked, repoReady\)/);
  assert.doesNotMatch(app, /side-info-title">Repository<\/div>/);
  assert.doesNotMatch(app, /apiConnected \? "● Connected"/);
  assert.doesNotMatch(app, /setRepositoryName\(data\.repositoryName \|\| "Configured repository"\)/);
});
