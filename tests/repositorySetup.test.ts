import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateSalesforceRepository, RepositorySetupError } from "../src/services/SalesforceRepositoryValidator.js";
import { RepositoryConfigurationService, REPOSITORY_ENV_KEY } from "../src/services/RepositoryConfigurationService.js";
import { saveLocalEnvEntry } from "../src/services/LocalEnvFileService.js";
import { createRepositoryRouter } from "../src/api/repositoryRoutes.js";
import express from "express";
import type { AddressInfo } from "node:net";

const required = ["classes", "objects", "permissionsets", "permissionsetgroups", "mutingpermissionsets"];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-repo-setup-"));
  const valid = path.join(root, "salesforce source");
  const defaultPath = path.join(valid, "force-app", "main", "default");
  for (const folder of required) await mkdir(path.join(defaultPath, folder), { recursive: true });
  await writeFile(path.join(defaultPath, "classes", "SomeClass.cls"), "public class SomeClass {}", "utf8");
  const envFile = path.join(root, ".env");
  const environment: NodeJS.ProcessEnv = {};
  return { root, valid, defaultPath, envFile, environment,
    clean: () => rm(root, { recursive: true, force: true }) };
}

test("valid Salesforce repo with core metadata and without optional flows is accepted", async () => {
  const f = await fixture();
  try {
    const paths = await validateSalesforceRepository(f.valid);
    // Windows may create the fixture through an 8.3 short path while
    // fs.realpath() returns the same directory via its canonical long path.
    assert.equal(paths.defaultPath, await realpath(f.defaultPath));
    assert.equal(paths.repositoryPath, await realpath(f.valid));
  } finally { await f.clean(); }
});

test("wrong folder with no Salesforce DX metadata is rejected explicitly", async () => {
  const f = await fixture();
  try {
    await assert.rejects(validateSalesforceRepository(f.root),
      (error: unknown) => error instanceof RepositorySetupError &&
        error.message.includes("classes") && error.message.includes("permissionsets"));
  } finally { await f.clean(); }
});

test("required folder deleted from repo blocks all subsequent validation", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.defaultPath, "permissionsetgroups"), { recursive: true });
    await assert.rejects(validateSalesforceRepository(f.valid), /Missing: permissionsetgroups/);
  } finally { await f.clean(); }
});

test("repository root cannot be force-app/main/default or the Analyzer project itself", async () => {
  const f = await fixture();
  try {
    await assert.rejects(validateSalesforceRepository(f.defaultPath), /Select the repository root/);
  } finally { await f.clean(); }
});

test("empty Apex classes directory is considered invalid", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.defaultPath, "classes", "SomeClass.cls"));
    await assert.rejects(validateSalesforceRepository(f.valid), /no Apex .cls files/);
  } finally { await f.clean(); }
});

test("missing repository path reports unconfigured without crashing app startup", async () => {
  const f = await fixture();
  try {
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    const status = await config.status();
    assert.equal(status.reason, "MISSING");
    assert.equal(status.configured, false);
    await assert.rejects(config.resolvePaths(), (error: unknown) =>
      error instanceof RepositorySetupError && error.statusCode === 409);
  } finally { await f.clean(); }
});

test("first selection creates .env and immediately exposes repository paths", async () => {
  const f = await fixture();
  try {
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    const canonicalDirectory = await realpath(f.valid);
    assert.deepEqual(await config.chooseAndSave(),
      { saved: true, cancelled: false, directory: canonicalDirectory, repositoryName: path.basename(canonicalDirectory) });
    assert.equal(f.environment[REPOSITORY_ENV_KEY], canonicalDirectory);
    assert.equal((await config.resolvePaths()).defaultPath, await realpath(f.defaultPath));
    assert.equal((await config.status()).configured, true);
    assert.match(await readFile(f.envFile, "utf8"), /SALESFORCE_REPOSITORY_PATH="/);
  } finally { await f.clean(); }
});

test("existing .env preserves Salesforce credentials, output config, comments and CRLF", async () => {
  const f = await fixture();
  try {
    const original = "# Existing settings\r\nSALESFORCE_CLIENT_SECRET=secret-not-for-output\r\nSALESFORCE_ANALYZER_OUTPUT_DIRECTORY=reports\r\n";
    await writeFile(f.envFile, original);
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    await config.chooseAndSave();
    const after = await readFile(f.envFile, "utf8");
    assert.ok(after.startsWith(original));
    assert.match(after, /SALESFORCE_CLIENT_SECRET=secret-not-for-output/);
    assert.match(after, /SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=reports/);
    assert.match(after, /\r\nSALESFORCE_REPOSITORY_PATH="/);
  } finally { await f.clean(); }
});

test("invalid selected folder does not overwrite existing repository path or .env", async () => {
  const f = await fixture();
  try {
    const original = "SALESFORCE_REPOSITORY_PATH=original\r\nSALESFORCE_CLIENT_ID=abc\r\n";
    await writeFile(f.envFile, original);
    f.environment[REPOSITORY_ENV_KEY] = f.valid;
    const config = new RepositoryConfigurationService(f.envFile, async () => f.root, f.environment);
    await assert.rejects(config.chooseAndSave(), /Invalid Salesforce repository/);
    assert.equal(await readFile(f.envFile, "utf8"), original);
    assert.equal(f.environment[REPOSITORY_ENV_KEY], f.valid);
  } finally { await f.clean(); }
});

test("cancel folder picker never creates or changes .env", async () => {
  const f = await fixture();
  try {
    const config = new RepositoryConfigurationService(f.envFile, async () => null, f.environment);
    assert.deepEqual(await config.chooseAndSave(),
      { saved: false, cancelled: true, directory: null, repositoryName: null });
    await assert.rejects(readFile(f.envFile, "utf8"), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("reselection replaces duplicate active entries but retains comments", async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, [
      "# SALESFORCE_REPOSITORY_PATH=comment",
      "SALESFORCE_REPOSITORY_PATH=broken",
      "export SALESFORCE_REPOSITORY_PATH=another",
      "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/reports",
      "",
    ].join("\n"));
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    await config.chooseAndSave();
    const content = await readFile(f.envFile, "utf8");
    assert.equal(content.split("\n").filter(x => /^(?:export )?SALESFORCE_REPOSITORY_PATH=/.test(x)).length, 1);
    assert.match(content, /# SALESFORCE_REPOSITORY_PATH=comment/);
    assert.match(content, /SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:\/reports/);
  } finally { await f.clean(); }
});

test("externally removed required directory invalidates previously configured path", async () => {
  const f = await fixture();
  try {
    f.environment[REPOSITORY_ENV_KEY] = f.valid;
    await writeFile(f.envFile, REPOSITORY_ENV_KEY + "=" + JSON.stringify(f.valid.replaceAll("\\", "/")) + "\n");
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    assert.equal((await config.status()).configured, true);
    await rm(path.join(f.defaultPath, "classes"), { recursive: true });
    assert.equal((await config.status()).reason, "INVALID_REPOSITORY");
    await assert.rejects(config.resolvePaths(), /Required|Invalid/);
  } finally { await f.clean(); }
});

test("simultaneous native folder selection is rejected without double writes", async () => {
  const f = await fixture();
  try {
    let release: (value: string | null) => void = () => undefined;
    const picker = () => new Promise<string | null>(resolve => { release = resolve; });
    const config = new RepositoryConfigurationService(f.envFile, picker, f.environment);
    const first = config.chooseAndSave();
    await assert.rejects(config.chooseAndSave(), /already open/);
    release(null);
    assert.equal((await first).cancelled, true);
  } finally { await f.clean(); }
});

test("shared .env writer safely updates the output and repository settings independently", async () => {
  const f = await fixture();
  try {
    await saveLocalEnvEntry(f.envFile, "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY", path.join(f.root, "out"));
    await saveLocalEnvEntry(f.envFile, REPOSITORY_ENV_KEY, f.valid);
    const content = await readFile(f.envFile, "utf8");
    assert.match(content, /SALESFORCE_REPOSITORY_PATH=/);
    assert.match(content, /SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=/);
  } finally { await f.clean(); }
});

test("local configuration router enforces origins and persists only validated native picker path", async () => {
  const f = await fixture();
  let called = 0, invalidated = 0;
  const config = new RepositoryConfigurationService(f.envFile, async () => { called++; return f.valid; }, f.environment);
  const app = express();
  app.use("/api/repository", createRepositoryRouter(config, () => { invalidated++; }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/repository";
    const first = await fetch(base + "/status");
    assert.equal((await first.json() as { configured: boolean }).configured, false);
    const bad = await fetch(base + "/choose", { method: "POST",
      headers: { Origin: "https://other-domain.example" } });
    assert.equal(bad.status, 403); assert.equal(called, 0);
    const good = await fetch(base + "/choose", { method: "POST",
      headers: { Origin: "http://localhost:5173" } });
    assert.equal(good.status, 200); assert.equal(called, 1); assert.equal(invalidated, 1);
    const next = await fetch(base + "/status");
    assert.equal((await next.json() as { configured: boolean }).configured, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.clean();
  }
});

test("deleting .env after prior configuration requires setup even if inherited process env remains set", async () => {
  const f = await fixture();
  try {
    const inheritedEnvironment: NodeJS.ProcessEnv = { [REPOSITORY_ENV_KEY]: f.valid };
    await writeFile(f.envFile, REPOSITORY_ENV_KEY + "=" + JSON.stringify(f.valid.replaceAll("\\", "/")) + "\n");
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, inheritedEnvironment);
    assert.equal((await config.status()).configured, true);
    await rm(f.envFile);
    const status = await config.status();
    assert.equal(status.configured, false);
    assert.equal(status.reason, "MISSING");
    assert.equal(status.directory, null);
    assert.equal(inheritedEnvironment[REPOSITORY_ENV_KEY], f.valid);
    await assert.rejects(config.resolvePaths(), (error: unknown) =>
      error instanceof RepositorySetupError && error.statusCode === 409);
  } finally { await f.clean(); }
});

test("existing .env without a repository key requires setup despite valid parent shell environment", async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/reports\n");
    const inheritedEnvironment: NodeJS.ProcessEnv = { [REPOSITORY_ENV_KEY]: f.valid };
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, inheritedEnvironment);
    assert.equal((await config.status()).reason, "MISSING");
    assert.equal((await config.status()).configured, false);
  } finally { await f.clean(); }
});

test("local .env repository selection takes precedence over stale inherited environment value", async () => {
  const f = await fixture();
  try {
    const inheritedEnvironment: NodeJS.ProcessEnv = { [REPOSITORY_ENV_KEY]: path.join(f.root, "old-repo") };
    await writeFile(f.envFile, REPOSITORY_ENV_KEY + "=" + JSON.stringify(f.valid.replaceAll("\\", "/")) + "\n");
    const config = new RepositoryConfigurationService(f.envFile, async () => f.valid, inheritedEnvironment);
    assert.equal((await config.status()).configured, true);
    assert.equal((await config.resolvePaths()).repositoryPath, await realpath(f.valid));
  } finally { await f.clean(); }
});

test("HTTP repository status is not connected when .env absent but shell variable is set", async () => {
  const f = await fixture();
  const config = new RepositoryConfigurationService(
    f.envFile, async () => f.valid, { [REPOSITORY_ENV_KEY]: f.valid },
  );
  const app = express();
  app.use("/api/repository", createRepositoryRouter(config));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch("http://127.0.0.1:" + port + "/api/repository/status");
    assert.equal(response.status, 200);
    const body: { configured: boolean; reason: string; repositoryName: string | null } = await response.json();
    assert.equal(body.configured, false);
    assert.equal(body.reason, "MISSING");
    assert.equal(body.repositoryName, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.clean();
  }
});

test("stored repository path stays canonical across repeated validations", async () => {
  const f = await fixture();
  try {
    const configuration = new RepositoryConfigurationService(f.envFile, async () => f.valid, f.environment);
    const selected = await configuration.chooseAndSave();
    const expected = await realpath(f.valid);
    assert.equal(selected.directory, expected);
    assert.equal((await configuration.status()).directory, expected);
    assert.equal((await configuration.resolvePaths()).repositoryPath, expected);
    // Path identity is canonical even when the configured picker gave the
    // shorter OS-provided alias (common in Windows temp directories).
    assert.equal((await validateSalesforceRepository(f.valid)).repositoryPath, expected);
  } finally { await f.clean(); }
});
