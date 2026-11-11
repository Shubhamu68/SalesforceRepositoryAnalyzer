import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { StackTraceImpactService } from "../src/services/StackTraceImpactService.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { PersonaConfigLoader } from "../src/config/PersonaConfigLoader.js";
import type { SalesforceRelationshipMetadataService } from "../src/salesforce/SalesforceRelationshipMetadataService.js";
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { Persona } from "../src/models/Persona.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";
import type { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";

const persona: Persona = {
  name: "OTC", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [],
};
function environment(objectRead = true, withMetadata = true) {
  const calls: string[] = [];
  const objects = ["Account", "Contact", "Case", "Opportunity"];
  const ps: PermissionSet = {
    name: "TestAccess", label: "TestAccess",
    objectPermissions: (objectRead ? objects : []).map(object => ({
      object, allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false,
      viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
    })),
    fieldPermissions: [],
  };
  const permissions: ResolvedPersonaPermissions = {
    persona, directPermissionSets: [ps], permissionSetGroups: [],
    permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
    mutingPermissionSets: [], mutesByGroup: new Map(),
  };
  const resolver = { resolve: async () => permissions } as unknown as PersonaPermissionResolver;
  const loader = { getAllPersonas: async () => [persona] } as unknown as PersonaConfigLoader;
  const result = (obj: string, field?: string): OrgObjectAccessEvidence => ({
    object: obj, ...(field ? { field } : {}),
    outcome: "DENIED", matchedUsers: 1, checkedUsers: 1,
    sampled: false, message: "Salesforce confirmed missing access.",
  });
  const mock = {
    getVerificationScope: () => "nested-test",
    verifyObjectRead: async (_p: Persona, object: string) => {
      calls.push("object:" + object); return result(object);
    },
    verifyFieldRead: async (_p: Persona, object: string, field: string) => {
      calls.push("field:" + object + "." + field);
      return result(object, field);
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  const read = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, mock);
  const metadata = {
    createHydrator: (map: RelationshipMap) => ({
      hydrateQuery: async () => {
        if (withMetadata) {
          map.addChild("Account", "Contacts", "Contact");
          map.addChild("Contact", "Cases", "Case");
          map.addChild("Account", "Opportunities", "Opportunity");
          map.addParent("Contact", "Account", ["Account"], "AccountId");
        }
        return [];
      },
    }),
  } as unknown as SalesforceRelationshipMetadataService;
  return { calls, resolver, loader, read, metadata };
}
const source = (query: string) => extractSoqlQueries("List<SObject> rows = [" + query + "];", "classes/Verifier.cls");

async function analyze(queryText: string, config = environment()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sf-nested-analyzer-"));
  try {
    const analyzer = new SoqlSecurityAnalyzer(config.resolver, directory, config.read, undefined, config.metadata);
    const findings = await analyzer.analyze(persona, source(queryText));
    return { findings, calls: config.calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("nested child FLS checks actual Contact fields, not a fake relationship field", async () => {
  const { findings, calls } = await analyze(
    "SELECT Id, (SELECT Custom_Field__c FROM Contacts) FROM Account WITH USER_MODE");
  assert.ok(findings.some(f => f.object === "Contact" && f.field === "Custom_Field__c" && f.criticality === "High"));
  assert.ok(!findings.some(f => f.field.includes("SELECT")));
  assert.ok(calls.includes("field:Contact.Custom_Field__c"));
});
test("two nested levels independently check fields of the correct child objects", async () => {
  const { findings } = await analyze(
    "SELECT Id, (SELECT Custom_Field__c, (SELECT Case_Custom__c FROM Cases) FROM Contacts) FROM Account WITH USER_MODE");
  assert.ok(findings.some(f => f.object === "Contact" && f.field === "Custom_Field__c"));
  assert.ok(findings.some(f => f.object === "Case" && f.field === "Case_Custom__c"));
});
test("nested field inherits root WITH USER_MODE for High severity", async () => {
  const { findings } = await analyze(
    "SELECT Id,\n (SELECT Custom_Field__c FROM Contacts)\n FROM Account WITH USER_MODE");
  const child = findings.find(f => f.object === "Contact" && f.field === "Custom_Field__c");
  assert.equal(child?.criticality, "High");
  assert.equal(child?.lineNumber, 2);
  assert.equal(child?.effectiveMode, "USER_MODE");
  assert.equal(child?.relationshipPath, "Account -> Contacts");
});
test("missing child metadata is review, not a fabricated High permission denial", async () => {
  const { findings, calls } = await analyze(
    "SELECT Id, (SELECT Custom_Field__c FROM UnknownChildren__r) FROM Account WITH USER_MODE",
    environment(true, false));
  const relationship = findings.find(f => f.findingType === "RELATIONSHIP");
  assert.ok(relationship);
  assert.equal(relationship.criticality, "Unable to verify");
  assert.match(relationship.field, /Child relationship:/);
  assert.ok(!calls.some(x => x.includes("UnknownChildren__r")));
});
test("semi-join object and filter FLS use Contact without child-relationship lookup", async () => {
  const { findings, calls } = await analyze(
    "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Custom_Field__c != null) WITH USER_MODE");
  assert.ok(findings.some(f => f.object === "Contact" && f.field === "Custom_Field__c"));
  assert.ok(calls.includes("field:Contact.Custom_Field__c"));
  assert.ok(!findings.some(f => f.findingType === "RELATIONSHIP"));
});
test("COUNT-only query still verifies object Read and never invents field FLS", async () => {
  const { findings, calls } = await analyze("SELECT COUNT() FROM Account WITH USER_MODE", environment(false));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "OBJECT_READ");
  assert.equal(findings[0].criticality, "High");
  assert.deepEqual(calls, ["object:Account"]);
});
test("system mode nested denied FLS remains a Low advisory", async () => {
  const { findings } = await analyze(
    "SELECT Id, (SELECT Custom_Field__c FROM Contacts) FROM Account WITH SYSTEM_MODE");
  const child = findings.find(f => f.object === "Contact" && f.field === "Custom_Field__c");
  assert.equal(child?.criticality, "Low");
});
test("org metadata fallback is only called for unresolved relationships", async () => {
  const config = environment();
  let invoked = 0;
  config.metadata = { createHydrator: (map: RelationshipMap) => ({
    hydrateQuery: async () => { invoked++; map.addChild("Account", "Contacts", "Contact"); return []; },
  }) } as unknown as SalesforceRelationshipMetadataService;
  await analyze("SELECT Name FROM Account WITH USER_MODE", config);
  assert.equal(invoked, 0);
  await analyze("SELECT Id, (SELECT Custom_Field__c FROM Contacts) FROM Account WITH USER_MODE", config);
  assert.equal(invoked, 1);
});
test("Stack Trace uses the same nested collector and resolves child permission results", async () => {
  const config = environment();
  const directory = await mkdtemp(path.join(os.tmpdir(), "sf-nested-stack-"));
  try {
    await mkdir(path.join(directory, "objects"));
    const apex = path.join(directory, "Nested.cls");
    await writeFile(apex, [
      "public class Nested {",
      "  public static void run() {",
      "    List<Account> x = [SELECT Id, (SELECT Custom_Field__c FROM Contacts) FROM Account WITH USER_MODE];",
      "  }",
      "}",
    ].join("\n"));
    await writeFile(apex + "-meta.xml", "<ApexClass><apiVersion>66.0</apiVersion></ApexClass>");
    const stack = new StackTraceImpactService(directory, path.join(directory, "objects"), config.loader,
      config.resolver, path.join(directory, "muting"), config.read, config.metadata);
    const result = await stack.analyze("Class.Nested.run: line 3, column 1");
    assert.ok(result.queries[0].checkedFields.some(f => f.object === "Contact" && f.field === "Custom_Field__c"));
    assert.ok(result.personas[0].missing.some(f => f.object === "Contact" && f.field === "Custom_Field__c"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
