import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The same test runs twice in Windows CI: once against staging, then against
// resources/analyzer inside the actual packaged win-unpacked distribution.
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "staging");
for (const name of ["runtime/node.exe", "app/dist/api/server.js", "app/web/dist/index.html",
  "app/node_modules/express/package.json", "config/personas.json", ".env.example"]) {
  assert.ok(existsSync(path.join(root, name)), "Missing desktop staged file: " + name);
}
assert.equal(existsSync(path.join(root, ".env")), false, "Desktop bundle must not include settings");

const userSettings = mkdtempSync(path.join(os.tmpdir(), "sf-analyzer-desktop-test-"));
const envFile = path.join(userSettings, ".env");
cpSync(path.join(root, ".env.example"), envFile);
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));

const child = spawn(path.join(root, "runtime", "node.exe"),
  [path.join(root, "app", "dist", "api", "server.js")], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env,
      SALESFORCE_ANALYZER_ENV_PATH: envFile,
      SALESFORCE_ANALYZER_PORT: String(port),
      SALESFORCE_ANALYZER_STATIC_DIR: path.join(root, "app", "web", "dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });

const origin = "http://127.0.0.1:" + port;
let ready = false;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(800) });
      if (response.ok) { ready = true; break; }
    } catch { /* API booting */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, "Desktop API startup failed: " + output);
  const live = await (await fetch(origin + "/api/health/live")).json();
  assert.deepEqual(live, { status: "ok" }, "Startup liveness must not require repository setup");
  const health = await (await fetch(origin + "/api/health")).json();
  assert.equal(health.status, "ok");
  assert.equal(health.repositoryConfigured, false);
  const repo = await (await fetch(origin + "/api/repository/status")).json();
  assert.equal(repo.reason, "MISSING");
  const sf = await (await fetch(origin + "/api/salesforce/status")).json();
  assert.equal(sf.authMode, "salesforce_cli");
  assert.equal(sf.connected, false);
  const frontend = await fetch(origin);
  assert.equal(frontend.status, 200);
  assert.match(await frontend.text(), /id="root"/);
  assert.equal(existsSync(path.join(root, ".env")), false,
    "Desktop settings must remain outside the app resources.");
  assert.ok(readFileSync(envFile, "utf8").includes("SALESFORCE_API_VERSION"));
  console.log("Electron desktop resources smoke test passed.");
} finally {
  child.kill();
  rmSync(userSettings, { recursive: true, force: true });
}
