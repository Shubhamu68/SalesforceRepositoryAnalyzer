import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  ReportOutputConfigurationService,
  ReportOutputConfigurationError,
  REPORT_OUTPUT_ENV_KEY,
  cliReportOutputDirectory,
} from "../src/services/ReportOutputConfigurationService.js";
import { createReportOutputRouter } from "../src/api/reportOutputRoutes.js";
import { SoqlAnalysisService } from "../src/services/SoqlAnalysisService.js";
import type { Persona } from "../src/models/Persona.js";
import { chooseWindowsReportFolder, buildWindowsFolderPickerScript, WINDOWS_FOLDER_PICKER_TIMEOUT_MS } from "../src/services/windowsReportFolderPicker.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "analyzer-output-config-"));
  const reports = path.join(root, "Excel Reports #1");
  const second = path.join(root, "alternate-reports");
  await mkdir(reports);
  await mkdir(second);
  const envFile = path.join(root, ".env");
  const environment: NodeJS.ProcessEnv = {};
  return { root, reports, second, envFile, environment,
    clean: () => rm(root, { recursive: true, force: true }) };
}

test("missing configuration is explicitly reported, not silently defaulted", async () => {
  const f = await fixture();
  try {
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.reports, f.environment);
    const status = await config.getStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reason, "MISSING");
    assert.equal(status.directory, null);
    assert.throws(() => config.requireConfiguredDirectory(), /Choose a report output folder/);
  } finally { await f.clean(); }
});

test("first native selection creates .env, saves the entry, and works immediately", async () => {
  const f = await fixture();
  try {
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.reports, f.environment);
    const result = await config.chooseAndSave();
    assert.deepEqual(result, { saved: true, cancelled: false, directory: f.reports });
    assert.equal(f.environment[REPORT_OUTPUT_ENV_KEY], f.reports);
    assert.equal(config.requireConfiguredDirectory(), f.reports);
    assert.equal((await config.getStatus()).configured, true);
    assert.match(await readFile(f.envFile, "utf8"), /SALESFORCE_ANALYZER_OUTPUT_DIRECTORY="/);
    assert.match(await readFile(f.envFile, "utf8"), /Excel Reports #1/);
    assert.equal((await stat(f.envFile)).isFile(), true);
  } finally { await f.clean(); }
});

test("existing .env and credentials are preserved; missing report entry is appended", async () => {
  const f = await fixture();
  try {
    const existing = "# Salesforce config\r\nSALESFORCE_REPOSITORY_PATH=C:/source/repo\r\nSALESFORCE_CLIENT_SECRET=my-secret\r\n";
    await writeFile(f.envFile, existing);
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.reports, f.environment);
    await config.chooseAndSave();
    const updated = await readFile(f.envFile, "utf8");
    assert.ok(updated.startsWith(existing));
    assert.match(updated, /SALESFORCE_CLIENT_SECRET=my-secret/);
    assert.match(updated, /\r\nSALESFORCE_ANALYZER_OUTPUT_DIRECTORY="/);
    assert.equal((updated.match(/SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=/g) ?? []).length, 1);
  } finally { await f.clean(); }
});

test("reselecting replaces an invalid existing entry without duplicates or collateral edits", async () => {
  const f = await fixture();
  try {
    const stale = path.join(f.root, "missing");
    const current = [
      "SALESFORCE_CLIENT_ID=existing-id",
      "# SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=ignore-commented",
      "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=old-folder",
      "export SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=second-old-folder",
      "SALESFORCE_API_VERSION=v62.0",
      "",
    ].join("\n");
    await writeFile(f.envFile, current);
    f.environment[REPORT_OUTPUT_ENV_KEY] = stale;
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.second, f.environment);
    assert.equal((await config.getStatus()).reason, "INVALID_DIRECTORY");
    await config.chooseAndSave();
    const next = await readFile(f.envFile, "utf8");
    assert.match(next, /SALESFORCE_CLIENT_ID=existing-id/);
    assert.match(next, /SALESFORCE_API_VERSION=v62\.0/);
    assert.match(next, /# SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=ignore-commented/);
    const active = next.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?SALESFORCE_ANALYZER_OUTPUT_DIRECTORY\s*=/.test(line));
    assert.equal(active.length, 1);
    assert.equal(config.requireConfiguredDirectory(), f.second);
  } finally { await f.clean(); }
});

test("cancelled native picker leaves .env and live process environment unchanged", async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, "SALESFORCE_CLIENT_SECRET=keep-this\n");
    const config = new ReportOutputConfigurationService(f.envFile, async () => null, f.environment);
    assert.deepEqual(await config.chooseAndSave(), { saved: false, cancelled: true, directory: null });
    assert.equal(await readFile(f.envFile, "utf8"), "SALESFORCE_CLIENT_SECRET=keep-this\n");
    assert.equal(f.environment[REPORT_OUTPUT_ENV_KEY], undefined);
  } finally { await f.clean(); }
});

test("cancelled selection does not create an otherwise missing .env", async () => {
  const f = await fixture();
  try {
    const config = new ReportOutputConfigurationService(f.envFile, async () => null, f.environment);
    await config.chooseAndSave();
    await assert.rejects(readFile(f.envFile, "utf8"), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("nonexistent, file, and relative selection are rejected without changing .env", async () => {
  const f = await fixture();
  try {
    const pathToFile = path.join(f.root, "not-directory.txt");
    await writeFile(pathToFile, "file");
    for (const selected of [path.join(f.root, "missing"), pathToFile, "relative"]) {
      const config = new ReportOutputConfigurationService(f.envFile, async () => selected, f.environment);
      await assert.rejects(config.chooseAndSave(), ReportOutputConfigurationError);
      assert.equal(f.environment[REPORT_OUTPUT_ENV_KEY], undefined);
    }
    await assert.rejects(readFile(f.envFile, "utf8"), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("existing invalid path that points to a file prompts for folder setup", async () => {
  const f = await fixture();
  try {
    const pathToFile = path.join(f.root, "output.txt");
    await writeFile(pathToFile, "data");
    f.environment[REPORT_OUTPUT_ENV_KEY] = pathToFile;
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.reports, f.environment);
    assert.deepEqual((await config.getStatus()).reason, "INVALID_DIRECTORY");
    assert.equal((await config.getStatus()).configured, false);
  } finally { await f.clean(); }
});

test("concurrent folder selection is refused to prevent overlapping .env writes", async () => {
  const f = await fixture();
  try {
    let finish: (value: string | null) => void = () => undefined;
    const picker = () => new Promise<string | null>(resolve => { finish = resolve; });
    const config = new ReportOutputConfigurationService(f.envFile, picker, f.environment);
    const first = config.chooseAndSave();
    await assert.rejects(config.chooseAndSave(), (err: unknown) =>
      err instanceof ReportOutputConfigurationError && err.statusCode === 409);
    finish(null);
    assert.equal((await first).cancelled, true);
  } finally { await f.clean(); }
});

test("CLI remains usable with a portable reports/ fallback", () => {
  const existing = process.env[REPORT_OUTPUT_ENV_KEY];
  try {
    delete process.env[REPORT_OUTPUT_ENV_KEY];
    assert.equal(cliReportOutputDirectory(), path.resolve("reports"));
    process.env[REPORT_OUTPUT_ENV_KEY] = "custom-reports";
    assert.equal(cliReportOutputDirectory(), path.resolve("custom-reports"));
  } finally {
    if (existing === undefined) delete process.env[REPORT_OUTPUT_ENV_KEY];
    else process.env[REPORT_OUTPUT_ENV_KEY] = existing;
  }
});

test("the newly selected folder is used by the actual SOQL report writer without restart", async () => {
  const f = await fixture();
  try {
    const config = new ReportOutputConfigurationService(f.envFile, async () => f.reports, f.environment);
    const service = new SoqlAnalysisService(f.root, {
      analyze: async () => [],
    } as unknown as ConstructorParameters<typeof SoqlAnalysisService>[1],
      () => config.requireConfiguredDirectory());
    await config.chooseAndSave();
    const result = await service.analyze({ name: "OMS View Only" } as Persona);
    assert.ok(result.reports.summaryReportPath.startsWith(f.reports));
    assert.equal((await stat(result.reports.summaryReportPath)).isFile(), true);
    assert.equal((await stat(result.reports.errorReportPath)).isFile(), true);
    assert.equal((await stat(result.reports.otherReportPath)).isFile(), true);
  } finally { await f.clean(); }
});

test("localhost config endpoints persist selection and block nonlocal origins", async () => {
  const f = await fixture();
  let pickerCalls = 0;
  const config = new ReportOutputConfigurationService(f.envFile, async () => {
    pickerCalls++;
    return f.reports;
  }, f.environment);
  const app = express();
  app.use("/api/report-output", createReportOutputRouter(config));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = "http://127.0.0.1:" + port + "/api/report-output";
    const statusResponse = await fetch(base + "/status");
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json() as { configured: boolean }).configured, false);
    const unsafeResponse = await fetch(base + "/choose", {
      method: "POST", headers: { Origin: "https://malicious-site.example" },
    });
    assert.equal(unsafeResponse.status, 403);
    assert.equal(pickerCalls, 0);
    const chosenResponse = await fetch(base + "/choose", {
      method: "POST", headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(chosenResponse.status, 200);
    assert.equal((await chosenResponse.json() as { saved: boolean }).saved, true);
    assert.equal(pickerCalls, 1);
    const configuredResponse = await fetch(base + "/status");
    assert.equal((await configuredResponse.json() as { configured: boolean }).configured, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.clean();
  }
});

test("Windows native dialog fails clearly on non-Windows hosts", { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(chooseWindowsReportFolder(), (error: unknown) =>
      error instanceof ReportOutputConfigurationError && error.statusCode === 501);
  });

test("native folder picker is owned by an invisible topmost window", () => {
  const script = buildWindowsFolderPickerScript();
  assert.match(script, /\$owner = New-Object System\.Windows\.Forms\.Form/);
  assert.match(script, /\$owner\.TopMost = \$true/);
  assert.match(script, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(script, /\$owner\.Opacity = 0/);
  assert.match(script, /\$owner\.Show\(\)/);
  assert.match(script, /\$owner\.Activate\(\)/);
  assert.match(script, /\$dialog\.ShowDialog\(\$owner\)/);
  assert.doesNotMatch(script, /\$dialog\.ShowDialog\(\)/);
});

test("folder picker disposes its owner and dialog, even on cancel", () => {
  const script = buildWindowsFolderPickerScript();
  assert.match(script, /finally \{ \$dialog\.Dispose\(\); \$owner\.Close\(\); \$owner\.Dispose\(\) \}/);
  assert.match(script, /\[System\.Windows\.Forms\.DialogResult\]::OK/);
  assert.equal(WINDOWS_FOLDER_PICKER_TIMEOUT_MS, 600_000);
});

test("folder picker PowerShell source contains no user-controlled data", () => {
  const script = buildWindowsFolderPickerScript();
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /ShowNewFolderButton = \$true/);
  assert.doesNotMatch(script, /SALESFORCE_CLIENT_SECRET|process\.env|req\.body/);
});
