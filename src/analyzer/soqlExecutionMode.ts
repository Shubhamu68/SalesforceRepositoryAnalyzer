import { defaultApexDatabaseAccessMode } from "../core/apex/ApexDatabaseAccessMode.js";

/**
 * Version-aware execution-mode model shared by SOQL Security Analysis and Stack Trace.
 *
 * Salesforce Apex API 67.0+ defaults database operations to USER_MODE; <=66.0
 * defaults to SYSTEM_MODE. Explicit WITH clauses override the default.
 * WITH SECURITY_ENFORCED is only supported through API 66.0 and checks selected
 * object/field access, not WHERE-only FLS.
 */
export type DeclaredSoqlMode = "USER_MODE" | "SYSTEM_MODE" | "SECURITY_ENFORCED" | "UNSPECIFIED";
export type EffectiveSoqlMode = "USER_MODE" | "SYSTEM_MODE" | "SECURITY_ENFORCED" | "UNKNOWN" | "INVALID_CLAUSE";
export type QueryEnforcement = "FULL" | "SELECT_ONLY" | "NONE" | "UNKNOWN" | "INVALID";
export type SoqlRuntimeImpact =
  | "Potential access failure"
  | "Access confirmed"
  | "Not enforced by query"
  | "Undetermined"
  | "Unsupported query clause"
  | "Not assessed";

export interface SoqlExecutionMode {
  declaredMode: DeclaredSoqlMode;
  effectiveMode: EffectiveSoqlMode;
  enforcement: QueryEnforcement;
  apiVersion?: number;
  description: string;
}

/** Replace SOQL string literals and comments with spaces before looking for WITH clauses. */
export function maskSoqlStringsAndComments(query: string): string {
  let output = "";
  let state: "NORMAL" | "STRING" | "LINE" | "BLOCK" = "NORMAL";
  for (let i = 0; i < query.length; i++) {
    const current = query[i];
    const next = query[i + 1];
    if (state === "STRING") {
      if (current === "\\" && next !== undefined) { output += "  "; i++; continue; }
      if (current === "'" && next === "'") { output += "  "; i++; continue; }
      if (current === "'") { state = "NORMAL"; }
      output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "LINE") {
      if (current === "\n") { state = "NORMAL"; output += "\n"; }
      else output += " ";
      continue;
    }
    if (state === "BLOCK") {
      if (current === "*" && next === "/") { output += "  "; i++; state = "NORMAL"; }
      else output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (current === "'") { state = "STRING"; output += " "; continue; }
    if (current === "-" && next === "-") { state = "LINE"; output += "  "; i++; continue; }
    if (current === "/" && next === "/") { state = "LINE"; output += "  "; i++; continue; }
    if (current === "/" && next === "*") { state = "BLOCK"; output += "  "; i++; continue; }
    output += current;
  }
  return output;
}

/** Explicit mode only; never infer USER_MODE from the absence of a clause. */
export function classifySoqlMode(query: string): DeclaredSoqlMode {
  const cleaned = maskSoqlStringsAndComments(query);
  if (/\bWITH\s+USER_MODE\b/i.test(cleaned)) return "USER_MODE";
  if (/\bWITH\s+SYSTEM_MODE\b/i.test(cleaned)) return "SYSTEM_MODE";
  if (/\bWITH\s+SECURITY_ENFORCED\b/i.test(cleaned)) return "SECURITY_ENFORCED";
  return "UNSPECIFIED";
}

export function resolveSoqlExecutionMode(declaredMode: DeclaredSoqlMode, apiVersion?: number): SoqlExecutionMode {
  const version = apiVersion !== undefined && Number.isFinite(apiVersion) && apiVersion > 0 ? apiVersion : undefined;
  const base = { declaredMode, ...(version === undefined ? {} : { apiVersion: version }) };
  if (declaredMode === "USER_MODE") return {
    ...base, effectiveMode: "USER_MODE", enforcement: "FULL",
    description: "WITH USER_MODE checks object and field Read permissions.",
  };
  if (declaredMode === "SYSTEM_MODE") return {
    ...base, effectiveMode: "SYSTEM_MODE", enforcement: "NONE",
    description: "WITH SYSTEM_MODE does not check the running user's object or field Read permissions.",
  };
  if (declaredMode === "SECURITY_ENFORCED") {
    if (version !== undefined && version >= 67) return {
      ...base, effectiveMode: "INVALID_CLAUSE", enforcement: "INVALID",
      description: "WITH SECURITY_ENFORCED is unsupported in Apex API 67.0 and later; replace it with WITH USER_MODE.",
    };
    if (version === undefined) return {
      ...base, effectiveMode: "UNKNOWN", enforcement: "UNKNOWN",
      description: "Cannot confirm WITH SECURITY_ENFORCED behavior without the Apex API version.",
    };
    return {
      ...base, effectiveMode: "SECURITY_ENFORCED", enforcement: "SELECT_ONLY",
      description: "WITH SECURITY_ENFORCED checks selected object/field Read access, but not fields used only in WHERE.",
    };
  }
  if (version === undefined) return {
    ...base, effectiveMode: "UNKNOWN", enforcement: "UNKNOWN",
    description: "No query mode or Apex API version was found. Permission enforcement is unknown.",
  };
  return defaultApexDatabaseAccessMode(version) === "USER_MODE" ? {
    ...base, effectiveMode: "USER_MODE", enforcement: "FULL",
    description: `Apex API ${version.toFixed(1)} defaults database queries to user mode.`,
  } : {
    ...base, effectiveMode: "SYSTEM_MODE", enforcement: "NONE",
    description: `Apex API ${version.toFixed(1)} defaults database queries to system mode.`,
  };
}

/** Keep object/field access evidence separate from whether an operation enforces it. */
export function runtimeImpactForFinding(
  execution: SoqlExecutionMode,
  access: "DENIED" | "VERIFIED" | "UNVERIFIED",
): SoqlRuntimeImpact {
  if (execution.enforcement === "INVALID") return "Unsupported query clause";
  if (execution.enforcement === "NONE") return "Not enforced by query";
  if (execution.enforcement === "UNKNOWN") return "Undetermined";
  if (access === "VERIFIED") return "Access confirmed";
  return access === "DENIED" ? "Potential access failure" : "Undetermined";
}
