import { performance } from "node:perf_hooks";

/**
 * Explicit, opt-in latency diagnostics. Never log usernames, org IDs, URLs,
 * command arguments, access tokens, CLI stdout/stderr or Salesforce responses.
 *
 * Enable locally with SALESFORCE_AUTH_TIMING=1 before starting the API.
 */
export type AuthTimingPhase =
  | "cli.version"
  | "cli.savedOrgs"
  | "cli.savedOrgsFallback"
  | "cli.browserLogin"
  | "cli.accessToken"
  | "cli.orgDisplay"
  | "auth.browserLogin"
  | "auth.activateOrg"
  | "auth.totalLogin"
  | "auth.session"
  | "auth.userInfo"
  | "auth.selectOrg";

export function authTimingEnabled(): boolean {
  return process.env.SALESFORCE_AUTH_TIMING === "1";
}

export function cliAuthPhase(args: readonly string[]): AuthTimingPhase {
  if (args[0] === "--version") return "cli.version";
  if (args[0] === "org" && args[1] === "login") return "cli.browserLogin";
  if (args[0] === "org" && args[1] === "auth") return "cli.accessToken";
  if (args[0] === "org" && args[1] === "display") return "cli.orgDisplay";
  if (args[0] === "org" && args[1] === "list" && args[2] === "auth") {
    return "cli.savedOrgsFallback";
  }
  return "cli.savedOrgs";
}

/** Keeps timing output strictly limited to fixed phase labels and durations. */
export async function timedAuthStep<T>(
  phase: AuthTimingPhase,
  task: () => Promise<T>,
): Promise<T> {
  if (!authTimingEnabled()) return task();
  const started = performance.now();
  let success = false;
  try {
    const result = await task();
    success = true;
    return result;
  } finally {
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    console.info(`[SF Auth Timing] ${phase}: ${durationMs} ms (${success ? "ok" : "failed"})`);
  }
}
