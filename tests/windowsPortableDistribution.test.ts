import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

test("portable distribution keeps existing setup/API features and excludes bundled secrets", () => {
  const workflow = readFileSync(path.resolve(" .github/workflows/windows-portable.yml".trim()), "utf8");
  const launcher = readFileSync(path.resolve("desktop/windows/launcher.mjs"), "utf8");
  const script = readFileSync(path.resolve("desktop/windows/Start Analyzer.cmd"), "utf8");
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /npm ci --omit=dev/);
  assert.match(workflow, /Packag(?:ing|e) must NEVER include/);
  assert.match(workflow, /desktop\/windows\/smoke\.mjs/);
  assert.match(workflow, /"config\/personas\.json","config\/org-verification-status-policy\.json"/);
  assert.doesNotMatch(workflow, /Copy-Item -Path "config" -Destination/);
  const desktopStage = readFileSync(path.resolve("desktop/electron/stage.mjs"), "utf8");
  assert.match(desktopStage, /for \(const file of \["personas\.json", "org-verification-status-policy\.json"\]\)/);
  assert.doesNotMatch(desktopStage, /cpSync\(path\.join\(repo, "config"\),/);
  assert.match(launcher, /\.env\.example/);
  assert.match(launcher, /SALESFORCE_ANALYZER_STATIC_DIR/);
  assert.match(launcher, /SALESFORCE_ANALYZER_PORT/);
  assert.match(script, /runtime\\node\.exe/);
  assert.ok(existsSync(path.resolve("desktop/windows/README.txt")));
});
