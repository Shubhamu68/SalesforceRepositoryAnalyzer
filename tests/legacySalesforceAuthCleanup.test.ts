import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LEGACY_SALESFORCE_OAUTH_KEYS,
  removeLegacySalesforceOauthEnvironment,
  removeLegacySalesforceOauthSettings,
} from "../src/services/LocalEnvFileService.js";

test("legacy OAuth migration removes active secrets while preserving unrelated CRLF settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-legacy-auth-"));
  const file = path.join(root, ".env");
  const original = [
    "# Salesforce login is configured through Salesforce CLI",
    "# SALESFORCE_CLIENT_ID=this-is-only-a-comment",
    "SALESFORCE_CLIENT_ID=stale-client",
    "export SALESFORCE_CLIENT_SECRET=stale-secret",
    "SALESFORCE_LOGIN_URL=https://test.salesforce.com",
    "SALESFORCE_REPOSITORY_PATH=C:/salesforce repo",
    "SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/reports",
    "SALESFORCE_API_VERSION=v62.0",
    "",
  ].join("\r\n");
  try {
    await writeFile(file, original);
    assert.equal(await removeLegacySalesforceOauthSettings(file), true);
    const after = await readFile(file, "utf8");
    assert.match(after, /# SALESFORCE_CLIENT_ID=this-is-only-a-comment/);
    assert.doesNotMatch(after, /^(?:export\s+)?SALESFORCE_CLIENT_(?:ID|SECRET)=/m);
    assert.doesNotMatch(after, /^SALESFORCE_LOGIN_URL=/m);
    assert.match(after, /SALESFORCE_REPOSITORY_PATH=C:\/salesforce repo\r\n/);
    assert.match(after, /SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:\/reports\r\n/);
    assert.match(after, /SALESFORCE_API_VERSION=v62\.0\r\n/);
    assert.equal(await removeLegacySalesforceOauthSettings(file), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy OAuth migration handles missing files, LF and duplicate entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-legacy-auth-"));
  const file = path.join(root, ".env");
  try {
    assert.equal(await removeLegacySalesforceOauthSettings(file), false);
    await writeFile(file, "SALESFORCE_CLIENT_ID=a\nSALESFORCE_CLIENT_ID=b\nSALESFORCE_API_VERSION=v62.0\n");
    assert.equal(await removeLegacySalesforceOauthSettings(file), true);
    assert.equal(await readFile(file, "utf8"), "SALESFORCE_API_VERSION=v62.0\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy OAuth environment is cleared without affecting CLI or analyzer settings", () => {
  const environment: NodeJS.ProcessEnv = {
    SALESFORCE_CLIENT_ID: "old",
    SALESFORCE_CLIENT_SECRET: "old",
    SALESFORCE_LOGIN_URL: "https://test.salesforce.com",
    SALESFORCE_API_VERSION: "v62.0",
    SALESFORCE_REPOSITORY_PATH: "C:/repo",
    SF_DISABLE_TELEMETRY: "true",
  };
  removeLegacySalesforceOauthEnvironment(environment);
  for (const key of LEGACY_SALESFORCE_OAUTH_KEYS) assert.equal(environment[key], undefined);
  assert.equal(environment.SALESFORCE_API_VERSION, "v62.0");
  assert.equal(environment.SALESFORCE_REPOSITORY_PATH, "C:/repo");
  assert.equal(environment.SF_DISABLE_TELEMETRY, "true");
});
