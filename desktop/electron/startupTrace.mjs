import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MAX_LOG_SIZE = 32 * 1024;
const PHASES = new Set([
  "main-loaded",
  "electron-ready",
  "window-created",
  "window-handlers-ready",
  "splash-load-started",
  "splash-load-failed",
  "splash-rendered",
  "backend-entered",
  "resources-verified",
  "settings-ready",
  "settings-loaded",
  "port-selected",
  "backend-spawned",
  "backend-exited",
  "backend-ready",
  "ui-rendered",
  "startup-failed",
]);
const STAGES = new Set(["window", "resources", "settings", "port", "backend", "api", "ui"]);
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EINVAL", "EADDRINUSE", "EADDRNOTAVAIL",
  "RESOURCE_MISSING", "UNKNOWN",
  "MODULE_NOT_FOUND", "PORT_UNAVAILABLE", "ACCESS_DENIED",
  "RESOURCE_NOT_FOUND", "INVALID_CONFIGURATION", "DLL_LOAD_FAILED",
  "JS_SYNTAX_ERROR", "WINDOWS_INITIALIZATION_FAILED", "PROCESS_CRASH",
  "BACKEND_SIGNALLED", "BACKEND_EXIT",
]);

/**
 * Only fixed phase names, durations and timestamps reach this local file.
 * Never log process arguments, paths, environment, Salesforce responses,
 * usernames, org IDs, tokens or backend stdout/stderr.
 */
export function createDesktopStartupTrace(userData) {
  const file = path.join(userData, "startup-timing.log");
  const start = performance.now();
  return {
    file,
    backendExit(result) {
      // Only a numeric process exit code, an allowlisted signal/category,
      // and timing are recorded. No stderr, paths or process arguments.
      const exitCode = Number.isInteger(result?.exitCode) &&
        result.exitCode >= -2147483648 && result.exitCode <= 4294967295
        ? String(result.exitCode) : "unknown";
      const signal = ["SIGTERM", "SIGKILL", "SIGINT", "SIGBREAK"].includes(result?.signal)
        ? result.signal : "none";
      const category = ERROR_CODES.has(result?.category) ? result.category : "UNKNOWN";
      try {
        mkdirSync(userData, { recursive: true });
        if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_SIZE) {
          writeFileSync(file, "", { mode: 0o600 });
        }
        appendFileSync(file,
          `${new Date().toISOString()} backend-exit elapsedMs=${Math.round(performance.now()-start)} processUptimeMs=${Math.round(process.uptime()*1000)} exitCode=${exitCode} signal=${signal} category=${category}\n`,
          { mode: 0o600 });
      } catch { /* Diagnostics must never block launch or shutdown. */ }
    },
    failure(stage, error) {
      if (!STAGES.has(stage)) throw new Error("Invalid startup failure stage.");
      const untrustedCode = typeof error === "object" && error !== null && "code" in error
        ? error.code : null;
      const code = typeof untrustedCode === "string" && ERROR_CODES.has(untrustedCode)
        ? untrustedCode : "UNKNOWN";
      try {
        mkdirSync(userData, { recursive: true });
        if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_SIZE) {
          writeFileSync(file, "", { mode: 0o600 });
        }
        appendFileSync(file,
          `${new Date().toISOString()} startup-error stage=${stage} code=${code}\n`,
          { mode: 0o600 });
      } catch {
        // Startup logging cannot prevent the user from opening the app.
      }
    },
    mark(phase) {
      if (!PHASES.has(phase)) throw new Error("Invalid startup timing phase.");
      const elapsed = Math.max(0, Math.round(performance.now() - start));
      const processAge = Math.max(0, Math.round(process.uptime() * 1000));
      try {
        mkdirSync(userData, { recursive: true });
        if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_SIZE) {
          writeFileSync(file, "", { mode: 0o600 });
        }
        appendFileSync(file,
          `${new Date().toISOString()} ${phase} elapsedMs=${elapsed} processUptimeMs=${processAge}\n`,
          { mode: 0o600 });
      } catch {
        // Diagnostics must never prevent the desktop app from starting.
      }
    },
  };
}
