import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { isAllowedExternalUrl, resolveDesktopPaths } from "../desktop/electron/runtimePaths.mjs";

test("React page title matches the Electron desktop application name", () => {
  const html = readFileSync("web/index.html", "utf8");
  const electron = readFileSync("desktop/electron/main.mjs", "utf8");
  assert.match(html, /<title>Salesforce Repository Analyzer<\/title>/);
  assert.match(electron, /title: "Salesforce Repository Analyzer"/);
  assert.doesNotMatch(html, /<title>web<\/title>/);
});

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
  assert.match(workflow, /smoke\.mjs release\/electron-desktop\/win-unpacked\/resources\/analyzer/);
  assert.match(workflow, /Smoke-test backend from final packaged folder/);
  assert.match(workflow, /build:folder/);
  assert.match(workflow, /Build unpacked Windows desktop folder/);
  assert.doesNotMatch(workflow, /Build portable Windows EXE/);
  assert.match(workflow, /SalesforceRepositoryAnalyzer-Desktop-Folder-ZIP/);
  assert.match(workflow, /Compress-Archive -LiteralPath \$desktopRoot/);
  assert.match(workflow, /resources\/analyzer\/app\/dist\/api\/server\.js/);
  assert.match(workflow, /resources\/analyzer\/runtime\/node\.exe/);
  assert.doesNotMatch(workflow, /SalesforceRepositoryAnalyzer-Desktop-Portable/);
  assert.doesNotMatch(workflow, /release\/electron-desktop\/\*\.exe/);
  assert.equal((workflow.match(/actions\/upload-artifact@v4/g) ?? []).length, 1);
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
  assert.match(main, /const splashReady = openWindow\(\);\s*const origin = await startBackend\(\)/);
  assert.match(main, /await splashReady;\s*startupStage = "ui";\s*await showWorkspace\(origin\)/);
  assert.match(main, /startupTrace\.mark\("backend-entered"\)/);
  assert.match(main, /startupTrace\.mark\("resources-verified"\)/);
  assert.match(main, /startupTrace\.mark\("settings-loaded"\)/);
  assert.match(main, /startupTrace\.mark\("port-selected"\)/);
  assert.match(main, /startupTrace\.mark\("splash-load-failed"\)/);
  assert.match(main, /startupTrace\.failure\(startupStage, error\)/);
  assert.match(main, /fetch\(origin \+ "\/api\/health\/live"/);
  assert.match(api, /app\.get\("\/api\/health\/live"/);
  assert.match(splash, /Starting your local workspace/);
  assert.match(splash, /Content-Security-Policy/);
  assert.match(pkg, /"splash\.html"/);
  assert.match(pkg, /"startupTrace\.mjs"/);
  assert.match(pkg, /"backendExitDiagnostics\.mjs"/);
  assert.match(main, /startupTrace\.backendExit\(reason\)/);
  assert.match(main, /backendFailure \|\| backend\.exitCode/);
  assert.doesNotMatch(main, /The local Analyzer service stopped unexpectedly/);
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
    // Failure details can contain sensitive paths/metadata: only explicit
    // error-code allowlist values may reach the diagnostic file.
    trace.failure("resources", { code: "RESOURCE_MISSING", message: "C:/private/secret" });
    trace.failure("settings", { code: "Bearer org-token", message: "private" });
    assert.throws(() => trace.mark("secret-token=BAD"), /Invalid startup timing phase/);
    assert.throws(() => trace.failure("private-stage", new Error("secret")), /Invalid startup failure stage/);
    const lines = readFileSync(trace.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 6);
    for (const line of lines.slice(0, 4)) {
      assert.match(line, /^\d{4}-\d\d-\d\dT[^\s]+ (main-loaded|backend-spawned|backend-ready|ui-rendered) elapsedMs=\d+ processUptimeMs=\d+$/);
    }
    assert.match(lines[4], /startup-error stage=resources code=RESOURCE_MISSING$/);
    assert.match(lines[5], /startup-error stage=settings code=UNKNOWN$/);
    for (const line of lines) {
      assert.doesNotMatch(line, /password|token|orgId|example\.com|Bearer|private/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows desktop uses the blue Analyzer brand icon rather than Electron", () => {
  const pkg = JSON.parse(readFileSync("desktop/electron/package.json", "utf8"));
  const main = readFileSync("desktop/electron/main.mjs", "utf8");
  const appStyles = readFileSync("web/src/App.css", "utf8");
  const icon = readFileSync("desktop/electron/assets/analyzer.ico");
  assert.equal(pkg.scripts["build:folder"], "electron-builder --win --x64 --dir --publish never");
  assert.equal(pkg.scripts["build:win"], undefined);
  assert.equal(pkg.build.win.icon, "assets/analyzer.ico");
  assert.ok(pkg.build.files.includes("assets/analyzer.ico"));
  assert.match(main, /icon: windowIcon/);
  assert.match(main, /app\.setAppUserModelId\("com\.salesforcerepositoryanalyzer\.desktop"\)/);
  assert.match(appStyles, /\.brand-mark\{[^}]*background:#2268eb/);
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const imageCount = icon.readUInt16LE(4);
  assert.ok(imageCount >= 3, "ICO must have multiple image sizes");
  const iconSizes = Array.from({ length: imageCount }, (_, i) => icon.readUInt8(6 + i * 16) || 256);
  assert.ok(iconSizes.includes(256), "Windows builder requires a 256x256 icon image");
  assert.ok(icon.length > 1000);
});

test("Change org button is visible on the dark navy navigation bar", () => {
  const css = readFileSync("web/src/App.css", "utf8");
  const jsx = readFileSync("web/src/App.tsx", "utf8");
  assert.match(jsx, /className="sf-cli-topbar-change"/);
  assert.match(css, /\.sf-cli-topbar-change\{[^}]*background:#eaf2ff/s);
  assert.match(css, /\.sf-cli-topbar-change\{[^}]*color:#163f83/s);
  assert.match(css, /\.sf-cli-topbar-change:focus-visible\{outline:3px solid #80bbff/);
});

test("Backend exit logging distinguishes failure categories without leaking stderr", async () => {
  const { createBackendExitClassifier } = await import("../desktop/electron/backendExitDiagnostics.mjs");
  const moduleError = createBackendExitClassifier();
  moduleError.inspect("node:internal/modules/esm/resolve: Cannot find mod");
  moduleError.inspect("ule '/Users/a/private/Salesforce-secret.js'\nAccessToken=secret123");
  assert.deepEqual(moduleError.result(1, null), { category: "MODULE_NOT_FOUND", exitCode: 1, signal: null });
  const windowsError = createBackendExitClassifier();
  assert.equal(windowsError.result(3221225781, null).category, "DLL_LOAD_FAILED");
  assert.equal(windowsError.result(-1073741515, null).category, "DLL_LOAD_FAILED");
  const permission = createBackendExitClassifier();
  assert.equal(permission.result(null, null, { code: "EPERM", message: "user-secret" }).category, "ACCESS_DENIED");
  const exit = createBackendExitClassifier();
  assert.equal(exit.result(1, null).category, "BACKEND_EXIT");
  assert.equal(exit.result(null, "SIGTERM").category, "BACKEND_SIGNALLED");

  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createDesktopStartupTrace } = await import("../desktop/electron/startupTrace.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "analyzer-backend-exit-"));
  try {
    const trace = createDesktopStartupTrace(dir);
    trace.backendExit({ exitCode: 3221225781, signal: "user-token", category: "DLL_LOAD_FAILED" });
    trace.backendExit({ exitCode: NaN, signal: "SIGTERM", category: "Bearer secret" });
    const entries = readFileSync(trace.file, "utf8");
    assert.match(entries, /backend-exit .*exitCode=3221225781 signal=none category=DLL_LOAD_FAILED/);
    assert.match(entries, /backend-exit .*exitCode=unknown signal=SIGTERM category=UNKNOWN/);
    assert.doesNotMatch(entries, /user-token|secret123|Salesforce-secret|Bearer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
