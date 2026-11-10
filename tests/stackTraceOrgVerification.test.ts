import assert from "node:assert/strict";
import test from "node:test";
import { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { Persona } from "../src/models/Persona.js";

const persona: Persona = {
  name: "OMS View Only", profile: "OMS Standard User",
  permissionSets: [], permissionSetGroups: [], mutingPermissionSets: []
};
const profileId = "00e000000000001";
const userId = "005000000000001";

function fakeConnection(options: { users: boolean; disconnected?: boolean; access?: boolean }) {
  const queries: string[] = [];
  const connection = {
    status: { organizationId: "00D000000000001", instanceUrl: "https://test.example" },
    async connect() {
      if (options.disconnected) throw new Error("Connection unavailable");
    },
    async queryAll<T>(soql: string): Promise<T[]> {
      queries.push(soql);
      if (soql.startsWith("SELECT Id, Name FROM Profile")) return [{ Id: profileId, Name: "OMS Standard User" }] as T[];
      if (soql.startsWith("SELECT Id, DeveloperName FROM PermissionSetGroup")) return [];
      if (soql.startsWith("SELECT Id, Name, Username, ProfileId FROM User")) return options.users
        ? [{ Id: userId, Name: "Demo User", Username: "demo@example.org", ProfileId: profileId }] as T[] : [];
      if (soql.startsWith("SELECT Id, Name, IsOwnedByProfile FROM PermissionSet")) return [];
      if (soql.startsWith("SELECT AssigneeId, PermissionSetId")) return [];
      if (soql.includes("FROM UserEntityAccess")) return [{ UserId: userId, IsReadable: options.access ?? true }] as T[];
      return [];
    }
  };
  return { connection: connection as unknown as SalesforceOrgConnection, queries };
}

test("empty persona match is explicitly unavailable, not denied", async () => {
  const { connection } = fakeConnection({ users: false });
  const verifier = new SalesforcePersonaAccessVerifier(connection);
  const result = await verifier.verifyObjectRead(persona, "OrderItemSummary");
  assert.equal(result.outcome, "UNVERIFIED");
  assert.equal(result.unverifiedReason, "NO_MATCHING_USERS");
  assert.equal(result.checkedUsers, 0);
});

test("Salesforce connection error is not incorrectly labeled as no matching user", async () => {
  const { connection } = fakeConnection({ users: false, disconnected: true });
  const verifier = new SalesforcePersonaAccessVerifier(connection);
  const result = await verifier.verifyObjectRead(persona, "OrderItemSummary");
  assert.equal(result.outcome, "UNVERIFIED");
  assert.equal(result.unverifiedReason, undefined);
});

test("verified Salesforce object access is unchanged and persona match is cached", async () => {
  const { connection, queries } = fakeConnection({ users: true, access: true });
  const verifier = new SalesforcePersonaAccessVerifier(connection);
  const one = await verifier.verifyObjectRead(persona, "OrderItemSummary");
  const two = await verifier.verifyObjectRead(persona, "OrderSummary");
  assert.equal(one.outcome, "VERIFIED");
  assert.equal(two.outcome, "VERIFIED");
  assert.equal(one.checkedUserDetails?.[0].username, "demo@example.org");
  assert.equal(queries.filter((soql) => soql.includes("FROM Profile")).length, 1);
});

test("Salesforce denial stays a denial", async () => {
  const { connection } = fakeConnection({ users: true, access: false });
  const verifier = new SalesforcePersonaAccessVerifier(connection);
  const result = await verifier.verifyObjectRead(persona, "OrderItemSummary");
  assert.equal(result.outcome, "DENIED");
  assert.equal(result.unverifiedReason, undefined);
});
