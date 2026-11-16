import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceUserFieldAccessGateway, compoundParentFromDescribe } from "../src/salesforce/SalesforceUserFieldAccessGateway.js";
import { SalesforceEffectivePermissionVerifier } from "../src/salesforce/SalesforceEffectivePermissionVerifier.js";
import type { SalesforceOrgConnection, SalesforceSObjectDescribe } from "../src/salesforce/SalesforceOrgConnection.js";
import type { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";

const user = "005000000000001";
const otherUser = "005000000000002";
const person = { name: "OMS OTC", profile: "CSR", permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };

function fields(): SalesforceSObjectDescribe["fields"] {
  return [
    { name: "BillingAddress", type: "address" },
    { name: "BillingCity", type: "string", compoundFieldName: "BillingAddress" },
    { name: "BillingCountry", type: "string", compoundFieldName: "BillingAddress" },
    { name: "ShippingAddress", type: "address" },
    { name: "ShippingCity", type: "string" },
    { name: "Industry", type: "picklist" },
    { name: "Custom_Address__c", type: "address" },
    { name: "Custom_Address__City__s", type: "string" },
    { name: "Coordinates__c", type: "location" },
    { name: "Coordinates__Latitude__s", type: "double" },
  ];
}

type Access = { read?: boolean | null; edit?: boolean | null };
type FakeOptions = {
  access: Record<string, Access>;
  descriptions?: SalesforceSObjectDescribe["fields"];
  throwDescribe?: boolean;
  throwExactField?: string;
  duplicateField?: string;
  omitBroad?: boolean;
};
function fakeOrg(options: FakeOptions) {
  const calls: string[] = [];
  let describes = 0;
  let scope = "00D000000000001";
  const connection = {
    get status() {
      return { organizationId: scope, instanceUrl: "https://example.my.salesforce.com" };
    },
    async describeSObject(object: string) {
      describes++;
      if (options.throwDescribe) throw new Error("Describe metadata unavailable");
      return { name: object, fields: options.descriptions ?? fields(), childRelationships: [] };
    },
    async queryAll<T>(soql: string): Promise<T[]> {
      calls.push(soql);
      if (!soql.includes("FROM UserFieldAccess")) throw Error("Unexpected SOQL " + soql);
      const exact = /AND FieldDefinition\.QualifiedApiName = '([^']+)'/.exec(soql);
      if (exact && options.throwExactField === exact[1]) throw new Error("Tooling API query failed");
      const queryUser = soql.includes(otherUser) ? otherUser : user;
      const records = Object.entries(options.access)
        .filter(([field]) => !exact || field.toLowerCase() === exact[1].toLowerCase())
        .filter(() => Boolean(exact) || !options.omitBroad)
        .map(([field, access]) => ({
          UserId: queryUser,
          FieldDefinition: { QualifiedApiName: field },
          ...(access.read !== undefined ? { IsAccessible: access.read } : {}),
          ...(access.edit !== undefined ? { IsUpdatable: access.edit } : {}),
        }));
      if (options.duplicateField) {
        const row = records.find((record) =>
          record.FieldDefinition.QualifiedApiName === options.duplicateField);
        if (row) records.push({ ...row, IsAccessible: row.IsAccessible === true ? false : true });
      }
      return records as T[];
    },
  };
  return {
    connection: connection as unknown as SalesforceOrgConnection,
    calls,
    get describes() { return describes; },
    setScope(value: string) { scope = value; },
  };
}

test("Describe explicitly identifies compound parents without guessing from field names", () => {
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "billingcity"), "BillingAddress");
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "BillingCountry"), "BillingAddress");
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "shippingcity"), "ShippingAddress");
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "Custom_Address__City__s"), "Custom_Address__c");
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "Coordinates__Latitude__s"), "Coordinates__c");
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "Industry"), null);
  assert.equal(compoundParentFromDescribe({ fields: fields() }, "NotAField"), null);
  assert.equal(compoundParentFromDescribe({ fields: [
    { name: "FakeAddress", type: "string" }, { name: "FakeCity", compoundFieldName: "FakeAddress" },
  ] }, "FakeCity"), null);
  assert.equal(compoundParentFromDescribe({ fields: [
    { name: "BillingAddress", type: "string" }, { name: "BillingCity" },
  ] }, "BillingCity"), null);
  assert.equal(compoundParentFromDescribe({ fields: [
    { name: "BillingCity", compoundFieldName: "NotPresent" }, { name: "BillingAddress", type: "address" },
  ] }, "BillingCity"), null);
});

test("BillingCity and BillingCountry reuse verified BillingAddress, not its edit flag", async () => {
  const org = fakeOrg({ access: { BillingAddress: { read: true, edit: true } } });
  const gateway = new SalesforceUserFieldAccessGateway(org.connection);
  const city = await gateway.verifyUserField(user, "Account", "BillingCity");
  const country = await gateway.verifyUserField(user, "Account", "BillingCountry");
  assert.deepEqual(city, { read: true, edit: null, readFromCompoundParent: "BillingAddress" });
  assert.deepEqual(country, { read: true, edit: null, readFromCompoundParent: "BillingAddress" });
  assert.equal(org.describes, 1, "only one Describe per object");
  assert.equal(org.calls.filter((q) => !q.includes("AND FieldDefinition.QualifiedApiName = ")).length, 1,
    "one object-wide UserFieldAccess query");
  assert.equal(org.calls.filter((q) => q.includes("AND FieldDefinition.QualifiedApiName = 'BillingAddress'")).length, 0,
    "parent from broad lookup should be reused");
});

test("Exact component read=true or denied=false always beats compound parent", async () => {
  for (const direct of [true, false]) {
    const org = fakeOrg({ access: {
      BillingAddress: { read: !direct }, BillingCity: { read: direct, edit: false },
    } });
    const result = await new SalesforceUserFieldAccessGateway(org.connection).verifyUserField(user, "Account", "BillingCity");
    assert.deepEqual(result, { read: direct, edit: false });
    assert.equal(org.describes, 0);
  }
});

test("Parent denial, missing parent, absent Describe, and non-compound fields stay inconclusive", async () => {
  const cases: FakeOptions[] = [
    { access: { BillingAddress: { read: false } } },
    { access: {} },
    { access: { BillingAddress: { read: true } }, throwDescribe: true },
    { access: { BillingAddress: { read: true } }, descriptions: [{ name: "BillingCity" }] },
  ];
  for (const options of cases) {
    const org = fakeOrg(options);
    const resolution = await new SalesforceUserFieldAccessGateway(org.connection)
      .verifyUserField(user, "Account", "BillingCity");
    assert.deepEqual(resolution, { read: null, edit: null });
  }
  const ordinary = fakeOrg({ access: { BillingAddress: { read: true } } });
  assert.deepEqual(
    await new SalesforceUserFieldAccessGateway(ordinary.connection).verifyUserField(user, "Account", "Industry"),
    { read: null, edit: null });
});

test("Conflicting direct component rows cannot be overridden by a parent grant", async () => {
  const org = fakeOrg({ access: {
    BillingCity: { read: true }, BillingAddress: { read: true },
  }, duplicateField: "BillingCity" });
  const resolution = await new SalesforceUserFieldAccessGateway(org.connection)
    .verifyUserField(user, "Account", "BillingCity");
  assert.deepEqual(resolution, { read: null, edit: null });
  assert.equal(org.describes, 0);
});

test("A failed exact field lookup does not turn parent access into a synthetic grant", async () => {
  const org = fakeOrg({ access: { BillingAddress: { read: true } },
    omitBroad: true, throwExactField: "BillingCity" });
  const result = await new SalesforceUserFieldAccessGateway(org.connection)
    .verifyUserField(user, "Account", "BillingCity");
  assert.deepEqual(result, { read: null, edit: null });
  assert.equal(org.describes, 0);
});

test("Field gateway caches are scoped to the Salesforce org", async () => {
  const org = fakeOrg({ access: { BillingAddress: { read: true } } });
  const gateway = new SalesforceUserFieldAccessGateway(org.connection);
  await gateway.verifyUserField(user, "Account", "BillingCity");
  assert.equal(org.describes, 1);
  org.setScope("00D000000000002");
  await gateway.verifyUserField(user, "Account", "BillingCity");
  assert.equal(org.describes, 2, "a different Salesforce org must not reuse metadata");
});

test("Access Checker/Matrix verify compound component Read across every matched user", async () => {
  const org = fakeOrg({ access: { BillingAddress: { read: true, edit: false } } });
  const matcher = {
    getVerificationScope: () => "org",
    matchingActiveUsersForConsensus: async () => ({
      eligibleUsers: 2, users: [
        { id: user, profileId: "00e000000000001" },
        { id: otherUser, profileId: "00e000000000001" },
      ],
    }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const common = new SalesforceUserFieldAccessGateway(org.connection);
  const verifier = new SalesforceEffectivePermissionVerifier(org.connection, matcher, common);
  const result = await verifier.verifyField(person, "Account", "BillingCity");
  assert.equal(result.read.source, "ORG_VERIFIED");
  assert.match(result.read.message, /compound parent Account\.BillingAddress/);
  assert.equal(result.read.checkedUsers, 2);
  assert.equal(result.edit.source, "UNVERIFIED", "parent edit cannot imply component edit");
  assert.equal(org.describes, 1, "same Describe reused for all matched users");
});

test("Mixed direct and parent Read remains independently verified, not a denial", async () => {
  const org = fakeOrg({ access: { BillingAddress: { read: true } } });
  const matcher = {
    getVerificationScope: () => "org",
    matchingActiveUsersForConsensus: async () => ({
      eligibleUsers: 2, users: [{ id: user, profileId: "00e000000000001" },
        { id: otherUser, profileId: "00e000000000001" }],
    }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const result = await new SalesforceEffectivePermissionVerifier(org.connection, matcher,
    new SalesforceUserFieldAccessGateway(org.connection)).verifyField(person, "Account", "BillingCountry");
  assert.equal(result.read.source, "ORG_VERIFIED");
});
