import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import {withApexPerformance} from "../core/apex/ApexPerformance.js";

/**
 * Opt-in, request-scoped SOQL diagnostics. Never print SOQL text, metadata
 * names, repository paths, usernames, org IDs, URLs, tokens, or query results.
 *
 * Enable with SALESFORCE_SOQL_PERF=1 on the backend. All counters are
 * isolated per analysis even when different personas run concurrently.
 */
type SoqlPerfScope = {
  timings: Map<string, number>;
  counts: Map<string, number>;
  errors: number;
};
const scope = new AsyncLocalStorage<SoqlPerfScope>();
const enabled = () => process.env.SALESFORCE_SOQL_PERF === "1";
const elapsedMs = (started: number) => Math.max(0, Math.round(performance.now() - started));

function addTime(context: SoqlPerfScope, phase: string, ms: number): void {
  context.timings.set(phase, (context.timings.get(phase) ?? 0) + ms);
}

export function recordSoqlCount(name: string, count = 1): void {
  const context = scope.getStore();
  if (!context) return;
  context.counts.set(name, (context.counts.get(name) ?? 0) + count);
}

export async function timeSoqlPhase<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const context = scope.getStore();
  if (!context) return work();
  const started = performance.now();
  try { return await work(); }
  finally { addTime(context, name, elapsedMs(started)); }
}

export function timeSoqlSync<T>(name: string, work: () => T): T {
  const context = scope.getStore();
  if (!context) return work();
  const started = performance.now();
  try { return work(); }
  finally { addTime(context, name, elapsedMs(started)); }
}

// Salesforce query category is determined from a fixed allowlist of table
// names. The original SOQL string and WHERE filters are never logged.
function categoryOf(soql: string): string {
  const table = /\bFROM\s+(UserEntityAccess|UserFieldAccess|EntityParticle|Profile|PermissionSetGroup|PermissionSetAssignment|PermissionSet|User)\b/i.exec(soql)?.[1]?.toLowerCase();
  if (table === "userentityaccess" || table === "userfieldaccess") return "org.access";
  if (table === "entityparticle") return "org.field_metadata";
  if (table) return "org.persona_inventory";
  return "org.other";
}

/** One invocation of queryAll, which can internally fetch multiple pages. */
export async function timeSoqlOrgQuery<T>(soql: string, work: () => Promise<T>): Promise<T> {
  const context = scope.getStore();
  if (!context) return work();
  const category = categoryOf(soql);
  const started = performance.now();
  recordSoqlCount("org.queryAll.calls");
  recordSoqlCount(category + ".calls");
  try { return await work(); }
  catch (error) {
    recordSoqlCount("org.queryAll.failures");
    recordSoqlCount(category+".failures");
    // Only fixed diagnostic categories and numeric HTTP status; never log
    // exception messages, query text, org identity or Salesforce payloads.
    const status=(error as {statusCode?:unknown}|null)?.statusCode;
    const type=typeof status==="number"&&Number.isInteger(status)&&status>=400&&status<=599
      ?"http_"+status:"transport_or_other";
    recordSoqlCount("org.queryAll.failure."+type);
    recordSoqlCount(category+".failure."+type);
    throw error;
  } finally {
    const ms = elapsedMs(started);
    addTime(context, "org.queryAll.cumulative_ms", ms);
    addTime(context, category + ".cumulative_ms", ms);
    const max = context.timings.get("org.queryAll.max_ms") ?? 0;
    if (ms > max) context.timings.set("org.queryAll.max_ms", ms);
  }
}

export async function withSoqlPerformance<T>(work: () => Promise<T>): Promise<T> {
  // Join an existing API-level scope rather than generating two reports for
  // the same request (one for preflight and another for analysis).
  if (!enabled() || scope.getStore()) return work();
  const context: SoqlPerfScope = { timings: new Map(), counts: new Map(), errors: 0 };
  return scope.run(context, async () => {
    const started = performance.now();
    let ok = false;
    try {
      const result = await withApexPerformance({count:(name,count)=>recordSoqlCount("apex."+name,count),duration:(name,ms)=>addTime(context,"apex."+name,ms)},work);
      ok = true;
      return result;
    } finally {
      // Cumulative Salesforce query time includes overlapping requests. It is
      // not another sequential phase to add onto the end-to-end wall clock.
      console.info(`[SOQL Perf] total: ${elapsedMs(started)} ms (${ok ? "ok" : "failed"})`);
      for (const [name, ms] of context.timings) {
        console.info(`[SOQL Perf] ${name}: ${Math.round(ms)} ms`);
      }
      for (const [name, value] of context.counts) {
        console.info(`[SOQL Perf] ${name}: ${value}`);
      }
    }
  });
}
