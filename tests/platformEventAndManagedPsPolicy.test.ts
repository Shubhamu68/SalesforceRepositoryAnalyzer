import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isFieldLevelSecurityApplicable, isDataAccessAnalysisObject, assertDataAccessAnalysisObject, PLATFORM_EVENT_FLS_REASON, PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON } from "../src/config/fieldSecurityPolicy.js";
import { isKnownSalesforcePermissionSet } from "../src/config/knownSalesforcePermissionSets.js";
import { getFieldPermissionability } from "../src/analyzer/fieldPermissionability.js";
import { createPersonaAccessEvaluator } from "../src/analyzer/personaAccessEvaluator.js";
import type { ResolvedPersonaPermissions, PersonaPermissionResolver } from "../src/analyzer/PersonaPermissionResolver.js";
import type { Persona } from "../src/models/Persona.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";
import { PersonaFieldAccessService } from "../src/services/PersonaFieldAccessService.js";
import { OrgPermissionFallbackService } from "../src/services/OrgPermissionFallbackService.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import { ObjectAccessMatrixService } from "../src/services/ObjectAccessMatrixService.js";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";
import { parsePermissionSetGroup } from "../src/parser/permissionSetGroupParser.js";

const event = "OrderSummaryProcessingEvent__e";
const field = "OrderSummaryId__c";
const managed = "force__LightningOrderManagementOperationsManager";
const persona: Persona = { name: "OMS", profile: undefined, permissionSets: [],
  permissionSetGroups: [], mutingPermissionSets: [] };

function setup(objectRead = true): { resolver: PersonaPermissionResolver; permissions: ResolvedPersonaPermissions } {
  const ps: PermissionSet = { name: "OMS_PS", label: "OMS",
    objectPermissions: [{ object: event, allowRead: objectRead, allowCreate: true,
      allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }],
    fieldPermissions: [] };
  const permissions: ResolvedPersonaPermissions = { persona, permissionSetGroups: [],
    directPermissionSets: [ps], permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
    mutingPermissionSets: [], mutesByGroup: new Map() };
  return { permissions, resolver: { resolve: async () => permissions } as unknown as PersonaPermissionResolver };
}

test("central policy exempts only custom Platform Event field FLS, including namespaced events", () => {
  for (const name of [event, "ns__OrderSummaryProcessingEvent__e", "a__E__E", "  Event__e  "]) {
    assert.equal(isFieldLevelSecurityApplicable(name), false, name);
  }
  for (const name of ["OrderSummary", "Event", "AccountChangeEvent", "OrderSummaryChangeEvent", "Custom__c", "Thing__e__c"]) {
    assert.equal(isFieldLevelSecurityApplicable(name), true, name);
  }
  assert.equal(getFieldPermissionability(event, field), false);
  assert.equal(isDataAccessAnalysisObject(event), false);
  assert.equal(isDataAccessAnalysisObject("pkg__MyEvent__e"), false);
  assert.equal(isDataAccessAnalysisObject("AccountChangeEvent"), true);
  assert.equal(isDataAccessAnalysisObject("OrderSummary"), true);
  assert.throws(() => assertDataAccessAnalysisObject(event), { message: PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON });
  assert.doesNotThrow(() => assertDataAccessAnalysisObject("Account"));
  assert.match(PLATFORM_EVENT_FLS_REASON, /does not apply/);
});

test("shared persona evaluator retains event object Read/Create without inventing field FLS grants", () => {
  const { permissions } = setup();
  const evaluator = createPersonaAccessEvaluator(permissions);
  const object = evaluator.evaluateObject(event).access;
  const fieldAccess = evaluator.evaluateField(`${event}.${field}`);
  assert.equal(object.read, true);
  assert.equal(object.create, true);
  assert.equal(fieldAccess.readable, true);
  assert.equal(fieldAccess.editable, false);
  assert.equal(fieldAccess.flsApplicable, false);
  assert.equal(fieldAccess.permissionable, false);
  assert.deepEqual(fieldAccess.readGrantedBy, []);
  assert.deepEqual(fieldAccess.editGrantedBy, []);
});

test("Access Checker returns FLS N/A without touching any Salesforce FLS endpoint", async () => {
  const { resolver } = setup();
  let count = 0;
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => { count++; throw new Error("org object access should not be queried by field FLS view"); },
    verifyField: async () => { count++; throw new Error("org field FLS should not be queried"); },
  });
  const result = await new PersonaFieldAccessService(resolver, undefined, fallback)
    .getFieldAccess(persona, event, field);
  assert.equal(result.flsApplicable, false);
  assert.equal(result.permissionable, false);
  assert.equal(result.flsReason, PLATFORM_EVENT_FLS_REASON);
  assert.equal(count, 0);
  assert.deepEqual(result.readGrantedBy, []);
});

test("shared org FLS verification gateways skip Platform Events, but allow ordinary fields", async () => {
  let calls = 0;
  const fake = {
    getVerificationScope: () => "test",
    verifyFieldRead: async () => { calls++; throw new Error("must not query Salesforce FLS for events"); },
  } as unknown as SalesforcePersonaAccessVerifier;
  const org = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, fake);
  assert.equal(org.shouldVerifyMissingRepositoryField(event, field), false);
  assert.equal(org.shouldVerifyMissingRepositoryField("Account", "Name"), true);
  assert.equal(await org.resolveField(persona, event, field), undefined);
  const decision = await org.resolveFieldRead(persona, event, field, false);
  assert.equal(decision.readable, true);
  assert.match(decision.message, /does not apply/);
  const fallback = new OrgPermissionFallbackService({
    verifyObject: async () => { throw new Error("not required"); },
    verifyField: async () => { calls++; throw new Error("must not query Salesforce FLS"); },
  });
  const result = await fallback.resolveField(persona, event, field,
    { access: { read: true, create: true, edit: false, delete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }, evidence: {} },
    { read: false, edit: false });
  assert.deepEqual(result.evidence, {});
  assert.deepEqual(result.access, { read: false, edit: false });
  assert.equal(calls, 0);
});

test("SOQL security entirely excludes Platform Events while retaining ordinary object checks", async () => {
  const { resolver } = setup();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sf-event-fls-"));
  const query: SoqlQuery = {
    object: event, fields: [field], filePath: "SomeClass.cls", lineNumber: 10,
    query: `SELECT ${field} FROM ${event} WITH USER_MODE`, withUserMode: true,
    securityMode: "USER_MODE", subqueries: [],
  };
  try {
    const findings = await new SoqlSecurityAnalyzer(resolver, tmp).analyze(persona, [query]);
    assert.deepEqual(findings.filter((f) => f.findingType === "FIELD_READ"), []);
    assert.deepEqual(findings.filter((f) => f.findingType === "OBJECT_READ"), []);
    // Event object permissions are not part of SOQL data-access reporting.
    const missing = setup(false);
    const missingFindings = await new SoqlSecurityAnalyzer(missing.resolver, tmp).analyze(persona, [query]);
    assert.deepEqual(missingFindings, []);
    const accountQuery: SoqlQuery = {
      ...query, object: "Account", fields: ["Name"],
      query: "SELECT Name FROM Account WITH USER_MODE",
    };
    const ordinaryFindings = await new SoqlSecurityAnalyzer(missing.resolver, tmp)
      .analyze(persona, [query, accountQuery]);
    assert.equal(ordinaryFindings.some((f) => f.object === "Account" && f.findingType === "OBJECT_READ"), true);
    assert.equal(ordinaryFindings.some((f) => f.object.toLowerCase().endsWith("__e")), false);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("managed OM permission set is recognized in both Salesforce prefix spellings only", () => {
  assert.equal(isKnownSalesforcePermissionSet(managed), true);
  assert.equal(isKnownSalesforcePermissionSet("force_LightningOrderManagementOperationsManager"), true);
  assert.equal(isKnownSalesforcePermissionSet("FORCE__LIGHTNINGORDERMANAGEMENTOPERATIONSMANAGER"), true);
  assert.equal(isKnownSalesforcePermissionSet("force__OtherManagedPermissionSet"), false);
});

test("Matrix hides only missing managed OM PS metadata, preserving unrelated warnings", async () => {
  const group = { name: "OM_PSG", label: "OM", permissionSetNames: [managed, "Missing_Custom_PS"],
    mutingPermissionSetNames: [], permissionSets: [] };
  const p: Persona = { name: "OM Persona", profile: undefined,
    permissionSets: [managed, "Missing_Direct_PS"], permissionSetGroups: [group.name],
    mutingPermissionSets: [] };
  const resolved: ResolvedPersonaPermissions = { persona: p, permissionSetGroups: [group],
    directPermissionSets: [], permissionSetGrants: [], mutingPermissionSets: [], mutesByGroup: new Map() };
  const loader = { getAllPersonas: async () => [p] };
  const resolver = { resolve: async () => resolved };
  const matrix = new ObjectAccessMatrixService(loader as never, resolver as never);
  await assert.rejects(() => matrix.analyze(event), { message: PLATFORM_EVENT_ANALYSIS_EXCLUSION_REASON });
  const result = await matrix.analyze("OrderSummary");
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.includes("Missing_Custom_PS")));
  assert.ok(result.warnings.some((w) => w.includes("Missing_Direct_PS")));
  assert.equal(result.warnings.some((w) => w.includes(managed)), false);
  assert.equal(result.personas[0].warnings.some((w) => w.includes(managed)), false);
});

test("Permission Set Group parser stays quiet for absent managed OM metadata but warns for genuine missing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-om-managed-"));
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => { messages.push(args.join(" ")); };
  try {
    const psDir = path.join(root, "permissionsets");
    await mkdir(psDir);
    const file = path.join(root, "OM_PSG.permissionsetgroup-meta.xml");
    await writeFile(file, `<PermissionSetGroup><label>OM</label><permissionSets>${managed}</permissionSets><permissionSets>RealMissingPS</permissionSets></PermissionSetGroup>`);
    const result = await parsePermissionSetGroup(file, psDir);
    assert.deepEqual(result.permissionSetNames, [managed, "RealMissingPS"]);
    assert.equal(result.permissionSets.length, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /RealMissingPS/);
    assert.doesNotMatch(messages[0], /LightningOrderManagementOperationsManager/);
  } finally {
    console.warn = original;
    await rm(root, { recursive: true, force: true });
  }
});
