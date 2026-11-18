import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const destination = path.join(here, "staging");
const app = path.join(destination, "app");

for (const relative of ["dist/api/server.js", "web/dist/index.html", "config/personas.json",
  ".env.example", "package-lock.json"]) {
  if (!existsSync(path.join(repo, relative))) throw new Error("Build prerequisite missing: " + relative);
}
if (process.platform !== "win32") throw new Error("The desktop packaging script requires Windows.");

rmSync(destination, { recursive: true, force: true });
for (const folder of ["runtime", "app", "app/web"]) {
  mkdirSync(path.join(destination, folder), { recursive: true });
}
cpSync(path.join(repo, "dist"), path.join(app, "dist"), { recursive: true });
cpSync(path.join(repo, "web/dist"), path.join(app, "web/dist"), { recursive: true });
cpSync(path.join(repo, "config"), path.join(destination, "config"), { recursive: true });
for (const file of [".env.example"]) cpSync(path.join(repo, file), path.join(destination, file));
for (const file of ["package.json", "package-lock.json"]) cpSync(path.join(repo, file), path.join(app, file));
cpSync(process.execPath, path.join(destination, "runtime", "node.exe"));

const install = spawnSync("npm.cmd", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: app,
  stdio: "inherit",
  shell: true,
});
if (install.error || install.status !== 0) {
  throw new Error("Could not install production Analyzer dependencies.");
}
if (existsSync(path.join(destination, ".env"))) {
  throw new Error("Desktop distribution must not contain any user settings or credentials.");
}
console.log("Desktop staging prepared. Local settings will be created in Electron userData.");
