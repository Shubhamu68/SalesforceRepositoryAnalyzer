import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../src/analyzer/soqlQueryFieldResolver.js";
import { buildSoqlFieldInventory } from "../src/analyzer/soqlFieldInventoryBuilder.js";
import { SalesforceRelationshipMetadataService } from "../src/salesforce/SalesforceRelationshipMetadataService.js";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { Persona } from "../src/models/Persona.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";

const parse = (text: string) =>
  extractSoqlQueries("List<SObject> r = [" + text + "];", "classes/Polymorphic.cls")[0];

type Setup = {
  missingName?: boolean;
  missingFields?: string[];
  noPolymorphicMetadata?: boolean;
  singleOwner?: boolean;
};
function fakeOrg(options: Setup = {}) {
  const requests: string[] = [];
  const descriptions = {
    Case: {
      name: "Case",
      fields: [{
        name: "OwnerId", relationshipName: "Owner", referenceTo: options.singleOwner ? ["User"] : ["User", "Group"],
        namePointing: !options.noPolymorphicMetadata,
        polymorphicForeignKey: !options.noPolymorphicMetadata,
      }],
      childRelationships: [],
    },
    GroupMember: {
      name: "GroupMember",
      fields: [{
        name: "UserOrGroupId", relationshipName: "UserOrGroup",
        referenceTo: ["Group", "PartnerNetworkConnection", "User"],
        namePointing: !options.noPolymorphicMetadata,
        polymorphicForeignKey: !options.noPolymorphicMetadata,
      }],
      childRelationships: [],
    },
    Name: {
      name: "Name",
      fields: ["Name", "Type", "IsActive", "Email", "FirstName"].filter(
        name => !options.missingFields?.includes(name)).map(name => ({ name, type: "string" })),
      childRelationships: [],
    },
  };
  const connection = {
    async describeSObject(name: string) {
      requests.push(name);
      if (name === "Name" && options.missingName) throw Error("Pseudo-object Describe unavailable");
      if (name in descriptions) return descriptions[name as keyof typeof descriptions];
      throw Error("Unknown Salesforce object " + name);
    },
  } as unknown as SalesforceOrgConnection;
  return { connection, requests };
}

test("Case.Owner.Type uses Name pseudo-object, not User.Type or Group.Type", async () => {
  const org = fakeOrg();
  const graph = new RelationshipMap();
  const q = parse("SELECT Id, Owner.Type FROM Case WHERE Owner.Type = 'User'");
  assert.ok(collectQueryFields(q, graph).unresolvedEntries.length > 0);
  const hydrated = await new SalesforceRelationshipMetadataService(org.connection)
    .createHydrator(graph).hydrateQuery(q);
  assert.deepEqual(hydrated, []);
  const resolved = graph.resolveField("Case", "Owner.Type");
  assert.deepEqual(resolved, {
    object: "Name", field: "Type", objects: ["Case"], polymorphicNamePseudoField: true,
  });
  assert.ok(org.requests.includes("Case") && org.requests.includes("Name"));
  const inventory = buildSoqlFieldInventory([q], graph);
  assert.deepEqual([...inventory.keys()], ["Case"]);
  assert.equal(inventory.get("Case")?.size, 0, "no invented User/Group or Name FLS");
  assert.deepEqual(collectQueryFields(q, graph).unresolvedEntries, []);
});

test("GroupMember.UserOrGroup.IsActive resolves across all three Salesforce target types", async () => {
  const org = fakeOrg();
  const graph = new RelationshipMap();
  const q = parse("SELECT Id, UserOrGroup.IsActive FROM GroupMember WHERE UserOrGroup.IsActive = true");
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph).hydrateQuery(q);
  assert.deepEqual(graph.parentTargets("GroupMember", "UserOrGroup"),
    ["Group", "PartnerNetworkConnection", "User"]);
  assert.deepEqual(graph.resolveField("GroupMember", "UserOrGroup.IsActive"), {
    object: "Name", field: "IsActive", objects: ["GroupMember"], polymorphicNamePseudoField: true,
  });
  const c = collectQueryFields(q, graph);
  assert.deepEqual(c.unresolvedEntries, []);
  assert.ok(c.objects.includes("GroupMember"));
  assert.ok(!c.objects.some(x => ["Name", "Group", "PartnerNetworkConnection", "User"].includes(x)));
  const inv = buildSoqlFieldInventory([q], graph);
  assert.deepEqual([...inv.keys()], ["GroupMember"]);
  assert.equal(inv.get("GroupMember")?.size, 0);
});

test("WHERE-only polymorphic paths are hydrated from raw unresolved paths", async () => {
  const org = fakeOrg();
  const graph = new RelationshipMap();
  const q = parse("SELECT Id FROM Case WHERE Owner.Type = 'Queue'");
  const first = collectQueryFields(q, graph);
  assert.ok(first.unresolvedEntries.some(x => x.fieldPath === "Owner.Type"));
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph)
    .hydrateQuery(q, first.unresolvedEntries.map(x => x.baseObject + "." + x.fieldPath));
  assert.deepEqual(collectQueryFields(q, graph).unresolvedEntries, []);
  assert.ok(org.requests.includes("Name"));
});

test("Polymorphic pseudo-name support is case insensitive", async () => {
  const graph = new RelationshipMap();
  graph.addParent("Case", "Owner", ["User", "Group"], "OwnerId", { namePointing: true });
  graph.registerPolymorphicNameFields(["tYpE", "ISACTIVE"]);
  assert.equal(graph.resolveField("case", "owner.type")?.polymorphicNamePseudoField, true);
  assert.equal(graph.resolveField("Case", "Owner.IsActive")?.polymorphicNamePseudoField, true);
  assert.equal(graph.resolveField("Case", "Owner.Name")?.object, "Name",
    "existing Name compatibility behavior remains supported");
});

test("Unknown polymorphic field does not become a false permission grant", async () => {
  const org = fakeOrg();
  const graph = new RelationshipMap();
  const q = parse("SELECT Owner.Nonexistent__c FROM Case");
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph).hydrateQuery(q);
  const c = collectQueryFields(q, graph);
  assert.ok(c.unresolvedEntries.length > 0);
  assert.equal(graph.resolveField("Case", "Owner.Nonexistent__c"), undefined);
});

test("Owner.Email and What.Custom__c remain unresolved despite Name descriptor fields", async () => {
  const org = fakeOrg();
  const graph = new RelationshipMap();
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph)
    .hydrateQuery(parse("SELECT Owner.Type FROM Case"));
  assert.equal(graph.resolveField("Case", "Owner.Email"), undefined,
    "do not silently assume a field's User/Group FLS from Name metadata alone");
  graph.addParent("Task", "What", ["Account", "Opportunity"], "WhatId",
    { namePointing: true });
  assert.equal(graph.resolveField("Task", "What.Custom_Field__c"), undefined);
});

test("Missing Name field metadata keeps the relationship unresolved", async () => {
  const org = fakeOrg({ missingFields: ["IsActive"] });
  const graph = new RelationshipMap();
  const q = parse("SELECT UserOrGroup.IsActive FROM GroupMember");
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph).hydrateQuery(q);
  assert.equal(graph.resolveField("GroupMember", "UserOrGroup.IsActive"), undefined);
  assert.equal(collectQueryFields(q, graph).unresolvedEntries.length, 1);
});

test("Unavailable Name Describe produces a warning and an unresolved Review", async () => {
  const org = fakeOrg({ missingName: true });
  const graph = new RelationshipMap();
  const q = parse("SELECT Owner.Type FROM Case");
  const warnings = await new SalesforceRelationshipMetadataService(org.connection)
    .createHydrator(graph).hydrateQuery(q);
  assert.ok(warnings.some(s => s.includes("Name")));
  assert.equal(graph.resolveField("Case", "Owner.Type"), undefined);
  assert.equal(collectQueryFields(q, graph).unresolvedEntries.length, 1);
});

test("Only one target is a normal relationship, not a polymorphic Name bypass", async () => {
  const org = fakeOrg({ singleOwner: true });
  const graph = new RelationshipMap();
  const q = parse("SELECT Owner.Type FROM Case");
  await new SalesforceRelationshipMetadataService(org.connection).createHydrator(graph).hydrateQuery(q);
  assert.equal(graph.resolveField("Case", "Owner.Type")?.object, "User");
  assert.equal(graph.resolveField("Case", "Owner.Type")?.polymorphicNamePseudoField, undefined);
  assert.ok(!org.requests.includes("Name"));
});

test("Ambiguous non-name-pointing multi-target relationship is not silently bypassed", () => {
  const graph = new RelationshipMap();
  graph.addParent("Custom__c", "Related__r", ["Account", "Opportunity"], "Related__c");
  graph.registerPolymorphicNameFields(["Type", "IsActive"]);
  assert.equal(graph.resolveField("Custom__c", "Related__r.IsActive"), undefined);
  assert.equal(graph.resolveField("Custom__c", "Related__r.Type"), undefined);
});

test("Real SOQL Security Analyzer reports no field FLS error for verified Name pseudo-fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-poly-uat-"));
  try {
    await writeFile(path.join(dir, "Polymorphic.cls-meta.xml"),
      "<ApexClass><apiVersion>66.0</apiVersion></ApexClass>");
    const granted = (object: string) => ({
      name: object + "_PS", label: "PS",
      objectPermissions: [{ object, allowRead: true, allowCreate: false, allowEdit: false,
        allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false }],
      fieldPermissions: [],
    });
    const persona: Persona = { name: "OMS Core", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
    const ps = [granted("Case"), granted("GroupMember")];
    const resolved = {
      persona, permissionSetGroups: [], directPermissionSets: ps,
      permissionSetGrants: ps.map(permissionSet => ({ permissionSet, type: "directPermissionSet" })),
      mutingPermissionSets: [], mutesByGroup: new Map(),
    } as unknown as ResolvedPersonaPermissions;
    const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
    const org = fakeOrg();
    const analyzer = new SoqlSecurityAnalyzer(resolver, dir, undefined, undefined,
      new SalesforceRelationshipMetadataService(org.connection));
    const q = [
      parse("SELECT Id FROM Case WHERE Owner.Type = 'User' WITH USER_MODE"),
      parse("SELECT Id FROM GroupMember WHERE UserOrGroup.IsActive = true WITH USER_MODE"),
    ];
    const findings = await analyzer.analyze(persona, q);
    assert.deepEqual(findings, [], "verified source-object Read suffices without imaginary target FLS");
    assert.ok(org.requests.includes("Name"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Live Describe metadata absent leaves a relationship finding in the Excel assessment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-poly-review-"));
  try {
    const persona: Persona = { name: "OMS Core", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
    const ps = { name: "Case_PS", label: "PS", objectPermissions: [
      { object: "Case", allowRead: true, allowCreate: false, allowEdit: false,
        allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false },
    ], fieldPermissions: [] };
    const resolved = {
      persona, permissionSetGroups: [], directPermissionSets: [ps],
      permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
      mutingPermissionSets: [], mutesByGroup: new Map(),
    } as unknown as ResolvedPersonaPermissions;
    const org = fakeOrg({ missingName: true });
    const analyzer = new SoqlSecurityAnalyzer({ resolve: async () => resolved } as unknown as PersonaPermissionResolver,
      dir, undefined, undefined, new SalesforceRelationshipMetadataService(org.connection));
    const findings = await analyzer.analyze(persona, [parse("SELECT Owner.Type FROM Case")]);
    assert.ok(findings.some(f => f.findingType === "RELATIONSHIP" && f.criticality === "Unable to verify"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
