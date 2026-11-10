import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePermissionSet } from '../src/parser/permissionSetParser.js';
import { parseProfile } from '../src/parser/profileParser.js';
import { parseMutingPermissionSet } from '../src/parser/mutingPermissionSetParser.js';
import { parsePermissionSetGroup } from '../src/parser/permissionSetGroupParser.js';
import { PersonaPermissionResolver } from '../src/analyzer/PersonaPermissionResolver.js';
import { createPersonaAccessEvaluator } from '../src/analyzer/personaAccessEvaluator.js';

const permissionXml = (root: string, read = true) => `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Example access</label>
  <objectPermissions><object>Account</object><allowCreate>false</allowCreate><allowRead>${read}</allowRead><allowEdit>false</allowEdit><allowDelete>false</allowDelete><viewAllRecords>false</viewAllRecords><modifyAllRecords>false</modifyAllRecords></objectPermissions>
  <fieldPermissions><field>Account.Custom_Field__c</field><readable>${read}</readable><editable>false</editable></fieldPermissions>
  <userPermissions><name>ViewAllData</name><enabled>false</enabled></userPermissions>
</${root}>`;

async function folders<T>(fn: (root: string, dirs: { ps: string; psg: string; mute: string; profile: string }) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-xml-test-'));
  const dirs = { ps: path.join(root, 'permissionsets'), psg: path.join(root, 'permissionsetgroups'),
    mute: path.join(root, 'mutingpermissionsets'), profile: path.join(root, 'profiles') };
  try { for (const dir of Object.values(dirs)) await mkdir(dir); return await fn(root, dirs); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('Permission Set XML parses object and field permissions', async () => {
  await folders(async (_root, dirs) => {
    const file = path.join(dirs.ps, 'Access.permissionset-meta.xml');
    await writeFile(file, permissionXml('PermissionSet'));
    const result = await parsePermissionSet(file);
    assert.equal(result.name, 'Access');
    assert.equal(result.objectPermissions[0].allowRead, true);
    assert.equal(result.objectPermissions[0].allowEdit, false);
    assert.equal(result.fieldPermissions[0].readable, true);
    assert.equal(result.userPermissions?.viewalldata, false);
  });
});

test('Profile XML uses the same effective permission sections', async () => {
  await folders(async (_root, dirs) => {
    const file = path.join(dirs.profile, 'CSR.profile-meta.xml');
    await writeFile(file, permissionXml('Profile'));
    const parsed = await parseProfile(file);
    assert.equal(parsed.name, 'CSR');
    assert.equal(parsed.objectPermissions[0].object, 'Account');
  });
});

test('Muting Permission Set XML is parsed independently', async () => {
  await folders(async (_root, dirs) => {
    const file = path.join(dirs.mute, 'Mute.mutingpermissionset-meta.xml');
    await writeFile(file, permissionXml('MutingPermissionSet'));
    const parsed = await parseMutingPermissionSet(file);
    assert.equal(parsed.fieldPermissions[0].field, 'Account.Custom_Field__c');
  });
});

test('Malformed permission metadata fails explicitly', async () => {
  await folders(async (_root, dirs) => {
    const file = path.join(dirs.ps, 'Invalid.permissionset-meta.xml');
    await writeFile(file, '<NotPermissionSet />');
    await assert.rejects(parsePermissionSet(file), /Invalid PermissionSet XML/);
  });
});

test('PSG XML resolves member permission sets and associated muting names', async () => {
  await folders(async (_root, dirs) => {
    await writeFile(path.join(dirs.ps, 'Access.permissionset-meta.xml'), permissionXml('PermissionSet'));
    const xml = `<PermissionSetGroup><label>Group</label><permissionSets>Access</permissionSets><mutingPermissionSets>Mute</mutingPermissionSets></PermissionSetGroup>`;
    const file = path.join(dirs.psg, 'Team.permissionsetgroup-meta.xml');
    await writeFile(file, xml);
    const parsed = await parsePermissionSetGroup(file, dirs.ps);
    assert.deepEqual(parsed.permissionSetNames, ['Access']);
    assert.deepEqual(parsed.mutingPermissionSetNames, ['Mute']);
    assert.equal(parsed.permissionSets.length, 1);
  });
});

test('Persona permission resolver attaches Profile, PSG, direct PS, and correct mute scope', async () => {
  await folders(async (_root, dirs) => {
    await writeFile(path.join(dirs.ps, 'Access.permissionset-meta.xml'), permissionXml('PermissionSet'));
    await writeFile(path.join(dirs.profile, 'CSR.profile-meta.xml'), permissionXml('Profile', false));
    await writeFile(path.join(dirs.mute, 'Mute.mutingpermissionset-meta.xml'), permissionXml('MutingPermissionSet'));
    await writeFile(path.join(dirs.psg, 'Team.permissionsetgroup-meta.xml'),
      '<PermissionSetGroup><label>Team</label><permissionSets>Access</permissionSets><mutingPermissionSets>Mute</mutingPermissionSets></PermissionSetGroup>');
    const resolver = new PersonaPermissionResolver(dirs.ps, dirs.psg, dirs.mute, dirs.profile);
    const result = await resolver.resolve({ name: 'OTC', profile: 'CSR', permissionSetGroups: ['Team'],
      permissionSets: ['Access'], mutingPermissionSets: [] });
    assert.equal(result.permissionSetGrants.length, 3);
    assert.equal(result.mutesByGroup.get('Team')?.[0].name, 'Mute');
    assert.equal(createPersonaAccessEvaluator(result).evaluateObject('Account').access.read, true);
  });
});

test('Invalid Profile path is rejected before file IO', async () => {
  await folders(async (_root, dirs) => {
    const resolver = new PersonaPermissionResolver(dirs.ps, dirs.psg, dirs.mute, dirs.profile);
    await assert.rejects(resolver.resolve({ name: 'Unsafe', profile: '../secret', permissionSetGroups: [],
      permissionSets: [], mutingPermissionSets: [] }), /Invalid profile metadata name/);
  });
});

test('Missing Profile fails loudly rather than silently treating missing metadata as denial', async () => {
  await folders(async (_root, dirs) => {
    const resolver = new PersonaPermissionResolver(dirs.ps, dirs.psg, dirs.mute, dirs.profile);
    await assert.rejects(resolver.resolve({ name: 'OTC', profile: 'MissingProfile', permissionSetGroups: [],
      permissionSets: [], mutingPermissionSets: [] }), /could not be loaded/);
  });
});
