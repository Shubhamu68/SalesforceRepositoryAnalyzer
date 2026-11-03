import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  extractApexMethods, extractMethodCalls, parseApexStackTrace, resolveMethodCalls,
} from "../src/scanner/apexMethodScanner.js";
import { classifyStackSoqlMode, collectQueryFields, StackTraceImpactService } from "../src/services/StackTraceImpactService.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";

const initial = `public with sharing class OMSQueryService {
  // [SELECT Secret__c FROM Account WITH USER_MODE]
  public static void getTrxValidationMap(Set<Id> ids) {
    String ignored = '{ SELECT Id FROM Other__c }';
    List<OrderSummary> orders = [
      SELECT Id, Status__c, Account.Name, Account.Account_Code__c
      FROM OrderSummary WITH USER_MODE
    ];
    helper(ids);
    ProductService.validateProducts(ids);
  }
  private static void helper(Set<Id> ids) {
    List<Account> a = [SELECT Account_Code__c FROM Account WITH USER_MODE];
    if (ids.size() == 0) { helper(ids); } // recursion must terminate
  }
}`;
const second = `public with sharing class ProductService {
  public static void validateProducts(Set<Id> ids) {
    List<Product2> p = [SELECT Id, ProductCode FROM Product2 WITH USER_MODE];
  }
}`;

test("stack trace parses Salesforce Class and Trigger frames", () => {
  const frames = parseApexStackTrace(`Class.OMSQueryService.getTrxValidationMap: line 5, column 1\nTrigger.ProcessExceptionTrigger: line 23, column 1`);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].methodName, "getTrxValidationMap");
  assert.equal(frames[1].kind, "Trigger");
});

test("method extraction ignores braces in strings/comments and SOQL in comments", () => {
  const methods = extractApexMethods(initial, "/repo/OMSQueryService.cls");
  assert.equal(methods.length, 2);
  const root = methods.find((m) => m.methodName === "getTrxValidationMap")!;
  assert.equal(root.queries.length, 1);
  assert.equal(root.queries[0].object, "OrderSummary");
  const calls = extractMethodCalls(root);
  assert.ok(calls.some((c) => c.method === "helper"));
  assert.ok(calls.some((c) => c.qualifier === "ProductService" && c.method === "validateProducts"));
});

test("resolver follows same-class and explicit class calls, not collection methods", () => {
  const a = extractApexMethods(initial, "/repo/OMSQueryService.cls");
  const b = extractApexMethods(second, "/repo/ProductService.cls");
  const index = { methods: [...a, ...b], files: [], classes: new Map([
    ["omsqueryservice", a], ["productservice", b],
  ]) };
  const called = resolveMethodCalls(a[0], index, []);
  assert.deepEqual(new Set(called.map((m) => `${m.className}.${m.methodName}`)),
    new Set(["OMSQueryService.helper", "ProductService.validateProducts"]));
});

test("field extraction resolves standard lookup traversal and retains related-object Read", () => {
  const query = extractApexMethods(initial, "/repo/OMSQueryService.cls")[0].queries[0];
  const fields = collectQueryFields(query, new Map());
  assert.ok(fields.objects.includes("Account"));
  assert.ok(fields.objects.includes("OrderSummary"));
  assert.ok(fields.fields.some((f) => f.object === "Account" && f.field === "Account_Code__c"));
  assert.ok(!fields.fields.some((f) => f.field === "Name"));
});

function ps(name: string, objects: string[], fields: string[]): PermissionSet {
  return {
    name, label: name,
    objectPermissions: objects.map((object) => ({ object,
      allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false,
      viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
    })),
    fieldPermissions: fields.map((field) => ({ field, readable: true, editable: false })),
  };
}

test("end-to-end: recursively evaluates multiple queries across two personas", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stack-impact-"));
  try {
    const clsDir = path.join(dir, "force-app", "main", "default", "classes");
    const objects = path.join(dir, "force-app", "main", "default", "objects");
    const mutes = path.join(dir, "force-app", "main", "default", "mutingpermissionsets");
    await Promise.all([mkdir(clsDir, { recursive: true }), mkdir(objects, { recursive: true }), mkdir(mutes, { recursive: true })]);
    await writeFile(path.join(clsDir, "OMSQueryService.cls"), initial);
    await writeFile(path.join(clsDir, "ProductService.cls"), second);
    const good = { name: "Good", permissionSets: ["Allow"], permissionSetGroups: [], mutingPermissionSets: [] };
    const bad = { name: "Bad", permissionSets: ["Limited"], permissionSetGroups: [], mutingPermissionSets: [] };
    const allow = ps("Allow", ["OrderSummary", "Account", "Product2"],
      ["OrderSummary.Status__c", "Account.Account_Code__c", "Product2.ProductCode"]);
    const limited = ps("Limited", ["OrderSummary", "Product2"], ["Product2.ProductCode"]);
    const loader = { getAllPersonas: async () => [good, bad] };
    const resolver = { resolve: async (persona: typeof good) => ({
      persona, permissionSetGroups: [], mutingPermissionSets: [],
      directPermissionSets: [persona.name === "Good" ? allow : limited],
      permissionSetGrants: [],
    }) };
    const service = new StackTraceImpactService(dir, objects, loader as never, resolver as never, mutes);
    const result = await service.analyze("Class.OMSQueryService.getTrxValidationMap: line 6, column 1");
    assert.equal(result.summary.methodsVisited, 3);
    assert.equal(result.summary.queriesFound, 3);
    assert.equal(result.summary.personasChecked, 2);
    assert.equal(result.personas.find((p) => p.personaName === "Good")?.status, "NO_GAPS");
    assert.equal(result.personas.find((p) => p.personaName === "Bad")?.status, "AT_RISK");
    assert.ok(result.personas.find((p) => p.personaName === "Bad")!.missing.some((m) => m.object === "Account"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WHERE and ORDER BY fields are included while quoted predicates are ignored", () => {
  const query = {
    object: "Account",
    fields: ["Id"], subqueries: [], lineNumber: 2,
    query: `SELECT Id FROM Account WHERE Account_Code__c = :code AND Name = 'Fake__c = :x' ORDER BY Customer_Status__c DESC WITH USER_MODE`,
    filePath: "AccountService.cls", withUserMode: true, securityMode: "USER_MODE" as const,
  };
  const result = collectQueryFields(query, new Map());
  assert.ok(result.fields.some((f) => f.field === "Account_Code__c"));
  assert.ok(result.fields.some((f) => f.field === "Customer_Status__c"));
  assert.ok(!result.fields.some((f) => f.field === "Fake__c"));
});

test("parent-child subquery checks child object even with system fields only", () => {
  const query = {
    object: "Account", fields: ["Id"],
    subqueries: [{ relationshipName: "Contacts", fields: ["Id"], subqueries: [] }],
    lineNumber: 2, query: "SELECT Id, (SELECT Id FROM Contacts) FROM Account WITH USER_MODE",
    filePath: "AccountService.cls", withUserMode: true, securityMode: "USER_MODE" as const,
  };
  const result = collectQueryFields(query, new Map());
  assert.ok(result.objects.includes("Contact"));
  assert.ok(result.objects.includes("Account"));
});

test("custom parent lookup resolves from child lookup metadata", () => {
  const map = new Map([["Account", new Map([["ClientOrders__r", {
    relationshipName: "ClientOrders__r", sourceField: "Client__c",
    childObject: "OrderSummary", targetObjects: ["Account"],
  }]])]]);
  const query = {
    object: "OrderSummary", fields: ["Client__r.Account_Code__c"], subqueries: [],
    lineNumber: 12, query: "SELECT Client__r.Account_Code__c FROM OrderSummary WITH USER_MODE",
    filePath: "OMSQueryService.cls", withUserMode: true, securityMode: "USER_MODE" as const,
  };
  const result = collectQueryFields(query, map);
  assert.deepEqual(result.unresolved, []);
  assert.ok(result.fields.some((item) => item.object === "Account" && item.field === "Account_Code__c"));
});

test("unknown relationships are not silently dropped", () => {
  const query = {
    object: "OrderSummary", fields: ["SomeDynamic__r.Secret__c"], subqueries: [],
    lineNumber: 12, query: "SELECT SomeDynamic__r.Secret__c FROM OrderSummary WITH USER_MODE",
    filePath: "OMSQueryService.cls", withUserMode: true, securityMode: "USER_MODE" as const,
  };
  const result = collectQueryFields(query, new Map());
  assert.deepEqual(result.unresolved, ["OrderSummary.SomeDynamic__r.Secret__c"]);
});


test("SECURITY_ENFORCED is classified as FLS enforced; comments do not count", () => {
  assert.equal(classifyStackSoqlMode("SELECT Id FROM Account WITH SECURITY_ENFORCED"), "SECURITY_ENFORCED");
  assert.equal(classifyStackSoqlMode("SELECT Id FROM Account /* WITH USER_MODE */ WITH SECURITY_ENFORCED"), "SECURITY_ENFORCED");
  assert.equal(classifyStackSoqlMode("SELECT Id FROM Account WITH USER_MODE"), "USER_MODE");
  assert.equal(classifyStackSoqlMode("SELECT Id FROM Account WITH SYSTEM_MODE"), "SYSTEM_MODE");
});

test("SECURITY_ENFORCED missing selected-field access is at risk; WHERE-only field is not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stack-sec-enforced-"));
  try {
    const clsDir = path.join(dir, "force-app", "main", "default", "classes");
    const objects = path.join(dir, "force-app", "main", "default", "objects");
    const mutes = path.join(dir, "force-app", "main", "default", "mutingpermissionsets");
    await Promise.all([mkdir(clsDir, { recursive: true }), mkdir(objects, { recursive: true }), mkdir(mutes, { recursive: true })]);
    await writeFile(path.join(clsDir, "Sample.cls"), `public class Sample {
  public static void run() {
    List<Account> a = [SELECT Id, Account_Code__c FROM Account WHERE Other__c = 'x' WITH SECURITY_ENFORCED];
  }
}`);
    const persona = { name: "Tester", permissionSets: ["Limited"], permissionSetGroups: [], mutingPermissionSets: [] };
    const allowed = ps("Limited", ["Account"], ["Account.Other__c"]);
    const loader = { getAllPersonas: async () => [persona] };
    const resolver = { resolve: async () => ({ persona, permissionSetGroups: [], mutingPermissionSets: [], directPermissionSets: [allowed], permissionSetGrants: [] }) };
    const service = new StackTraceImpactService(dir, objects, loader as never, resolver as never, mutes);
    const result = await service.analyze("Class.Sample.run: line 3, column 1");
    assert.equal(result.personas[0].status, "AT_RISK");
    assert.ok(result.personas[0].missing.some((m) => m.field === "Account_Code__c"));
    assert.ok(!result.personas[0].missing.some((m) => m.field === "Other__c"));
    assert.equal(result.queries[0].securityMode, "SECURITY_ENFORCED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("known missing Salesforce-owned PS does not make the result inconclusive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stack-managed-ps-"));
  try {
    const clsDir = path.join(dir, "force-app", "main", "default", "classes");
    const objects = path.join(dir, "force-app", "main", "default", "objects");
    const mutes = path.join(dir, "force-app", "main", "default", "mutingpermissionsets");
    await Promise.all([mkdir(clsDir, { recursive: true }), mkdir(objects, { recursive: true }), mkdir(mutes, { recursive: true })]);
    await writeFile(path.join(clsDir, "Sample.cls"), `public class Sample {
  public static void run() {
    List<Account> a = [SELECT Other__c FROM Account WITH SECURITY_ENFORCED];
  }
}`);
    const standard = "force_LightningOrderManagementOperationsManager";
    const persona = { name: "Tester", permissionSets: [standard], permissionSetGroups: [], mutingPermissionSets: [] };
    const loader = { getAllPersonas: async () => [persona] };
    const resolver = { resolve: async () => ({ persona, permissionSetGroups: [], mutingPermissionSets: [], directPermissionSets: [], permissionSetGrants: [] }) };
    const service = new StackTraceImpactService(dir, objects, loader as never, resolver as never, mutes);
    const result = await service.analyze("Class.Sample.run: line 3, column 1");
    assert.equal(result.personas[0].status, "AT_RISK");
    assert.ok(!result.warnings.some((w) => w.includes("incomplete Permission Set metadata")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
