import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonaAccessEvaluator } from '../src/analyzer/personaAccessEvaluator.js';
import type { ResolvedPersonaPermissions } from '../src/analyzer/PersonaPermissionResolver.js';
import type { PermissionSet } from '../src/models/PermissionSet.js';
import type { PermissionSetGrant } from '../src/models/PermissionSetGrant.js';

const persona = { name: 'Test', permissionSetGroups: [], permissionSets: [], mutingPermissionSets: [] };
function ps(name: string, object = 'Account', grants: Partial<PermissionSet['objectPermissions'][number]> = {}, fields: PermissionSet['fieldPermissions'] = [], system: Record<string, boolean> = {}): PermissionSet {
  return { name, label: name, objectPermissions: [{ object, allowRead: false, allowCreate: false,
    allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
    ...grants }], fieldPermissions: fields, userPermissions: system };
}
function resolved(grants: PermissionSetGrant[], mutes: Map<string, PermissionSet[]> = new Map()): ResolvedPersonaPermissions {
  return { persona, permissionSetGroups: [], directPermissionSets: [], permissionSetGrants: grants,
    mutingPermissionSets: [], mutesByGroup: mutes };
}
const direct = (permissionSet: PermissionSet): PermissionSetGrant => ({ permissionSet, type: 'directPermissionSet' });
const profile = (permissionSet: PermissionSet): PermissionSetGrant => ({ permissionSet, type: 'profile' });
const group = (permissionSet: PermissionSet, permissionSetGroup = 'Team'): PermissionSetGrant => ({ permissionSet, type: 'permissionSetGroup', permissionSetGroup });

test('Read, Create, Edit, Delete preserve individual object grants', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([direct(ps('Basic', 'Account', { allowRead: true, allowEdit: true }))]));
  const access = evaluator.evaluateObject('Account').access;
  assert.equal(access.read, true);
  assert.equal(access.edit, true);
  assert.equal(access.create, false);
  assert.equal(access.delete, false);
});

test('Object access is case-insensitive and case-variant requests are cached', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([direct(ps('Grant', 'OrderSummary', { allowRead: true }))]));
  assert.equal(evaluator.evaluateObject('ordersummary'), evaluator.evaluateObject('OrderSummary'));
});

test('Profile grants count towards object Read', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([profile(ps('CSR', 'Contact', { allowRead: true }))]));
  assert.equal(evaluator.evaluateObject('contact').access.read, true);
  assert.equal(evaluator.evaluateObject('Contact').sources.read.grantedBy[0].type, 'profile');
});

test('ViewAllData grants global Read without Edit', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([profile(ps('Profile', 'Contact', {}, [], { viewalldata: true }))]));
  assert.equal(evaluator.evaluateObject('OrderSummary').access.read, true);
  assert.equal(evaluator.evaluateObject('OrderSummary').access.viewAllRecords, true);
  assert.equal(evaluator.evaluateObject('OrderSummary').access.edit, false);
  assert.equal(evaluator.evaluateObject('OrderSummary').access.viewAllFields, false);
});

test('ModifyAllData grants global object CRUD, not View All Fields', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([profile(ps('Admin', 'Account', {}, [], { modifyalldata: true }))]));
  const result = evaluator.evaluateObject('OrderSummary').access;
  for (const permission of ['read', 'create', 'edit', 'delete', 'viewAllRecords', 'modifyAllRecords'] as const) {
    assert.equal(result[permission], true, permission);
  }
  assert.equal(result.viewAllFields, false);
});

test('View All Fields permits FLS Read but does not imply Field Edit', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([direct(ps('VAF', 'Account', { allowRead: true, viewAllFields: true }))]));
  const field = evaluator.evaluateField('Account.Custom_Restricted_Field__c');
  assert.equal(field.readable, true);
  assert.equal(field.editable, false);
});

test('Explicit field Read needs object Read to be effective', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([direct(ps('FieldOnly', 'Account', {}, [
    { field: 'Account.Custom_Restricted_Field__c', readable: true, editable: false },
  ]))]));
  const field = evaluator.evaluateField('Account.Custom_Restricted_Field__c');
  assert.equal(field.readable, false);
  assert.equal(field.readGrantedBy.length, 1);
});

test('Direct field grants are not muted by a different PSG', () => {
  const directPS = ps('Direct', 'Account', { allowRead: true }, [
    { field: 'Account.Custom_Restricted_Field__c', readable: true, editable: false },
  ]);
  const mutedGroup = ps('GroupMember', 'Account', { allowRead: true }, [
    { field: 'Account.Custom_Restricted_Field__c', readable: true, editable: false },
  ]);
  const mute = ps('GroupMute', 'Account', {}, [
    { field: 'Account.Custom_Restricted_Field__c', readable: true, editable: false },
  ]);
  const evaluator = createPersonaAccessEvaluator(resolved([group(mutedGroup), direct(directPS)], new Map([['Team', [mute]]])));
  const field = evaluator.evaluateField('Account.Custom_Restricted_Field__c');
  assert.equal(field.readable, true);
  assert.ok(field.readGrantedBy.some(source => source.type === 'directPermissionSet'));
  assert.ok(field.mutedBy.includes('GroupMute'));
});

test('PSG muting does not remove a Profile object grant', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([
    group(ps('GroupMember', 'Account', { allowRead: true })),
    profile(ps('CSR', 'Account', { allowRead: true })),
  ], new Map([['Team', [ps('MuteRead', 'Account', { allowRead: true })]]])));
  assert.equal(evaluator.evaluateObject('Account').access.read, true);
  assert.equal(evaluator.evaluateObject('Account').sources.read.grantedBy.some(x => x.type === 'profile'), true);
});

test('PSG Read mute removes only grants from that PSG', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([
    group(ps('GroupMember', 'Account', { allowRead: true })),
  ], new Map([['Team', [ps('MuteRead', 'Account', { allowRead: true })]]])));
  const result = evaluator.evaluateObject('Account');
  assert.equal(result.access.read, false);
  assert.equal(result.sources.read.mutedBy[0].mutingPermissionSet, 'MuteRead');
});

test('Two groups: mute in group one does not suppress the second group', () => {
  const evaluator = createPersonaAccessEvaluator(resolved([
    group(ps('Group1', 'Account', { allowRead: true }), 'GroupOne'),
    group(ps('Group2', 'Account', { allowRead: true }), 'GroupTwo'),
  ], new Map([['GroupOne', [ps('Mute1', 'Account', { allowRead: true })]]])));
  const grantSources = evaluator.evaluateObject('Account').sources.read.grantedBy;
  assert.deepEqual(grantSources.map(x => x.permissionSetGroup), ['GroupTwo']);
});

test('Repeated references to identical Permission Set are deduplicated by provenance', () => {
  const same = ps('Shared', 'Account', { allowRead: true });
  const evaluator = createPersonaAccessEvaluator(resolved([direct(same), direct(same)]));
  assert.equal(evaluator.evaluateObject('Account').sources.read.grantedBy.length, 1);
});

test('Known objects includes objects from both object and field metadata', () => {
  const permissionSet = ps('Known', 'Account', { allowRead: true }, [
    { field: 'Custom_Thing__c.Public__c', readable: true, editable: false },
  ]);
  const evaluator = createPersonaAccessEvaluator(resolved([direct(permissionSet)]));
  assert.ok(evaluator.knownObjects().includes('Account'));
  assert.ok(evaluator.knownObjects().includes('Custom_Thing__c'));
});
