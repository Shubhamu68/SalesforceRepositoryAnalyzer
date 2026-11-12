import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceEffectivePermissionVerifier } from "../src/salesforce/SalesforceEffectivePermissionVerifier.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import type { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";

const first = "005000000000001";
const second = "005000000000002";
const profile = "00e000000000001";
const profilePS = "0PS000000000001";
const directPS = "0PS000000000002";
const persona = { name: "Administrator", profile: "Administrator", permissionSets: ["PS_A"],
  permissionSetGroups: [], mutingPermissionSets: [] };

test("full org fallback combines effective object CRUD and profile/direct PS advanced permissions", async () => {
  const queries: string[] = [];
  const versions: Array<string | undefined> = [];
  const connection = {
    queryAll: async (query: string, _api: string, _limit: number, version?: string) => {
      queries.push(query);
      versions.push(version);
      if (query.includes("FROM UserEntityAccess")) {
        const user = query.includes(first) ? first : second;
        return [{ UserId: user, IsReadable: true, IsCreatable: true,
          IsEditable: user === first, IsDeletable: false }];
      }
      if (query.includes("FROM UserFieldAccess")) {
        const user = query.includes(first) ? first : second;
        return [{ UserId: user, IsAccessible: true, IsUpdatable: user === first,
          FieldDefinition: { QualifiedApiName: "Name" } }];
      }
      if (query.includes("FROM PermissionSetAssignment")) {
        return [{ AssigneeId: first, PermissionSetId: directPS, PermissionSetGroupId: null, IsActive: true },
          { AssigneeId: second, PermissionSetId: directPS, PermissionSetGroupId: null, IsActive: true },
          { AssigneeId: first, PermissionSetId: "X00e000000000001", PermissionSetGroupId: null, IsActive: true }];
      }
      if (query.includes("FROM PermissionSet WHERE ProfileId IN")) {
        return [{ Id: profilePS, ProfileId: profile, PermissionsViewAllData: false, PermissionsModifyAllData: false }];
      }
      if (query.includes("FROM PermissionSet WHERE Id IN")) {
        return [{ Id: directPS, ProfileId: null, PermissionsViewAllData: false, PermissionsModifyAllData: false }];
      }
      if (query.includes("PermissionsViewAllFields FROM ObjectPermissions")) {
        return [{ ParentId: directPS, PermissionsViewAllFields: true }];
      }
      if (query.includes("FROM ObjectPermissions")) {
        return [{ ParentId: profilePS, PermissionsViewAllRecords: true, PermissionsModifyAllRecords: false }];
      }
      throw new Error("Unexpected SOQL in test: " + query);
    },
  } as unknown as SalesforceOrgConnection;
  const matcher = {
    getVerificationScope: () => "org1",
    matchingActiveUsersForConsensus: async () => ({
      eligibleUsers: 2, users: [{ id: first, profileId: profile }, { id: second, profileId: profile }],
    }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const verifier = new SalesforceEffectivePermissionVerifier(connection, matcher);
  const object = await verifier.verifyObject(persona, "Account");
  assert.equal(object.read.source, "ORG_VERIFIED");
  assert.equal(object.create.source, "ORG_VERIFIED");
  assert.equal(object.edit.source, "UNVERIFIED");
  assert.match(object.edit.message, /Mixed Salesforce access/);
  assert.equal(object.delete.source, "ORG_DENIED");
  assert.equal(object.viewAllRecords.source, "ORG_VERIFIED");
  assert.equal(object.modifyAllRecords.source, "ORG_DENIED");
  assert.equal(object.viewAllFields.source, "ORG_VERIFIED");
  assert.ok(versions.includes("v63.0"), "View All Fields must use Salesforce API v63+");
  assert.ok(queries.some((query) => query.includes("PermissionSetAssignment")), "direct PS assignments queried");
  const field = await verifier.verifyField(persona, "Account", "Name");
  assert.equal(field.read.source, "ORG_VERIFIED");
  assert.equal(field.edit.source, "UNVERIFIED");
  assert.match(field.edit.message, /Mixed Salesforce access/);
});

test("failed advanced permissions retrieval produces Review without hiding successful CRUD", async () => {
  const connection = {
    queryAll: async (query: string) => {
      if (query.includes("FROM UserEntityAccess")) return [{
        UserId: first, IsReadable: true, IsCreatable: true, IsEditable: true, IsDeletable: true,
      }];
      throw new Error("INSUFFICIENT_ACCESS: org permission metadata API unavailable");
    },
  } as unknown as SalesforceOrgConnection;
  const matcher = {
    getVerificationScope: () => "org2",
    matchingActiveUsersForConsensus: async () => ({ eligibleUsers: 1,
      users: [{ id: first, profileId: profile }] }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const verifier = new SalesforceEffectivePermissionVerifier(connection, matcher);
  const result = await verifier.verifyObject(persona, "Account");
  assert.equal(result.read.source, "ORG_VERIFIED");
  assert.equal(result.create.source, "ORG_VERIFIED");
  assert.equal(result.viewAllRecords.source, "UNVERIFIED");
  assert.match(result.viewAllRecords.message, /INSUFFICIENT_ACCESS/);
});
