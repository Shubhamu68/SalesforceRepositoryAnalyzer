import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PersonaFieldAccessService } from "../src/services/PersonaFieldAccessService.js";
import { OrgPermissionFallbackService } from "../src/services/OrgPermissionFallbackService.js";
import { permissionPresentation } from "../web/src/components/permissionPresentation.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";
import type { Persona } from "../src/models/Persona.js";
import type { OrgPermissionEvidence } from "../src/salesforce/SalesforceEffectivePermissionVerifier.js";
import { MATRIX_PERMISSION_KEYS, type MatrixPermission } from "../src/models/ObjectAccessMatrixResult.js";

const persona: Persona = {
  name: "Administrator", profile: "Administrator", permissionSets: [],
  permissionSetGroups: ["Order_Management_Administrator_PS_Group"], mutingPermissionSets: [],
};
type PermissionFlags = { read?: boolean; edit?: boolean };
const ps = (
  name: string, object: string, objectFlags: PermissionFlags = {},
  fieldFlags: PermissionFlags = {}, system: Record<string, boolean> = {},
): PermissionSet => ({
  name, label: name, userPermissions: system,
  objectPermissions: [{
    object, allowRead: objectFlags.read ?? false, allowCreate: false,
    allowEdit: objectFlags.edit ?? false, allowDelete: false,
    viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
  }],
  fieldPermissions: [
    { field: object + ".Additional_Information__c",
      readable: fieldFlags.read ?? false, editable: fieldFlags.edit ?? false },
  ],
});
const profile = (entry: PermissionSet) => ({ permissionSet: entry, type: "profile" as const });
const group = (entry: PermissionSet) => ({
  permissionSet: entry, type: "permissionSetGroup" as const,
  permissionSetGroup: "Order_Management_Administrator_PS_Group",
});
function resolver(...grants: Array<ReturnType<typeof profile> | ReturnType<typeof group>>) {
  const resolved = {
    persona, permissionSetGroups: [], directPermissionSets: [],
    permissionSetGrants: grants, mutingPermissionSets: [], mutesByGroup: new Map(),
  } as unknown as ResolvedPersonaPermissions;
  return { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
}
const orgEvidence = (status: OrgPermissionEvidence["source"]): OrgPermissionEvidence => ({
  source: status,
  outcome: status === "ORG_VERIFIED" ? "VERIFIED" : status === "ORG_DENIED" ? "DENIED" : "UNVERIFIED",
  matchedUsers: 1, checkedUsers: status === "UNVERIFIED" ? 0 : 1,
  message: status === "ORG_VERIFIED" ? "Salesforce verified the permission." :
    status === "ORG_DENIED" ? "Salesforce denied the permission." :
    "Salesforce verification unavailable.",
});
function orgResult(read: OrgPermissionEvidence["source"], edit: OrgPermissionEvidence["source"]) {
  return Object.fromEntries(MATRIX_PERMISSION_KEYS.map((key) =>
    [key, orgEvidence(key === "read" ? read : key === "edit" ? edit : "UNVERIFIED")])) as Record<MatrixPermission, OrgPermissionEvidence>;
}
function service(
  granted: PersonaPermissionResolver,
  mode?: {
    objectRead: OrgPermissionEvidence["source"];
    objectEdit: OrgPermissionEvidence["source"];
    fieldRead?: OrgPermissionEvidence["source"];
    fieldEdit?: OrgPermissionEvidence["source"];
  },
) {
  let fieldCalls = 0;
  let objectCalls = 0;
  const fallback = new OrgPermissionFallbackService(mode ? {
    verifyObject: async () => {
      objectCalls++;
      return orgResult(mode.objectRead, mode.objectEdit);
    },
    verifyField: async () => {
      fieldCalls++;
      return { read: orgEvidence(mode.fieldRead ?? "UNVERIFIED"),
        edit: orgEvidence(mode.fieldEdit ?? "UNVERIFIED") };
    },
  } : undefined);
  return {
    access: new PersonaFieldAccessService(granted, undefined, fallback),
    counters: () => ({ fieldCalls, objectCalls }),
  };
}
const check = (access: { read: boolean; edit: boolean;
  permissionEvidence?: Partial<Record<"read" | "edit", {source: "REPOSITORY"|"ORG_VERIFIED"|"ORG_DENIED"|"UNVERIFIED"; message: string}>> }) => ({
  read: permissionPresentation(access.read, access.permissionEvidence?.read),
  edit: permissionPresentation(access.edit, access.permissionEvidence?.edit),
});

test("Issue #19: Administrator field grants from PSG + object verified in Salesforce show Yes with neutral org provenance", async () => {
  const admin = ps("OMS_Administrator_Read_Write_Access", "ProcessException", {}, { read: true, edit: true });
  const { access, counters } = service(resolver(group(admin)),
    { objectRead: "ORG_VERIFIED", objectEdit: "ORG_VERIFIED" });
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  const display = check(result);
  assert.deepEqual([display.read.label, display.edit.label], ["Yes", "Yes"]);
  assert.equal(display.read.orgVerified, true);
  assert.equal(display.edit.orgVerified, true);
  assert.equal(result.readGrantedBy[0]?.permissionSet, "OMS_Administrator_Read_Write_Access");
  assert.equal(result.editGrantedBy[0]?.permissionSetGroup, "Order_Management_Administrator_PS_Group");
  assert.match(result.permissionEvidence!.read!.message, /Object read: Salesforce.*Field read: repository metadata/);
  assert.match(result.permissionEvidence!.edit!.message, /Object edit: Salesforce.*Field edit: repository metadata/);
  assert.deepEqual(counters(), { fieldCalls: 0, objectCalls: 1 });
});

test("Issue #19: Team Lead repository Read grant stays Yes; Salesforce-confirmed missing Edit FLS remains No", async () => {
  const base = ps("Team Lead", "Account", {read:true, edit:true}, {read:true, edit:false});
  const { access, counters } = service(resolver(profile(base)), {
    objectRead: "ORG_VERIFIED", objectEdit: "ORG_VERIFIED",
    fieldRead: "ORG_VERIFIED", fieldEdit: "ORG_DENIED",
  });
  const result = await access.getFieldAccess(persona, "Account", "Additional_Information__c");
  const display = check(result);
  assert.equal(display.read.label, "Yes");
  assert.equal(display.read.orgVerified, false, "repository-backed grant is not marked as org-only");
  assert.equal(display.edit.label, "No");
  assert.equal(result.permissionEvidence?.edit?.source, "ORG_DENIED");
  assert.match(result.permissionEvidence!.edit!.message, /missing field edit/);
  assert.deepEqual(counters(), { fieldCalls: 1, objectCalls: 1 });
});

test("Issue #19: missing credentials must not show Edit = No for unverified object and known FLS", async () => {
  const admin = ps("OMS_Administrator_Read_Write_Access", "ProcessException", {}, { read: true, edit: true });
  const { access } = service(resolver(group(admin)));
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  const display = check(result);
  assert.deepEqual([display.read.label, display.edit.label], ["Review", "Review"]);
  assert.match(display.edit.title, /Object edit not established/);
  assert.match(display.read.title, /Object read not established/);
});

test("Issue #19: fully established repository object/field grants display Yes without org marker or calls", async () => {
  const admin = ps("Admin", "ProcessException", {read:true, edit:true}, {read:true, edit:true});
  const { access, counters } = service(resolver(profile(admin)), {
    objectRead: "ORG_DENIED", objectEdit: "ORG_DENIED",
    fieldRead: "ORG_DENIED", fieldEdit: "ORG_DENIED",
  });
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  const display = check(result);
  assert.deepEqual([display.read.label, display.edit.label], ["Yes", "Yes"]);
  assert.equal(display.read.orgVerified, false);
  assert.equal(display.edit.orgVerified, false);
  assert.deepEqual(counters(), { fieldCalls: 0, objectCalls: 1 },
    "unrelated missing object privileges may require a bulk object verification call");
});

test("Issue #19: ViewAllData grants object Read but does not invent FLS Read or Edit", async () => {
  const admin = ps("Administrator", "ProcessException", {}, {}, {viewalldata: true});
  const { access } = service(resolver(profile(admin)));
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  const display = check(result);
  assert.equal(display.read.label, "Review");
  assert.equal(display.edit.label, "Review");
  assert.equal(result.readGrantedBy.length, 0);
});

test("Issue #19: ModifyAllData + explicit FLS grants yields repository-backed Read/Edit", async () => {
  const admin = ps("Administrator", "ProcessException", {}, {read:true, edit:true}, {modifyalldata:true});
  const { access } = service(resolver(profile(admin)));
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  assert.deepEqual([check(result).read.label, check(result).edit.label], ["Yes", "Yes"]);
  assert.equal(check(result).read.orgVerified, false);
});

test("Issue #19: disconnected org, no profile permissions, and no FLS grant both remain Review", async () => {
  const admin = ps("Administrator", "ProcessException");
  const { access } = service(resolver(profile(admin)));
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  assert.deepEqual([check(result).read.label, check(result).edit.label], ["Review", "Review"]);
  assert.match(check(result).read.title, /Object.*not established/);
  assert.match(check(result).edit.title, /Field.*not established/);
});

test("Issue #19: confirmed object denial overrides affirmative repository FLS without invented grant", async () => {
  const admin = ps("Admin", "ProcessException", {}, {read:true, edit:true});
  const { access } = service(resolver(profile(admin)),
    {objectRead:"ORG_DENIED", objectEdit:"ORG_DENIED"});
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  assert.deepEqual([check(result).read.label, check(result).edit.label], ["No", "No"]);
  assert.match(check(result).read.title, /missing object read/);
});

test("Issue #19: object Read verified, Edit unavailable -> Yes for Read and Review for Edit", async () => {
  const admin = ps("Admin", "ProcessException", {}, {read:true, edit:true});
  const { access } = service(resolver(profile(admin)), {
    objectRead:"ORG_VERIFIED", objectEdit:"UNVERIFIED",
  });
  const result = await access.getFieldAccess(persona, "ProcessException", "Additional_Information__c");
  assert.deepEqual([check(result).read.label, check(result).edit.label], ["Yes", "Review"]);
  assert.equal(check(result).read.orgVerified, true);
});

test("field status icons use neutral org provenance; unknown remains Review, denial remains No", async () => {
  const component = await readFile(new URL("../web/src/components/PermissionIndicator.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../web/src/App.css", import.meta.url), "utf8");
  const matrix = await readFile(new URL("../web/src/components/ObjectAccessMatrix.tsx", import.meta.url), "utf8");
  assert.match(component, /permission-org-verified-marker/);
  assert.doesNotMatch(component, /permission-org-warning|>⚠</);
  assert.match(app, /permission-org-verified-marker/);
  assert.match(app, /matrix-org-verified\{background:#eaf2fe/);
  assert.match(matrix, /ⓘ = Salesforce-verified grant/);
  const review = permissionPresentation(false);
  assert.equal(review.label, "Review");
  assert.equal(permissionPresentation(false, orgEvidence("ORG_DENIED")).label, "No");
  assert.equal(permissionPresentation(true, orgEvidence("ORG_VERIFIED")).orgVerified, true);
});
