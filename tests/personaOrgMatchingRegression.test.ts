import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchPersonaUsers, type OrgAssignment, type OrgProfile, type OrgUser } from '../src/salesforce/OrgPersonaMatcher.js';
import type { Persona } from '../src/models/Persona.js';

const persona = (overrides: Partial<Persona> = {}): Persona => ({
  name: 'OTC', profile: 'CSR', permissionSets: ['DirectPS'],
  permissionSetGroups: ['OMSGroup'], mutingPermissionSets: [], ...overrides,
});
const profiles: OrgProfile[] = [{ id: 'p1', name: 'CSR' }, { id: 'p2', name: 'Team Lead' }];
const users: OrgUser[] = [{ id: 'u1', profileId: 'p1' }, { id: 'u2', profileId: 'p1' }, { id: 'u3', profileId: 'p2' }];
const assignments = (entries: Array<[string, string[], string[]]>) => new Map<string, OrgAssignment>(
  entries.map(([id, ps, psg]) => [id, { userId: id, permissionSets: new Set(ps.map(value => value.toLowerCase())), permissionSetGroups: new Set(psg.map(value => value.toLowerCase())) }]),
);

test('Matches Profile plus every required direct PS and PSG, case-insensitively', () => {
  const match = matchPersonaUsers(persona(), profiles, users, assignments([
    ['u1', ['directps'], ['omsgroup']], ['u2', ['DirectPS'], []], ['u3', ['DirectPS'], ['OMSGroup']],
  ]));
  assert.deepEqual(match.users, ['u1']);
  assert.equal(match.exactCount, 1);
  assert.equal(match.eligibleCount, 1);
});

test('Additional unrelated grants do not disqualify eligible users', () => {
  const match = matchPersonaUsers(persona(), profiles, users, assignments([
    ['u1', ['DirectPS', 'Extra'], ['OMSGroup']], ['u2', ['DirectPS'], ['OMSGroup']],
  ]));
  assert.deepEqual(match.users, ['u2', 'u1']);
  assert.equal(match.exactCount, 1);
  assert.equal(match.extraAssignmentCount, 1);
});

test('Among matching users, least-extra-grants and stable ID determine order', () => {
  const match = matchPersonaUsers(persona(), profiles,
    [{ id: 'z', profileId: 'p1' }, { id: 'a', profileId: 'p1' }],
    assignments([['z', ['DirectPS'], ['OMSGroup']], ['a', ['DirectPS'], ['OMSGroup']]]));
  assert.deepEqual(match.users, ['a', 'z']);
});

test('Rejects unsafe identity inference when persona Profile is missing', () => {
  const match = matchPersonaUsers(persona({ profile: undefined }), profiles, users, new Map());
  assert.equal(match.eligibleCount, 0);
  assert.match(match.reason ?? '', /no configured Profile/i);
});

test('Missing Profile does not match any user', () => {
  const match = matchPersonaUsers(persona({ profile: 'DoesNotExist' }), profiles, users, new Map());
  assert.deepEqual(match.users, []);
  assert.match(match.reason ?? '', /not found/i);
});

test('No active user has full required assignments results in zero matches', () => {
  const match = matchPersonaUsers(persona(), profiles, users, assignments([
    ['u1', ['DirectPS'], []], ['u2', [], ['OMSGroup']],
  ]));
  assert.equal(match.eligibleCount, 0);
  assert.match(match.reason ?? '', /No active user/i);
});

test('Administrator Profile alias matches System Administrator', () => {
  const result = matchPersonaUsers(persona({ profile: 'Admin', permissionSets: [], permissionSetGroups: [] }),
    [{ id: 'admin', name: 'System Administrator' }], [{ id: 'sys', profileId: 'admin' }], new Map());
  assert.deepEqual(result.users, ['sys']);
});

test('DeveloperName can identify a Profile when display name differs', () => {
  const result = matchPersonaUsers(persona({ profile: 'OMS_Standard_User', permissionSets: [], permissionSetGroups: [] }),
    [{ id: 'p1', name: 'OMS Standard User', developerName: 'OMS_Standard_User' }],
    [{ id: 'u1', profileId: 'p1' }], new Map());
  assert.deepEqual(result.users, ['u1']);
});
