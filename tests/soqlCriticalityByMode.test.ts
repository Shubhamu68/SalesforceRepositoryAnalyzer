import assert from "node:assert/strict";
import { test } from "node:test";
import { findingOutcome } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { resolveSoqlExecutionMode } from "../src/analyzer/soqlExecutionMode.js";

function graded(mode: "USER_MODE" | "SYSTEM_MODE" | "SECURITY_ENFORCED" | "UNSPECIFIED", version: number | undefined,
  evidence: "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED") {
  return findingOutcome(evidence, resolveSoqlExecutionMode(mode, version));
}

test("denied + explicit USER_MODE is High/Error", () => {
  assert.deepEqual(graded("USER_MODE", 62, "ORG_DENIED"),
    { severity: "ERROR", criticality: "High", verificationSource: "ORG_DENIED" });
});
test("denied + explicit SECURITY_ENFORCED on API 62 is High/Error", () => {
  assert.equal(graded("SECURITY_ENFORCED", 62, "ORG_DENIED").criticality, "High");
});
test("denied + implicit SYSTEM_MODE on API 62 is Low/Info", () => {
  assert.deepEqual(graded("UNSPECIFIED", 62, "ORG_DENIED"),
    { severity: "INFO", criticality: "Low", verificationSource: "ORG_DENIED" });
});
test("denied + explicit SYSTEM_MODE even on API 67 is Low/Info", () => {
  assert.equal(graded("SYSTEM_MODE", 67, "ORG_DENIED").criticality, "Low");
});
test("denied + implicit USER_MODE on API 67 is High/Error", () => {
  assert.equal(graded("UNSPECIFIED", 67, "ORG_DENIED").criticality, "High");
});
test("verified access is always Low, even for enforced queries", () => {
  assert.equal(graded("USER_MODE", 62, "ORG_VERIFIED").criticality, "Low");
  assert.equal(graded("UNSPECIFIED", 62, "ORG_VERIFIED").criticality, "Low");
});
test("no org verdict never becomes High nor a verified Low", () => {
  for (const mode of ["USER_MODE", "SYSTEM_MODE", "SECURITY_ENFORCED", "UNSPECIFIED"] as const) {
    assert.equal(graded(mode, 62, "UNVERIFIED").criticality, "Unable to verify");
  }
});
test("missing API version keeps denied access advisory rather than an invented High", () => {
  assert.equal(graded("UNSPECIFIED", undefined, "ORG_DENIED").criticality, "Low");
});
test("unsupported SECURITY_ENFORCED at API 67 is separately flagged, not FLS High", () => {
  assert.equal(graded("SECURITY_ENFORCED", 67, "ORG_DENIED").criticality, "Low");
});
