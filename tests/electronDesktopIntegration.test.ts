import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { isAllowedExternalUrl, resolveDesktopPaths } from "../desktop/electron/runtimePaths.mjs";

test("Electron desktop reuses existing compiled Analyzer API and UI", () => {
  const paths = resolveDesktopPaths("C:/DesktopBundle");
  assert.match(paths.backend.replaceAll("\\", "/"), /app\/dist\/api\/server\.js$/);
  assert.match(paths.frontendIndex.replaceAll("\\", "/"), /app\/web\/dist\/index\.html$/);
  assert.match(paths.node.replaceAll("\\", "/"), /runtime\/node\.exe$/);
});

test("Electron renderer is sandboxed and only local app navigation is accepted", () => {
  const main = readFileSync("desktop/electron/main.mjs", "utf8");
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /return \{ action: "deny" \}/);
  assert.ok(isAllowedExternalUrl("https://github.com/openai"));
  assert.ok(isAllowedExternalUrl("https://help.salesforce.com/article"));
  assert.equal(isAllowedExternalUrl("http://github.com/openai"), false);
  assert.equal(isAllowedExternalUrl("https://github.com.evil.example"), false);
  assert.equal(isAllowedExternalUrl("file:///C:/secrets"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
});

test("Electron stores settings outside packaged resources and never distributes OAuth secrets", () => {
  const main = readFileSync("desktop/electron/main.mjs", "utf8");
  const backend = readFileSync("src/api/server.ts", "utf8");
  const repository = readFileSync("src/services/RepositoryConfigurationService.ts", "utf8");
  const reports = readFileSync("src/services/ReportOutputConfigurationService.ts", "utf8");
  const stage = readFileSync("desktop/electron/stage.mjs", "utf8");
  assert.match(main, /app\.getPath\("userData"\)/);
  assert.match(main, /SALESFORCE_ANALYZER_ENV_PATH: localSettings/);
  assert.match(backend, /SALESFORCE_ANALYZER_ENV_PATH/);
  assert.match(repository, /SALESFORCE_ANALYZER_ENV_PATH/);
  assert.match(reports, /SALESFORCE_ANALYZER_ENV_PATH/);
  assert.match(stage, /Desktop distribution must not contain any user settings or credentials/);
  assert.doesNotMatch(main, /client_credentials|--client-id|--client-secret/);
});

test("Desktop build is isolated from the current Windows browser portable workflow", () => {
  const workflow = readFileSync(".github/workflows/windows-desktop.yml", "utf8");
  const legacy = readFileSync(".github/workflows/windows-portable.yml", "utf8");
  assert.match(workflow, /desktop\/electron\/stage\.mjs/);
  assert.match(workflow, /desktop\/electron\/smoke\.mjs/);
  assert.match(workflow, /build:win/);
  assert.match(workflow, /SalesforceRepositoryAnalyzer-Desktop-Folder-ZIP/);
  assert.match(workflow, /Compress-Archive -LiteralPath \$desktopRoot/);
  assert.match(workflow, /resources\/analyzer\/app\/dist\/api\/server\.js/);
  assert.match(workflow, /resources\/analyzer\/runtime\/node\.exe/);
  assert.match(workflow, /SalesforceRepositoryAnalyzer-Desktop-Portable/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(legacy, /SalesforceRepositoryAnalyzer-Windows-Portable/);
});
