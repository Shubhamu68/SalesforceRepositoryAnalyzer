import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

const ids = {
  p: "00e000000000001",
  u1: "005000000000001",
  u2: "005000000000002",
};

test("full-consensus matcher identifies ALL active persona users including never-logged-in users", async () => {
  const fakeConnection = {
    connect: async () => {},
    status: { organizationId: "00D000000000001", instanceUrl: "https://example.my.salesforce.com" },
  } as unknown as SalesforceOrgConnection;
  const verifier = new SalesforcePersonaAccessVerifier(fakeConnection);
  const inventory = {
    profiles: [{ id: ids.p, name: "Administrator" }],
    users: [
      { id: ids.u1, profileId: ids.p, lastLoginDate: "2026-11-11T12:00:00Z" },
      { id: ids.u2, profileId: ids.p, lastLoginDate: null },
    ],
    userDetails: new Map([
      [ids.u1, { id: ids.u1, name: "User 1", username: "one@example.com" }],
      [ids.u2, { id: ids.u2, name: "User 2", username: "two@example.com" }],
    ]),
    assignments: new Map([
      [ids.u1, { userId: ids.u1, permissionSets: new Set(["required_ps"]), permissionSetGroups: new Set(["required_psg"]) }],
      [ids.u2, { userId: ids.u2, permissionSets: new Set(["required_ps"]), permissionSetGroups: new Set(["required_psg"]) }],
    ]),
    knownPermissionSetNames: new Set(["required_ps"]),
    knownGroupNames: new Set(["required_psg"]),
    unclassifiedAssignmentsByUser: new Map(),
  };
  Object.assign(verifier, {
    inventoryCache: { key: verifier.getVerificationScope(), until: Date.now() + 60000, value: inventory },
  });
  const persona = {
    name: "Administrator", profile: "Administrator",
    permissionSets: ["Required_PS"], permissionSetGroups: ["Required_PSG"], mutingPermissionSets: [],
  };
  const matched = await verifier.matchingActiveUsersForConsensus(persona);
  assert.equal(matched.eligibleUsers, 2);
  assert.deepEqual(matched.users.map((u) => u.id).sort(), [ids.u1, ids.u2]);
  assert.equal(matched.users.some((user) => user.detail.username === "two@example.com"), true);
  await assert.rejects(verifier.matchingActiveUsersForConsensus(persona, 1), /needs review|requires review|limit is 1/i);
});

test("full-consensus matcher rejects unknown configured PS instead of guessing by profile alone", async () => {
  const fakeConnection = {
    connect: async () => {},
    status: { organizationId: "00D000000000001", instanceUrl: "https://example.my.salesforce.com" },
  } as unknown as SalesforceOrgConnection;
  const verifier = new SalesforcePersonaAccessVerifier(fakeConnection);
  Object.assign(verifier, {
    inventoryCache: { key: verifier.getVerificationScope(), until: Date.now() + 60000,
      value: { profiles: [{ id: ids.p, name: "Administrator" }], users: [],
        userDetails: new Map(), assignments: new Map(), knownPermissionSetNames: new Set(),
        knownGroupNames: new Set(), unclassifiedAssignmentsByUser: new Map() } },
  });
  await assert.rejects(verifier.matchingActiveUsersForConsensus({
    name: "Administrator", profile: "Administrator", permissionSets: ["Missing_PS"], permissionSetGroups: [], mutingPermissionSets: [],
  }), /Required.*assignments not found|Configured Salesforce assignments not found/);
});
