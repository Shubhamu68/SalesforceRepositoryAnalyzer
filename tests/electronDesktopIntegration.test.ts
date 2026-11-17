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

test("desktop displays a startup screen without waiting for the Analyzer API", () => {
  const main = readFileSync("desktop/electron/main.mjs", "utf8");
  const splash = readFileSync("desktop/electron/splash.html", "utf8");
  const pkg = readFileSync("desktop/electron/package.json", "utf8");
  const api = readFileSync("src/api/server.ts", "utf8");
  assert.match(main, /show: true/);
  assert.match(main, /window\.loadFile\(splashFile\)/);
  assert.match(main, /openWindow\(\);\s*const origin = await startBackend\(\)/);
  assert.match(main, /await showWorkspace\(origin\)/);
  assert.match(main, /fetch\(origin \+ "\/api\/health\/live"/);
  assert.match(api, /app\.get\("\/api\/health\/live"/);
  assert.match(splash, /Starting your local workspace/);
  assert.match(splash, /Content-Security-Policy/);
  assert.match(pkg, /"splash\.html"/);
  assert.match(pkg, /"startupTrace\.mjs"/);
});

test("startup log uses only approved fixed event names and durations", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createDesktopStartupTrace } = await import("../desktop/electron/startupTrace.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "analyzer-startup-trace-"));
  try {
    const trace = createDesktopStartupTrace(dir);
    trace.mark("main-loaded");
    trace.mark("backend-spawned");
    trace.mark("backend-ready");
    trace.mark("ui-rendered");
    assert.throws(() => trace.mark("secret-token=BAD"), /Invalid startup timing phase/);
    const lines = readFileSync(trace.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.match(line, /^\d{4}-\d\d-\d\dT[^\s]+ (main-loaded|backend-spawned|backend-ready|ui-rendered) elapsedMs=\d+ processUptimeMs=\d+$/);
      assert.doesNotMatch(line, /password|token=|orgId|example\.com|Bearer/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
