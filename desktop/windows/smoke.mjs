import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";

const packageRoot = process.argv[2];
assert.ok(packageRoot && path.isAbsolute(packageRoot), "Pass the built portable package directory.");
for (const file of [
  "runtime/node.exe", "app/dist/api/server.js", "app/web/dist/index.html",
  "app/node_modules/express/package.json", "config/personas.json",
  "scripts/launcher.mjs", "Start Analyzer.cmd", ".env.example",
]) {
  assert.ok(existsSync(path.join(packageRoot, file)), "Missing packaged file: " + file);
}
assert.equal(existsSync(path.join(packageRoot, ".env")), false, "Never distribute real credentials in .env");

const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));

const node = path.join(packageRoot, "runtime", "node.exe");
const executable = path.join(packageRoot, "app", "dist", "api", "server.js");
const ui = path.join(packageRoot, "app", "web", "dist");
const child = spawn(node, [executable], {
  cwd: packageRoot,
  windowsHide: true,
  env: {
    ...process.env, SALESFORCE_ANALYZER_PORT: String(port),
    SALESFORCE_ANALYZER_STATIC_DIR: ui,
    SALESFORCE_CLIENT_ID: "", SALESFORCE_CLIENT_SECRET: "",
    SALESFORCE_REPOSITORY_PATH: "", SALESFORCE_ANALYZER_OUTPUT_DIRECTORY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });
const url = "http://127.0.0.1:" + port;
let ready = false;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(800) });
      if (response.ok) { ready = true; break; }
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, "Portable API startup failed: " + output);
  const health = await (await fetch(url + "/api/health")).json();
  assert.equal(health.status, "ok");
  assert.equal(health.repositoryConfigured, false, "First-run repository setup must remain required");
  const repository = await (await fetch(url + "/api/repository/status")).json();
  assert.equal(repository.configured, false);
  assert.equal(repository.reason, "MISSING");
  const reports = await (await fetch(url + "/api/report-output/status")).json();
  assert.equal(reports.configured, false);
  const frontend = await fetch(url);
  assert.equal(frontend.status, 200);
  assert.match(frontend.headers.get("content-type") ?? "", /text\/html/);
  const html = await frontend.text();
  assert.match(html, /id="root"/);
  assert.match(html, /\/assets\//);
  // An API route must not be confused with the static React fallback.
  const unknownApi = await fetch(url + "/api/undefined-route");
  assert.notEqual(unknownApi.headers.get("content-type")?.startsWith("text/html"), true);
  console.log("Portable package smoke test passed: localhost API, setup prompts, React UI and bundled runtime.");
} finally {
  child.kill();
}
