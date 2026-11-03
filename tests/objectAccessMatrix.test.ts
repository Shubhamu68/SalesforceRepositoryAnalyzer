import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePermissionSetGroup } from "../src/parser/permissionSetGroupParser.js";
import type { PermissionSet } from "../src/models/PermissionSet.js";
import type { PermissionSetGroup } from "../src/models/PermissionSetGroup.js";
import type { ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import { calculateMatrixPersona } from "../src/services/ObjectAccessMatrixService.js";

function permissionSet(name: string, values: Partial<{
  read: boolean; create: boolean; edit: boolean; delete: boolean;
  viewAllRecords: boolean; modifyAllRecords: boolean; viewAllFields: boolean;
}>): PermissionSet {
  return {
    name, label: name, fieldPermissions: [],
    objectPermissions: [{
      object: "Account",
      allowRead: values.read ?? false,
      allowCreate: values.create ?? false,
      allowEdit: values.edit ?? false,
      allowDelete: values.delete ?? false,
      viewAllRecords: values.viewAllRecords ?? false,
      modifyAllRecords: values.modifyAllRecords ?? false,
      viewAllFields: values.viewAllFields ?? false,
    }],
  };
}

function resolved(groups: PermissionSetGroup[], direct: PermissionSet[] = []): ResolvedPersonaPermissions {
  return {
    persona: { name: "Customer Service", permissionSetGroups: groups.map((g) => g.name), permissionSets: direct.map((p) => p.name), mutingPermissionSets: [] },
    permissionSetGroups: groups,
    directPermissionSets: direct,
    mutingPermissionSets: [],
    permissionSetGrants: [],
  };
}

function group(name: string, ...permissionSets: PermissionSet[]): PermissionSetGroup {
  return { name, label: name, permissionSets, permissionSetNames: permissionSets.map((ps) => ps.name), mutingPermissionSetNames: [] };
}

test("reports all seven permission grants with individual sources", () => {
  const ps = permissionSet("PS_All", { read: true, create: true, edit: true, delete: true, viewAllRecords: true, modifyAllRecords: true, viewAllFields: true });
  const entry = calculateMatrixPersona("account", resolved([group("PSG_One", ps)]), new Map());
  for (const key of ["read", "create", "edit", "delete", "viewAllRecords", "modifyAllRecords", "viewAllFields"] as const) {
    assert.equal(entry.access[key], true, key);
    assert.equal(entry.sources[key].grantedBy[0]?.permissionSet, "PS_All", key);
    assert.equal(entry.sources[key].grantedBy[0]?.permissionSetGroup, "PSG_One", key);
  }
});

test("a PSG mute affects its group but leaves direct PS and other PSG grants", () => {
  const grouped = permissionSet("Group_PS", { read: true, delete: true, modifyAllRecords: true });
  const other = permissionSet("Other_PS", { read: true });
  const direct = permissionSet("Direct_PS", { read: true, delete: true });
  const mute = permissionSet("Group_Muted", { read: true, delete: true, modifyAllRecords: true });
  const entry = calculateMatrixPersona(
    "Account",
    resolved([group("Group_A", grouped), group("Group_B", other)], [direct]),
    new Map([["Group_A", [mute]]])
  );
  assert.equal(entry.access.read, true);
  assert.deepEqual(entry.sources.read.grantedBy.map((source) => source.permissionSet), ["Other_PS", "Direct_PS"]);
  assert.equal(entry.sources.read.mutedBy[0]?.mutingPermissionSet, "Group_Muted");
  assert.deepEqual(entry.sources.read.mutedBy[0]?.affectedPermissionSets, ["Group_PS"]);
  assert.equal(entry.access.delete, true); // Direct assignment restores Delete.
  assert.equal(entry.sources.delete.grantedBy[0]?.type, "directPermissionSet");
  assert.equal(entry.access.modifyAllRecords, false);
  assert.deepEqual(entry.sources.modifyAllRecords.grantedBy, []);
  assert.equal(entry.sources.modifyAllRecords.mutedBy[0]?.permissionSetGroup, "Group_A");
});

test("returns no access for an object missing from all configured grants", () => {
  const entry = calculateMatrixPersona("Contact", resolved([group("Group", permissionSet("PS", { read: true }))]), new Map());
  assert.equal(Object.values(entry.access).some(Boolean), false);
  assert.equal(entry.sources.read.grantedBy.length, 0);
  assert.equal(entry.sources.read.mutedBy.length, 0);
});

test("muting Read removes dependent object permissions within its PSG", () => {
  const all = permissionSet("Group_All", {
    read: true, create: true, edit: true, delete: true,
    viewAllRecords: true, modifyAllRecords: true,
  });
  const mutedRead = permissionSet("Read_Muted", { read: true });
  const entry = calculateMatrixPersona("Account", resolved([group("G", all)]), new Map([["G", [mutedRead]]]));
  for (const key of ["read", "create", "edit", "delete", "viewAllRecords", "modifyAllRecords"] as const) {
    assert.equal(entry.access[key], false, key);
    assert.equal(entry.sources[key].mutedBy[0]?.mutingPermissionSet, "Read_Muted", key);
  }
});

test("PSG XML parsing retains muting permission set association", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "sf-matrix-test-"));
  try {
    const psDir = path.join(base, "permissionsets");
    await mkdir(psDir);
    await writeFile(path.join(psDir, "Base_PS.permissionset-meta.xml"),
      `<PermissionSet><label>Base PS</label><objectPermissions><object>Account</object><allowRead>true</allowRead></objectPermissions></PermissionSet>`);
    const groupPath = path.join(base, "Example.permissionsetgroup-meta.xml");
    await writeFile(groupPath,
      `<PermissionSetGroup><label>Example</label><permissionSets>Base_PS</permissionSets><mutingPermissionSets>Example_Muted</mutingPermissionSets></PermissionSetGroup>`);
    const group = await parsePermissionSetGroup(groupPath, psDir);
    assert.deepEqual(group.mutingPermissionSetNames, ["Example_Muted"]);
    assert.equal(group.permissionSets.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
