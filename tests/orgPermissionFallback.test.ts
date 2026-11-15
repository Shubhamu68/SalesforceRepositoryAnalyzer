import assert from "node:assert/strict";
import { test } from "node:test";
import { OrgPermissionFallbackService } from "../src/services/OrgPermissionFallbackService.js";
import { consensus, type OrgPermissionEvidence } from "../src/salesforce/SalesforceEffectivePermissionVerifier.js";
import { MATRIX_PERMISSION_KEYS, type MatrixAccess, type MatrixPermission } from "../src/models/ObjectAccessMatrixResult.js";
import { permissionPresentation } from "../web/src/components/permissionPresentation.js";

const persona = { name: "Administrator", profile: "Administrator",
  permissionSets: ["PS_A"], permissionSetGroups: ["PSG_A"], mutingPermissionSets: [] };
const noAccess = (): MatrixAccess => Object.fromEntries(MATRIX_PERMISSION_KEYS.map((key) => [key, false])) as MatrixAccess;
const allAccess = (): MatrixAccess => Object.fromEntries(MATRIX_PERMISSION_KEYS.map((key) => [key, true])) as MatrixAccess;
const evidence = (source: OrgPermissionEvidence["source"]): OrgPermissionEvidence => ({
  source, outcome: source === "ORG_VERIFIED" ? "VERIFIED" : source === "ORG_DENIED" ? "DENIED" : "UNVERIFIED",
  checkedUsers: 2, matchedUsers: 2,
  message: source === "ORG_VERIFIED" ? "Grant not found in repository metadata. Access verified in Salesforce org." :
    source === "UNVERIFIED" ? "Salesforce org verification failed; needs Review." :
    "All matching Salesforce org users were denied the permission.",
});
const objectEvidence = (source: OrgPermissionEvidence["source"]) =>
  Object.fromEntries(MATRIX_PERMISSION_KEYS.map((key) => [key, evidence(source)])) as Record<MatrixPermission, OrgPermissionEvidence>;

test("repository grants take priority over Salesforce and do not show warning", async () => {
  let called = 0;
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => { called++; return objectEvidence("ORG_VERIFIED"); },
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_VERIFIED") }),
  });
  const result = await fallback.resolveObject(persona, "OrderSummary", allAccess());
  assert.equal(called, 0);
  assert.deepEqual(result.access, allAccess());
  assert.deepEqual(result.evidence, {});
});

test("all seven object privileges fall back to org, warning only for verified org-only grants", async () => {
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => objectEvidence("ORG_VERIFIED"),
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_VERIFIED") }),
  });
  const result = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  for (const permission of MATRIX_PERMISSION_KEYS) {
    assert.equal(result.access[permission], true, permission);
    assert.equal(result.evidence[permission]?.source, "ORG_VERIFIED", permission);
    const display = permissionPresentation(result.access[permission], result.evidence[permission]);
    assert.equal(display.label, "Yes");
    assert.equal(display.orgWarning, true);
    assert.match(display.title, /not found in repository metadata/i);
  }
});

test("verified grants do not conceal independent absent permissions", async () => {
  const expected = objectEvidence("ORG_VERIFIED");
  expected.delete = evidence("ORG_DENIED");
  expected.viewAllFields = evidence("UNVERIFIED");
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => expected,
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_DENIED") }),
  });
  const result = await fallback.resolveObject(persona, "ProcessException", noAccess());
  assert.equal(result.access.read, true);
  assert.equal(result.access.delete, false);
  assert.equal(result.access.viewAllFields, false);
  assert.equal(permissionPresentation(false, result.evidence.delete).label, "No");
  assert.equal(permissionPresentation(false, result.evidence.viewAllFields).label, "Review");
});

test("unavailable Salesforce connection does not convert missing metadata to No", async () => {
  const fallback = new OrgPermissionFallbackService();
  const result = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  for (const permission of MATRIX_PERMISSION_KEYS) {
    assert.equal(result.evidence[permission]?.source, "UNVERIFIED");
    assert.equal(permissionPresentation(false, result.evidence[permission]).label, "Review");
    assert.match(result.evidence[permission]!.message, /verification failed|not configured/i);
  }
});

test("Salesforce API failure is Review with an explicit failure reason", async () => {
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => { throw new Error("OAuth token expired"); },
    verifyField: async () => { throw new Error("OAuth token expired"); },
  });
  const result = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  assert.equal(result.evidence.create?.source, "UNVERIFIED");
  assert.match(result.evidence.create!.message, /OAuth token expired/);
  assert.match(result.evidence.create!.message, /needs Review/);
});

test("mixed matching-user access or incomplete API results require Review, never Yes or No", () => {
  const mixed = consensus([true, false], "Account Read", 2);
  const incomplete = consensus([true, null], "Account Read", 2);
  const denied = consensus([false, false], "Account Read", 2);
  const verified = consensus([true, true], "Account Read", 2);
  assert.equal(mixed.source, "UNVERIFIED");
  assert.match(mixed.message, /Mixed Salesforce access/);
  assert.equal(incomplete.source, "UNVERIFIED");
  assert.match(incomplete.message, /verification failed/);
  assert.equal(denied.source, "ORG_DENIED");
  assert.equal(verified.source, "ORG_VERIFIED");
  assert.equal(verified.matchedUsers, 2);
});

test("field Read/Edit combine object CRUD and FLS and show org warnings", async () => {
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => objectEvidence("ORG_VERIFIED"),
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_VERIFIED") }),
  });
  const object = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  const fields = await fallback.resolveField(persona, "OrderSummary", "Total_Pallets__c", object, { read: false, edit: false });
  assert.deepEqual(fields.access, { read: true, edit: true });
  assert.equal(permissionPresentation(fields.access.read, fields.evidence.read).orgWarning, true);
  assert.equal(permissionPresentation(fields.access.edit, fields.evidence.edit).orgWarning, true);
});

test("field Review shows object verification failure even if FLS is already in repo", async () => {
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => objectEvidence("UNVERIFIED"),
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_VERIFIED") }),
  });
  const object = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  const fields = await fallback.resolveField(persona, "OrderSummary", "Total_Pallets__c", object, { read: true, edit: true });
  assert.equal(fields.access.read, false);
  assert.equal(fields.evidence.read?.source, "UNVERIFIED");
  assert.match(fields.evidence.read!.message, /Object permission/);
  assert.equal(fields.evidence.edit?.source, "UNVERIFIED");
});

test("confirmed field Edit denial reports No even if object Edit is granted", async () => {
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => objectEvidence("ORG_VERIFIED"),
    verifyField: async () => ({ read: evidence("ORG_VERIFIED"), edit: evidence("ORG_DENIED") }),
  });
  const object = await fallback.resolveObject(persona, "OrderSummary", noAccess());
  const fields = await fallback.resolveField(persona, "OrderSummary", "Total_Pallets__c", object, { read: false, edit: false });
  assert.equal(fields.access.read, true);
  assert.equal(fields.access.edit, false);
  assert.equal(fields.evidence.edit?.source, "ORG_DENIED");
  assert.equal(permissionPresentation(fields.access.edit, fields.evidence.edit).label, "No");
});

test("metadata-only negative without org evidence is presented as Review", () => {
  assert.equal(permissionPresentation(false, evidence("UNVERIFIED")).label, "Review");
  assert.equal(permissionPresentation(true).orgWarning, false);
});
