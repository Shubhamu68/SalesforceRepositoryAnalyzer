import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import { OrgObjectReadVerificationService, isAccountStandardAddressField } from "../src/services/OrgObjectReadVerificationService.js";
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";
import type { FieldPermission } from "../src/models/FieldPermission.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";

const persona: Persona = {
  name: "SOQL Address Regression Persona", permissionSetGroups: [],
  permissionSets: ["Test_PS"], mutingPermissionSets: [],
};

function repositoryResolver(object: string, fields: FieldPermission[] = []): PersonaPermissionResolver {
  const permissionSet: PermissionSet = {
    name: "Test_PS", label: "Test PS", fieldPermissions: fields,
    objectPermissions: [{ object, allowRead: true, allowCreate: false,
      allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }],
  };
  const resolved: ResolvedPersonaPermissions = {
    persona, permissionSetGroups: [], directPermissionSets: [permissionSet],
    mutingPermissionSets: [], permissionSetGrants: [{ permissionSet, type: "directPermissionSet" }],
    mutesByGroup: new Map(),
  };
  return { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
}

function query(object: string, fields: string[], lineNumber = 10): SoqlQuery {
  return { filePath: "classes/AddressTest.cls", lineNumber,
    object, fields, query: `SELECT ${fields.join(", ")} FROM ${object} WITH USER_MODE`,
    subqueries: [], withUserMode: true, securityMode: "USER_MODE" };
}

type Outcome = "VERIFIED" | "DENIED" | "UNVERIFIED";
function verificationService(outcome: Outcome, checkedFields: string[]): OrgObjectReadVerificationService {
  const verifier = {
    verifyFieldRead: async (_persona: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence> => {
      checkedFields.push(`${object}.${field}`);
      return { object, field, outcome, checkedUsers: 2, matchedUsers: 2, sampled: false,
        message: outcome === "DENIED" ? `Salesforce denied ${object}.${field} Read.` :
          outcome === "VERIFIED" ? "Access verified from Salesforce." : "Unable to verify field Read." };
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  return new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set(["orderitemsummary"]) }, verifier);
}

async function run(object: string, fields: string[], service?: OrgObjectReadVerificationService,
  granted: FieldPermission[] = [], queries?: SoqlQuery[]) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sf-soql-address-"));
  try {
    const analyzer = new SoqlSecurityAnalyzer(repositoryResolver(object, granted), temp, service);
    return await analyzer.analyze(persona, queries ?? [query(object, fields)]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("Account address allowlist is explicit and case-insensitive", () => {
  for (const field of ["BillingCity", "BillingState", "BillingPostalCode", "BillingAddress",
    "ShippingCity", "ShippingStateCode", "ShippingAddress"]) {
    assert.equal(isAccountStandardAddressField("account", field), true, field);
  }
  assert.equal(isAccountStandardAddressField("Order", "BillingCity"), false);
  assert.equal(isAccountStandardAddressField("Account", "Billing_Custom__c"), false);
  assert.equal(isAccountStandardAddressField("Account", "Industry"), false);
});

test("Salesforce-verified missing Account fields are LOW in Excel, not errors", async () => {
  const checks: string[] = [];
  const findings = await run("Account", ["BillingCity", "BillingState", "Industry"],
    verificationService("VERIFIED", checks));
  assert.deepEqual(checks.map((item) => item.toLowerCase()).sort(),
    ["account.billingcity", "account.billingstate", "account.industry"].sort());
  assert.equal(findings.filter((item) => item.criticality === "Low").length, 3);
  assert.ok(findings.every((item) => item.severity === "INFO"));
});

test("Salesforce denial remains HIGH for BillingCity", async () => {
  const findings = await run("Account", ["BillingCity"], verificationService("DENIED", []));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "ERROR");
  assert.equal(findings[0].criticality, "High");

  // Confirm the Salesforce denial is clearly reported.
  assert.match(findings[0].reason, /Salesforce confirmed.*missing/i);

  // Ensure the old duplicate explanation is not appended.
  assert.doesNotMatch(findings[0].reason, /Salesforce denied/i);
});

test("Unverifiable BillingCity is REVIEW, not a false permission denial", async () => {
  const findings = await run("Account", ["BillingCity"], verificationService("UNVERIFIED", []));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "REVIEW");
});

test("Without a live verifier, missing Account address FLS is REVIEW", async () => {
  const findings = await run("Account", ["BillingCity"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "REVIEW");
});

test("Repository FLS grant bypasses redundant Salesforce calls", async () => {
  const checks: string[] = [];
  const findings = await run("Account", ["BillingCity"], verificationService("DENIED", checks),
    [{ field: "Account.BillingCity", readable: true, editable: false }]);
  assert.equal(findings.length, 0);
  assert.deepEqual(checks, []);
});

test("A missing Account standard address field is checked just once across repeated SOQL queries", async () => {
  const checks: string[] = [];
  const findings = await run("Account", [], verificationService("VERIFIED", checks), [],
    [query("Account", ["BillingCity"], 10), query("Account", ["BillingCity"], 15)]);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((item) => item.criticality === "Low"));
  assert.deepEqual(checks.map((item) => item.toLowerCase()), ["account.billingcity"]);
});

test("Configured OrderItemSummary field FLS remains independently org-verified", async () => {
  const checks: string[] = [];
  const findings = await run("OrderItemSummary", ["Order_Quantity_Change__c"],
    verificationService("DENIED", checks));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "ERROR");
  assert.deepEqual(checks.map((item) => item.toLowerCase()), ["orderitemsummary.order_quantity_change__c"]);
});
