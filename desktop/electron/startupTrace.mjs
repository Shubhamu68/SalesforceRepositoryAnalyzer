import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MAX_LOG_SIZE = 32 * 1024;
const PHASES = new Set([
  "main-loaded",
  "electron-ready",
  "window-created",
  "splash-rendered",
  "backend-spawned",
  "backend-ready",
  "ui-rendered",
  "startup-failed",
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
