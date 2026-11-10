import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrgObjectReadVerificationService } from '../src/services/OrgObjectReadVerificationService.js';
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence, OrgAccessOutcome } from '../src/salesforce/SalesforcePersonaAccessVerifier.js';
import type { Persona } from '../src/models/Persona.js';

const persona: Persona = { name: 'OTC', profile: 'CSR', permissionSets: ['A'], permissionSetGroups: ['Group'], mutingPermissionSets: [] };
const policy = { statusNeutralObjectRead: new Set(['orderitemsummary']) };
function gateway(outcome: OrgAccessOutcome, delay = 0) {
  let objects = 0; let fields = 0; let active = 0; let maximum = 0; let scope = 'org-A';
  const work = async (object: string, field?: string): Promise<OrgObjectAccessEvidence> => {
    active++; maximum = Math.max(maximum, active);
    try { if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return { object, ...(field ? { field } : {}), outcome, checkedUsers: outcome === 'UNVERIFIED' ? 0 : 1,
        matchedUsers: outcome === 'UNVERIFIED' ? 0 : 1, sampled: false, message: outcome };
    } finally { active--; }
  };
  const verifier = {
    getVerificationScope: () => scope,
    verifyObjectRead: async (_persona: Persona, object: string) => { objects++; return work(object); },
    verifyFieldRead: async (_persona: Persona, object: string, field: string) => { fields++; return work(object, field); },
  } as unknown as SalesforcePersonaAccessVerifier;
  return { service: new OrgObjectReadVerificationService(policy, verifier), counts: () => ({ objects, fields, maximum }), setScope: (value: string) => { scope = value; } };
}

test('Missing repository object Read falls back to org for any object', async () => {
  const { service, counts } = gateway('VERIFIED');
  const result = await service.resolve(persona, 'Custom_Object__c', false);
  assert.equal(result.source, 'ORG_VERIFIED');
  assert.equal(result.readable, true);
  assert.equal(counts().objects, 1);
});

test('Org denied Read is a confirmed denial, not an unknown', async () => {
  const { service } = gateway('DENIED');
  assert.equal((await service.resolve(persona, 'Contact', false)).source, 'ORG_DENIED');
  assert.equal((await service.resolveFieldRead(persona, 'Account', 'Industry', false)).source, 'ORG_DENIED');
});

test('Unverified object or FLS never becomes a confirmed denial', async () => {
  const { service } = gateway('UNVERIFIED');
  assert.equal((await service.resolve(persona, 'Account', false)).source, 'UNVERIFIED');
  assert.equal((await service.resolveFieldRead(persona, 'Account', 'Industry', false)).source, 'UNVERIFIED');
});

test('Repository grants bypass Salesforce even if org would return DENIED', async () => {
  const { service, counts } = gateway('DENIED');
  assert.equal((await service.resolve(persona, 'Account', true)).source, 'REPOSITORY');
  assert.equal((await service.resolveFieldRead(persona, 'Account', 'Industry', true)).source, 'REPOSITORY');
  assert.deepEqual(counts(), { objects: 0, fields: 0, maximum: 0 });
});

test('Status-neutral exception only applies to org-verified object Read', async () => {
  const { service } = gateway('VERIFIED');
  assert.equal((await service.resolve(persona, 'OrderItemSummary', false)).statusNeutral, true);
  assert.equal((await service.resolve(persona, 'Account', false)).statusNeutral, false);
  assert.equal((await service.resolveFieldRead(persona, 'OrderItemSummary', 'Order_Quantity_Change__c', false)).source, 'ORG_VERIFIED');
});

test('Concurrent identical checks are deduplicated per persona/object/field', async () => {
  const { service, counts } = gateway('VERIFIED', 6);
  await Promise.all(Array.from({ length: 12 }, () => service.resolve(persona, 'Account', false)));
  await Promise.all(Array.from({ length: 12 }, () => service.resolveFieldRead(persona, 'Account', 'Industry', false)));
  assert.equal(counts().objects, 1);
  assert.equal(counts().fields, 1);
});

test('Cache isolation includes org scope and cannot leak between orgs', async () => {
  const { service, counts, setScope } = gateway('VERIFIED');
  await service.resolve(persona, 'Account', false);
  setScope('org-B');
  await service.resolve(persona, 'Account', false);
  assert.equal(counts().objects, 2);
});

test('Cache isolation includes persona assignment signature', async () => {
  const { service, counts } = gateway('VERIFIED');
  await service.resolve(persona, 'Account', false);
  await service.resolve({ ...persona, permissionSets: ['Other'] }, 'Account', false);
  assert.equal(counts().objects, 2);
});

test('Shared gateway bounds inflight independent Salesforce requests', async () => {
  const { service, counts } = gateway('VERIFIED', 8);
  await Promise.all(Array.from({ length: 20 }, (_, i) => service.resolveFieldRead(persona, 'Account', `Field${i}__c`, false)));
  assert.equal(counts().fields, 20);
  assert.ok(counts().maximum <= 3, `Observed ${counts().maximum} concurrent org requests`);
});

test('Missing Salesforce connection returns UNVERIFIED instead of inventing permissions', async () => {
  const service = new OrgObjectReadVerificationService(policy);
  assert.equal((await service.resolve(persona, 'Account', false)).source, 'UNVERIFIED');
  assert.equal((await service.resolveFieldRead(persona, 'Account', 'Industry', false)).source, 'UNVERIFIED');
});
