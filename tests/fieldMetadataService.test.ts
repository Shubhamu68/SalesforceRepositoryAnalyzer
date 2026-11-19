import assert from "node:assert/strict";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { PersonaFieldAccessService } from "../src/services/PersonaFieldAccessService.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlQuery } from "../src/models/SoqlQuery.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "node:test";
import { SalesforceFieldMetadataService, compoundNameParentFromMetadata, compoundParentFromMetadata } from "../src/salesforce/SalesforceFieldMetadataService.js";
import { SalesforceUserFieldAccessGateway } from "../src/salesforce/SalesforceUserFieldAccessGateway.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";

const user = "005000000000001";
const rows = (name: string) => [
  { QualifiedApiName: "Name", DataType: "string", IsPermissionable: false, IsComponent: false, IsCompound: true },
  { QualifiedApiName: "FirstName", DataType: "string", IsPermissionable: false, IsComponent: true, IsCompound: false },
  { QualifiedApiName: "LastName", DataType: "string", IsPermissionable: false, IsComponent: true, IsCompound: false },
  ...(name === "OrderDeliveryGroup" ? [
    { QualifiedApiName: "DeliverToFullName", DataType: "string", IsPermissionable: false, IsComponent: false, IsCompound: true },
    { QualifiedApiName: "DeliverToFullFirstName", DataType: "string", IsPermissionable: false, IsComponent: true, IsCompound: false },
    { QualifiedApiName: "DeliverToFullLastName", DataType: "string", IsPermissionable: false, IsComponent: true, IsCompound: false },
  ] : []),
  { QualifiedApiName: "Industry", DataType: "picklist", IsPermissionable: true, IsComponent: false, IsCompound: false },
  { QualifiedApiName: "Custom__c", DataType: "string", IsPermissionable: true, IsComponent: false, IsCompound: false },
];
function makeOrg(settings: {
  denyMetadata?: boolean;
  metadataRows?: ReturnType<typeof rows>;
  userRows?: Array<{ UserId: string; IsAccessible: boolean | null; FieldDefinition: { QualifiedApiName: string } }>;
  describeFields?: Array<{ name: string; type: string; compoundFieldName?: string; permissionable?: boolean }>;
} = {}) {
  let orgId = "00D000000000001";
  let queriedMetadata = 0;
  let queriedAccess = 0;
  let described = 0;
  const connection = {
    get status() { return { connected: true, organizationId: orgId, instanceUrl: "https://fake.my.salesforce.com" }; },
    async queryAll<T>(soql: string): Promise<T[]> {
      if (soql.includes("FROM EntityParticle")) {
        queriedMetadata++;
        if (settings.denyMetadata) throw new Error("ViewSetup permission missing");
        const name = /QualifiedApiName = '([^']+)'/.exec(soql)?.[1] ?? "User";
        return (settings.metadataRows ?? rows(name)) as T[];
      }
      if (soql.includes("FROM UserFieldAccess")) {
        queriedAccess++;
        const exact = /AND FieldDefinition\.QualifiedApiName = '([^']+)'/.exec(soql)?.[1];
        return (settings.userRows ?? []).filter((item) =>
          !exact || item.FieldDefinition.QualifiedApiName.toLowerCase() === exact.toLowerCase()) as T[];
      }
      throw new Error("Unexpected SOQL " + soql);
    },
    async describeSObject(name: string) {
      described++;
      return {
        name,
        fields: settings.describeFields ?? [
          { name: "Name", type: "string" },
          { name: "FirstName", type: "string", compoundFieldName: "Name" },
          { name: "LastName", type: "string", compoundFieldName: "Name" },
          { name: "Industry", type: "picklist" },
        ],
        childRelationships: [],
      };
    },
  };
  return {
    connection: connection as unknown as SalesforceOrgConnection,
    get metadataCalls() { return queriedMetadata; },
    get accessCalls() { return queriedAccess; },
    get describeCalls() { return described; },
    switchOrg(id: string) { orgId = id; },
  };
}

test("live non-permissionable OrderDeliveryGroup name component does not require FLS", async () => {
  const org = makeOrg();
  const service = new SalesforceFieldMetadataService(org.connection);
  const info = await service.getField("OrderDeliveryGroup", "DeliverToFullLastName");
  assert.deepEqual(info, { permissionable: false, source: "LIVE",
    dataType: "string", isComponent: true, isCompound: false });
  assert.equal(await service.getCompoundNameParent("OrderDeliveryGroup", "DeliverToFullLastName"), "DeliverToFullName");
  assert.equal(await service.getCompoundNameParent("OrderDeliveryGroup", "DeliverToFullFirstName"), "DeliverToFullName");
  assert.equal(org.metadataCalls, 1, "object-wide EntityParticle results must be reused");
});

test("User, Contact, Lead and Individual genuine Name components are metadata-driven", async () => {
  for (const object of ["User", "Contact", "Lead", "Individual", "Account"]) {
    const org = makeOrg();
    const metadata = new SalesforceFieldMetadataService(org.connection);
    for (const component of ["FirstName", "LastName"]) {
      assert.equal((await metadata.getField(object, component)).permissionable, false);
      assert.equal(await metadata.getCompoundNameParent(object, component), "Name");
    }
    assert.equal(org.metadataCalls, 1, object);
  }
});

test("Name-looking strings are not compounds without IsComponent=true and IsCompound=true", () => {
  const map = new Map([
    ["namE".toLowerCase(), { source: "LIVE" as const, permissionable: false, isCompound: true }],
    ["customlastname", { source: "LIVE" as const, permissionable: true, isComponent: false }],
    ["firstName".toLowerCase(), { source: "LIVE" as const, permissionable: true, isComponent: true }],
  ]);
  assert.equal(compoundNameParentFromMetadata(map, "CustomLastName"), null);
  assert.equal(compoundNameParentFromMetadata(map, "FirstName"), "Name");
  map.set("name", { source: "LIVE", permissionable: false, isCompound: false });
  assert.equal(compoundNameParentFromMetadata(map, "FirstName"), null);
});

test("live permissionable=true overrides stale snapshot=false for a standard field", async () => {
  const org = makeOrg({ metadataRows: [
    { QualifiedApiName: "Name", IsPermissionable: true, IsComponent: false, IsCompound: false, DataType: "string" },
  ] });
  const service = new SalesforceFieldMetadataService(org.connection);
  const value = await service.getField("Account", "Name");
  assert.equal(value.source, "LIVE");
  assert.equal(value.permissionable, true);
});

test("successful online object metadata excludes absent fields instead of trusting another org snapshot", async () => {
  const org = makeOrg({ metadataRows: [] });
  const service = new SalesforceFieldMetadataService(org.connection);
  const value = await service.getField("Account", "Name");
  assert.deepEqual(value, { permissionable: undefined, source: "UNKNOWN" });
  assert.equal(org.metadataCalls, 1);
});

test("failed live metadata without an explicitly scoped cache stays UNKNOWN, never grants access", async () => {
  const org = makeOrg({ denyMetadata: true });
  const service = new SalesforceFieldMetadataService(org.connection);
  assert.deepEqual(await service.getField("Account", "Name"), { permissionable: undefined, source: "UNKNOWN" });
  assert.deepEqual(await service.getField("User", "FirstName"), { permissionable: undefined, source: "UNKNOWN" });
  assert.equal(org.metadataCalls, 2, "failed per-object queries may be cached independently");
});

test("REST Describe resolves non-permissionable custom Address components when Tooling metadata fails", async () => {
  const object = "Order_Changes__c";
  const parent = "Bill_To_Address__c";
  const component = "Bill_To_Address__City__s";
  const org = makeOrg({
    denyMetadata: true,
    describeFields: [
      { name: parent, type: "address", permissionable: true },
      { name: component, type: "string", compoundFieldName: parent, permissionable: false },
    ],
  });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  assert.deepEqual(await metadata.getField(object, component),
    { permissionable: false, dataType: "string", source: "LIVE" });
  const gateway = new SalesforceUserFieldAccessGateway(org.connection, metadata);
  assert.deepEqual(await gateway.verifyUserField(user, object, component),
    { read: true, edit: null, nonPermissionableSource: "LIVE" });
  assert.equal(org.accessCalls, 0, "component requires no separate UserFieldAccess query");
  assert.equal(org.describeCalls, 1, "one object-level REST Describe is reused");

  const temp = await mkdtemp(path.join(os.tmpdir(), "sf-address-describe-"));
  try {
    const analyzer = new SoqlSecurityAnalyzer(repoResolver(object), temp,
      undefined, undefined, undefined, metadata);
    const findings = await analyzer.analyze(analysisPersona, [query(object, component)]);
    assert.deepEqual(findings, [], "object Read alone suffices for non-permissionable component");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("REST Describe can classify fields absent from a successful Tooling object response", async () => {
  const org = makeOrg({
    metadataRows: [],
    describeFields: [{ name: "Bill_Ship_Address__PostalCode__s", type: "string", permissionable: false }],
  });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  assert.equal((await metadata.getField("Order_Changes__c", "Bill_Ship_Address__PostalCode__s")).permissionable, false);
  assert.equal(org.metadataCalls, 1);
  assert.equal(org.describeCalls, 1);
});

test("current-org Tooling permissionability takes precedence over contradictory REST Describe data", async () => {
  const org = makeOrg({
    metadataRows: [
      { QualifiedApiName: "Bill_To_Address__City__s", DataType: "string",
        IsPermissionable: true, IsComponent: true, IsCompound: false },
    ],
    describeFields: [
      { name: "Bill_To_Address__City__s", type: "string", permissionable: false },
    ],
  });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  assert.equal((await metadata.getField("Order_Changes__c", "Bill_To_Address__City__s")).permissionable, true);
  assert.equal(org.describeCalls, 0, "authoritative Tooling evidence is not overwritten");
});

test("REST Describe permissionable=true never invents field Read when user access is denied", async () => {
  const component = "Bill_To_Address__Street__s";
  const org = makeOrg({
    denyMetadata: true,
    describeFields: [{ name: component, type: "string", permissionable: true }],
    userRows: [{ UserId: user, IsAccessible: false, FieldDefinition: { QualifiedApiName: component } }],
  });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  assert.equal((await metadata.getField("Order_Changes__c", component)).permissionable, true);
  const gateway = new SalesforceUserFieldAccessGateway(org.connection, metadata);
  assert.deepEqual(await gateway.verifyUserField(user, "Order_Changes__c", component),
    { read: false, edit: null });
});

test("cache keys include Salesforce org and avoid metadata leakage when switching orgs", async () => {
  const org = makeOrg();
  const service = new SalesforceFieldMetadataService(org.connection);
  await Promise.all(Array.from({ length: 12 }, () => service.getField("User", "FirstName")));
  assert.equal(org.metadataCalls, 1);
  org.switchOrg("00D000000000002");
  await service.getField("User", "FirstName");
  assert.equal(org.metadataCalls, 2);
});

test("direct UserFieldAccess gateway uses non-permissionable live metadata without a field FLS query", async () => {
  const org = makeOrg();
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const gateway = new SalesforceUserFieldAccessGateway(org.connection, metadata);
  const result = await gateway.verifyUserField(user, "OrderDeliveryGroup", "DeliverToFullLastName");
  assert.deepEqual(result, { read: true, edit: null, nonPermissionableSource: "LIVE" });
  assert.equal(org.accessCalls, 0);
});

test("permissionable field never inherits a grant from Name unless component/parent metadata is proven", async () => {
  const row = rows("User").map((item) =>
    item.QualifiedApiName === "FirstName" ? { ...item, IsPermissionable: true } : item);
  const org = makeOrg({ metadataRows: row, userRows: [
    { UserId: user, IsAccessible: true, FieldDefinition: { QualifiedApiName: "Name" } },
  ] });
  const meta = new SalesforceFieldMetadataService(org.connection);
  const gateway = new SalesforceUserFieldAccessGateway(org.connection, meta);
  const found = await gateway.verifyUserField(user, "User", "FirstName");
  assert.deepEqual(found, { read: true, edit: null, readFromCompoundParent: "Name" });
  assert.ok(org.accessCalls > 0);
});

test("live custom Address components inherit parent Read when Describe omits compound metadata", async () => {
  const parent = "Bill_Ship_Address__c";
  const component = "Bill_Ship_Address__City__s";
  const org = makeOrg({
    metadataRows: [
      { QualifiedApiName: parent, DataType: "address", IsPermissionable: true, IsComponent: false, IsCompound: true },
      { QualifiedApiName: component, DataType: "string", IsPermissionable: true, IsComponent: true, IsCompound: false },
    ],
    userRows: [{ UserId: user, IsAccessible: true, FieldDefinition: { QualifiedApiName: parent } }],
    // Salesforce may omit a useful compoundFieldName and parent from Describe.
    describeFields: [{ name: component, type: "string" }],
  });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const gateway = new SalesforceUserFieldAccessGateway(org.connection, metadata);
  assert.equal(await metadata.getCompoundParent("Order_Changes__c", component), parent);
  assert.deepEqual(await gateway.verifyUserField(user, "Order_Changes__c", component),
    { read: true, edit: null, readFromCompoundParent: parent });
  assert.equal(org.metadataCalls, 1, "object metadata should be fetched once");
});

test("custom Address parent Read resolves a null direct component row but never overrides direct denial", async () => {
  const parent = "Bill_To_Address__c";
  const component = "Bill_To_Address__CountryCode__s";
  const metadataRows = [
    { QualifiedApiName: parent, DataType: "address", IsPermissionable: true, IsComponent: false, IsCompound: true },
    { QualifiedApiName: component, DataType: "string", IsPermissionable: true, IsComponent: true, IsCompound: false },
  ];
  for (const directAccess of [null, false]) {
    const org = makeOrg({
      metadataRows,
      userRows: [
        { UserId: user, IsAccessible: directAccess, FieldDefinition: { QualifiedApiName: component } },
        { UserId: user, IsAccessible: true, FieldDefinition: { QualifiedApiName: parent } },
      ],
      describeFields: [{ name: component, type: "string", compoundFieldName: parent },
        { name: parent, type: "address" }],
    });
    const gateway = new SalesforceUserFieldAccessGateway(org.connection,
      new SalesforceFieldMetadataService(org.connection));
    const effective = await gateway.verifyUserField(user, "Order_Changes__c", component);
    assert.equal(effective.read, directAccess === null ? true : false);
    assert.equal(effective.readFromCompoundParent, directAccess === null ? parent : undefined);
  }
});

test("address-like field names alone never authorize compound Read", () => {
  const parent = "Bill_To_Address__c";
  const component = "Bill_To_Address__City__s";
  const fields = new Map([
    [parent.toLowerCase(), { source: "LIVE" as const, permissionable: true, isCompound: true, dataType: "address" }],
    [component.toLowerCase(), { source: "LIVE" as const, permissionable: true, isComponent: false }],
  ]);
  assert.equal(compoundParentFromMetadata(fields, component), null);
});

test("parent Name denial cannot establish component FLS denial", async () => {
  const row = rows("User").map((item) =>
    item.QualifiedApiName === "FirstName" ? { ...item, IsPermissionable: true } : item);
  const org = makeOrg({ metadataRows: row, userRows: [
    { UserId: user, IsAccessible: false, FieldDefinition: { QualifiedApiName: "Name" } },
  ] });
  const gateway = new SalesforceUserFieldAccessGateway(org.connection,
    new SalesforceFieldMetadataService(org.connection));
  assert.deepEqual(await gateway.verifyUserField(user, "User", "FirstName"),
    { read: null, edit: null });
});

test("missing or failed Name compound metadata does not yield inferred FLS Read", async () => {
  const org = makeOrg({ denyMetadata: true, userRows: [
    { UserId: user, IsAccessible: true, FieldDefinition: { QualifiedApiName: "Name" } },
  ] });
  const gateway = new SalesforceUserFieldAccessGateway(org.connection,
    new SalesforceFieldMetadataService(org.connection));
  assert.deepEqual(await gateway.verifyUserField(user, "User", "FirstName"),
    { read: null, edit: null });
});

test("OrgObjectReadVerificationService establishes non-permissionable FLS only after caller checks object Read", async () => {
  const org = makeOrg();
  const meta = new SalesforceFieldMetadataService(org.connection);
  const verifier = {
    verifyFieldRead: async () => { throw new Error("Should not verify individual FLS"); },
  } as unknown as SalesforcePersonaAccessVerifier;
  const service = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, verifier, meta);
  const persona = { name: "OTC", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const result = await service.resolveFieldRead(persona, "OrderDeliveryGroup", "DeliverToFullLastName", false);
  assert.equal(result.readable, true);
  assert.equal(result.source, "ORG_VERIFIED");
  assert.match(result.message, /non-permissionable/i);
});

test("permissionable custom field remains eligible for normal Salesforce FLS checks", async () => {
  const org = makeOrg();
  const meta = new SalesforceFieldMetadataService(org.connection);
  const calls: string[] = [];
  const verifier = {
    verifyFieldRead: async (_persona: unknown, object: string, field: string) => {
      calls.push(object + "." + field);
      return { outcome: "DENIED", object, field, matchedUsers: 1, checkedUsers: 1,
        sampled: false, message: "Direct FLS denial" };
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  const service = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, verifier, meta);
  const persona = { name: "OTC", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const result = await service.resolveFieldRead(persona, "User", "Custom__c", false);
  assert.equal(result.source, "ORG_DENIED");
  assert.deepEqual(calls, ["User.Custom__c"]);
});

const analysisPersona: Persona = {
  name: "OTC", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [],
};
function repoResolver(object: string): PersonaPermissionResolver {
  const permissionSet = {
    name: "Test_PS", label: "Test_PS",
    objectPermissions: [{ object, allowRead: true, allowCreate: false,
      allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }],
    fieldPermissions: [],
  };
  const resolved = {
    persona: analysisPersona, permissionSetGroups: [], directPermissionSets: [permissionSet],
    permissionSetGrants: [{ permissionSet, type: "directPermissionSet" }],
    mutingPermissionSets: [], mutesByGroup: new Map(),
  } as unknown as ResolvedPersonaPermissions;
  return { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
}
function query(object: string, field: string): SoqlQuery {
  return {
    object, fields: [field], lineNumber: 10, filePath: "classes/NameTest.cls",
    query: `SELECT ${field} FROM ${object} WITH USER_MODE`,
    securityMode: "USER_MODE", withUserMode: true, subqueries: [],
  };
}

test("SOQL Security Analyzer uses live non-permissionable metadata for OrderDeliveryGroup names", async () => {
  const org = makeOrg();
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const temp = await mkdtemp(path.join(os.tmpdir(), "sf-name-fls-"));
  try {
    const analyzer = new SoqlSecurityAnalyzer(repoResolver("OrderDeliveryGroup"), temp,
      undefined, undefined, undefined, metadata);
    const result = await analyzer.analyze(analysisPersona,
      [query("OrderDeliveryGroup", "DeliverToFullLastName")]);
    assert.deepEqual(result, [], "no false field-level Review when object Read is established");
    assert.equal(org.metadataCalls, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("SOQL keeps permissionable=true fields in FLS evaluation despite stale snapshot=false", async () => {
  const org = makeOrg({ metadataRows: [
    { QualifiedApiName: "DeliverToFullLastName", IsPermissionable: true,
      IsComponent: false, IsCompound: false, DataType: "string" },
  ] });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const temp = await mkdtemp(path.join(os.tmpdir(), "sf-name-true-"));
  try {
    const analyzer = new SoqlSecurityAnalyzer(repoResolver("OrderDeliveryGroup"), temp,
      undefined, undefined, undefined, metadata);
    const findings = await analyzer.analyze(analysisPersona,
      [query("OrderDeliveryGroup", "DeliverToFullLastName")]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "REVIEW", "no invented grant for permissionable field");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Access Checker evaluates live non-permissionable Name component using object Read", async () => {
  const org = makeOrg();
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const service = new PersonaFieldAccessService(repoResolver("User"), undefined, undefined, metadata);
  const result = await service.getFieldAccess(analysisPersona, "User", "FirstName");
  assert.equal(result.read, true);
  assert.equal(result.permissionable, false);
  assert.equal(result.edit, false, "non-permissionable doesn't prove Edit access");
});

test("without live metadata, an unknown User name field remains unverified", async () => {
  const org = makeOrg({ denyMetadata: true });
  const metadata = new SalesforceFieldMetadataService(org.connection);
  const service = new PersonaFieldAccessService(repoResolver("User"), undefined, undefined, metadata);
  const result = await service.getFieldAccess(analysisPersona, "User", "FirstName");
  assert.equal(result.read, false);
  assert.equal(result.permissionable, undefined);
});
