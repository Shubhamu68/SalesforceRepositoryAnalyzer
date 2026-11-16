import assert from "node:assert/strict";
import test from "node:test";
import { matchPersonaUsers, selectMostRecentlyLoggedInMatchedUser, type OrgUser } from "../src/salesforce/OrgPersonaMatcher.js";
import { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { Persona } from "../src/models/Persona.js";

const profile = "00e000000000001";
const wrongProfile = "00e000000000002";
const psId = "0PS000000000001";
const groupId = "0F9000000000001";
const older = "005000000000001";
const latest = "005000000000002";
const never = "005000000000003";
const otherProfile = "005000000000004";
const missingGroup = "005000000000005";
const target: Persona = {
  name: "OFA Core", profile: "CSR", permissionSets: ["RequiredPS"],
  permissionSetGroups: ["RequiredGroup"], mutingPermissionSets: [],
};

type User = { Id: string; Name: string; Username: string; ProfileId: string; LastLoginDate?: string | null; IsActive: boolean };
const data: User[] = [
  { Id: older, Name: "Old", Username: "old@example.com", ProfileId: profile, LastLoginDate: "2026-07-01T12:00:00.000Z", IsActive: true },
  { Id: latest, Name: "Current", Username: "current@example.com", ProfileId: profile, LastLoginDate: "2026-11-10T18:00:00.000Z", IsActive: true },
  { Id: never, Name: "Never", Username: "never@example.com", ProfileId: profile, LastLoginDate: null, IsActive: true },
  { Id: otherProfile, Name: "Other", Username: "other@example.com", ProfileId: wrongProfile, LastLoginDate: "2026-11-11T20:00:00.000Z", IsActive: true },
  { Id: missingGroup, Name: "No PSG", Username: "no-psg@example.com", ProfileId: profile, LastLoginDate: "2026-11-12T20:00:00.000Z", IsActive: true },
];

type Fixtures = { users?: User[]; objectAccess?: Record<string, boolean | null>; fieldAccess?: Record<string, boolean | null>; connectFails?: boolean };
function fakeOrg(options: Fixtures = {}) {
  const users = options.users ?? data;
  const queries: string[] = [];
  const connection = {
    status: { organizationId: "00D000000000001", instanceUrl: "https://my-org.example" },
    async connect() { if (options.connectFails) throw new Error("Salesforce connection unavailable"); },
    async queryAll<T>(soql: string): Promise<T[]> {
      queries.push(soql);
      if (soql.startsWith("SELECT Id, Name FROM Profile")) return [
        { Id: profile, Name: "CSR" }, { Id: wrongProfile, Name: "Wrong" },
      ] as T[];
      if (soql.startsWith("SELECT Id, DeveloperName FROM PermissionSetGroup")) return [
        { Id: groupId, DeveloperName: "RequiredGroup" },
      ] as T[];
      if (soql.startsWith("SELECT Id, Name, Username, ProfileId, LastLoginDate FROM User")) {
        return users.filter((user) => user.IsActive) as T[];
      }
      if (soql.startsWith("SELECT Id, Name, IsOwnedByProfile FROM PermissionSet")) return [
        { Id: psId, Name: "RequiredPS", IsOwnedByProfile: false },
      ] as T[];
      if (soql.includes("FROM PermissionSetAssignment")) {
        const subset = users.filter((user) => user.IsActive && soql.includes(user.Id));
        return subset.flatMap((user) => user.Id === missingGroup ? [
          { AssigneeId: user.Id, PermissionSetId: psId, PermissionSetGroupId: null },
        ] : [
          { AssigneeId: user.Id, PermissionSetId: psId, PermissionSetGroupId: null },
          { AssigneeId: user.Id, PermissionSetId: null, PermissionSetGroupId: groupId },
        ]) as T[];
      }
      if (soql.includes("FROM UserEntityAccess")) {
        const id = users.map((user) => user.Id).find((candidate) => soql.includes(candidate));
        if (!id) return [];
        const access = options.objectAccess?.[id] ?? true;
        return access === null ? [] : [{ UserId: id, IsReadable: access }] as T[];
      }
      if (soql.includes("FROM UserFieldAccess")) {
        const id = users.map((user) => user.Id).find((candidate) => soql.includes(candidate));
        if (!id) return [];
        const access = options.fieldAccess?.[id] ?? true;
        return access === null ? [] : [{
          UserId: id, IsAccessible: access,
          FieldDefinition: { QualifiedApiName: "Sensitive__c" },
        }] as T[];
      }
      return [];
    },
  };
  return { connection: connection as unknown as SalesforceOrgConnection, queries };
}

test("Selects latest successful login, never-login users do not outrank it", () => {
  const users: OrgUser[] = [
    { id: older, profileId: profile, lastLoginDate: "2026-01-01T00:00:00Z" },
    { id: latest, profileId: profile, lastLoginDate: "2026-11-11T00:00:00Z" },
    { id: never, profileId: profile, lastLoginDate: null },
  ];
  assert.equal(selectMostRecentlyLoggedInMatchedUser([older, never, latest], users), latest);
});

test("Timestamp tie uses deterministic Salesforce ID tie-break", () => {
  const users: OrgUser[] = [
    { id: latest, profileId: profile, lastLoginDate: "2026-11-11T00:00:00Z" },
    { id: older, profileId: profile, lastLoginDate: "2026-11-11T00:00:00Z" },
  ];
  assert.equal(selectMostRecentlyLoggedInMatchedUser([latest, older], users), older);
});

test("Missing and invalid LastLoginDate values never select arbitrary users", () => {
  const users: OrgUser[] = [
    { id: latest, profileId: profile, lastLoginDate: null },
    { id: older, profileId: profile, lastLoginDate: "invalid-date" },
  ];
  assert.equal(selectMostRecentlyLoggedInMatchedUser([older, latest], users), undefined);
});

test("Persona profile/PS/PSG constraints are applied BEFORE recency selection", () => {
  const { queries, connection } = fakeOrg({ objectAccess: { [latest]: true, [older]: false, [otherProfile]: false, [missingGroup]: false } });
  return new SalesforcePersonaAccessVerifier(connection).verifyObjectRead(target, "OrderSummary").then((result) => {
    assert.equal(result.outcome, "VERIFIED");
    assert.equal(result.checkedUsers, 1);
    assert.equal(result.matchedUsers, 1);
    assert.equal(result.eligibleUsers, 3);
    assert.deepEqual(result.checkedUserDetails?.map((user) => user.username), ["current@example.com"]);
    assert.equal(result.checkedUserDetails?.[0].lastLoginDate, "2026-11-10T18:00:00.000Z");
    assert.equal(queries.filter((q) => q.includes("FROM UserEntityAccess")).length, 1);
    assert.ok(!queries.some((q) => q.includes("FROM UserEntityAccess") && q.includes(missingGroup)));
  });
});

test("Selected user's explicit object Read denial remains DENIED; no misleading counts", async () => {
  const { connection } = fakeOrg({ objectAccess: { [latest]: false, [older]: true } });
  const result = await new SalesforcePersonaAccessVerifier(connection).verifyObjectRead(target, "OrderSummary");
  assert.equal(result.outcome, "DENIED");
  assert.equal(result.message, "Salesforce denied OrderSummary object Read.");
  assert.doesNotMatch(result.message, /\d+ of \d+|matching active users/);
});

test("Field-level Read also uses the SAME newest matched user", async () => {
  const { connection, queries } = fakeOrg({ fieldAccess: { [latest]: false, [older]: true } });
  const result = await new SalesforcePersonaAccessVerifier(connection).verifyFieldRead(target, "OrderSummary", "Sensitive__c");
  assert.equal(result.outcome, "DENIED");
  assert.equal(result.message, "Salesforce denied OrderSummary.Sensitive__c field Read.");
  assert.equal(result.checkedUserDetails?.[0].username, "current@example.com");
  assert.ok(queries.some((q) => q.includes("FROM UserFieldAccess") && q.includes(latest)));
  assert.ok(!queries.some((q) => q.includes("FROM UserFieldAccess") && q.includes(older)));
});

test("No matched user's recorded login results in UNVERIFIED, not arbitrary selection", async () => {
  const { connection, queries } = fakeOrg({ users: data.map((user) => ({ ...user, LastLoginDate: null })) });
  const result = await new SalesforcePersonaAccessVerifier(connection).verifyObjectRead(target, "OrderSummary");
  assert.equal(result.outcome, "UNVERIFIED");
  assert.equal(result.unverifiedReason, "NO_LOGGED_IN_USERS");
  assert.equal(result.checkedUsers, 0);
  assert.equal(queries.filter((q) => q.includes("FROM UserEntityAccess")).length, 0);
});

test("The shared persona match is cached and the selected identity is stable across object checks", async () => {
  const { connection, queries } = fakeOrg();
  const verifier = new SalesforcePersonaAccessVerifier(connection);
  const a = await verifier.verifyObjectRead(target, "Account");
  const b = await verifier.verifyObjectRead(target, "OrderSummary");
  assert.equal(a.outcome, "VERIFIED");
  assert.equal(b.outcome, "VERIFIED");
  assert.equal(a.message, "Access verified from Salesforce.");
  assert.deepEqual(a.checkedUserDetails, b.checkedUserDetails);
  assert.equal(queries.filter((q) => q.includes("FROM Profile")).length, 1);
});

test("No persona match and org offline are distinct inconclusive outcomes", async () => {
  const { connection } = fakeOrg({ users: [] });
  const unmatched = await new SalesforcePersonaAccessVerifier(connection).verifyObjectRead(target, "OrderSummary");
  assert.equal(unmatched.outcome, "UNVERIFIED");
  assert.equal(unmatched.unverifiedReason, "NO_MATCHING_USERS");
  const { connection: offline } = fakeOrg({ connectFails: true });
  const unavailable = await new SalesforcePersonaAccessVerifier(offline).verifyObjectRead(target, "OrderSummary");
  assert.equal(unavailable.outcome, "UNVERIFIED");
  assert.equal(unavailable.unverifiedReason, undefined);
});

test("Matching across additional grants remains supported", () => {
  const profiles = [{ id: profile, name: "CSR" }];
  const users = [{ id: older, profileId: profile }, { id: latest, profileId: profile }];
  const assignments = new Map([
    [older, { userId: older, permissionSets: new Set(["requiredps", "extra"]), permissionSetGroups: new Set(["requiredgroup"]) }],
    [latest, { userId: latest, permissionSets: new Set(["requiredps"]), permissionSetGroups: new Set(["requiredgroup"]) }],
  ]);
  assert.equal(matchPersonaUsers(target, profiles, users, assignments).eligibleCount, 2);
});

test("SOQL/Stack Read verifier uses the shared compound gateway for parent-backed BillingCity", async () => {
  const { connection: original } = fakeOrg();
  const observed: string[] = [];
  const proxy = {
    status: original.status,
    connect: () => original.connect(),
    queryAll: async <T>(soql: string, api: "data" | "tooling" = "data", limit = 1000): Promise<T[]> => {
      if (soql.includes("FROM UserFieldAccess")) {
        observed.push(soql);
        const exact = soql.includes("AND FieldDefinition.QualifiedApiName = '");
        if (exact && !soql.includes("'BillingAddress'")) return [];
        return [{ UserId: latest, IsAccessible: true, IsUpdatable: false,
          FieldDefinition: { QualifiedApiName: "BillingAddress" } }] as T[];
      }
      return original.queryAll<T>(soql, api, limit);
    },
    describeSObject: async () => ({
      name: "Account",
      fields: [{ name: "BillingAddress", type: "address" },
        { name: "BillingCity", type: "string", compoundFieldName: "BillingAddress" }],
      childRelationships: [],
    }),
  } as unknown as SalesforceOrgConnection;
  const response = await new SalesforcePersonaAccessVerifier(proxy).verifyFieldRead(target, "Account", "BillingCity");
  assert.equal(response.outcome, "VERIFIED");
  assert.equal(response.compoundParent, "BillingAddress");
  assert.match(response.message, /compound parent Account\.BillingAddress/);
  assert.ok(observed.some((q) => q.includes("FROM UserFieldAccess")));
});
