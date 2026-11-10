import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SoqlSecurityAnalyzer } from '../src/analyzer/soqlSecurityAnalyzer.js';
import { OrgObjectReadVerificationService } from '../src/services/OrgObjectReadVerificationService.js';
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from '../src/analyzer/PersonaPermissionResolver.js';
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence, OrgAccessOutcome } from '../src/salesforce/SalesforcePersonaAccessVerifier.js';
import type { SoqlQuery } from '../src/models/SoqlQuery.js';
import type { PermissionSet } from '../src/models/PermissionSet.js';
import type { Persona } from '../src/models/Persona.js';

const persona: Persona = { name: 'OTC', profile: undefined, permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
const q = (object: string, fields: string[], line = 10): SoqlQuery => ({
  object, fields, filePath: 'classes/Analyzer.cls', lineNumber: line,
  query: `SELECT ${fields.join(', ')} FROM ${object} WITH USER_MODE`, withUserMode: true, securityMode: 'USER_MODE', subqueries: [],
});
const policy = { statusNeutralObjectRead: new Set(['orderitemsummary']) };
function setup(opts: { objectRead?: boolean; objectOutcome?: OrgAccessOutcome; fieldOutcome?: OrgAccessOutcome; fields?: string[]; objects?: string[] }) {
  const calls: string[] = [];
  const ps: PermissionSet = { name: 'PS', label: 'PS', objectPermissions: (opts.objects ?? ['Account']).map(object => ({
    object, allowRead: opts.objectRead ?? true, allowCreate: false, allowEdit: false, allowDelete: false,
    viewAllRecords: false, modifyAllRecords: false, viewAllFields: false,
  })), fieldPermissions: (opts.fields ?? []).map(field => ({ field, readable: true, editable: false })) };
  const resolved: ResolvedPersonaPermissions = { persona, permissionSetGroups: [], directPermissionSets: [ps],
    permissionSetGrants: [{ permissionSet: ps, type: 'directPermissionSet' }], mutingPermissionSets: [], mutesByGroup: new Map() };
  const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
  const evidence = (object: string, field: string | undefined, outcome: OrgAccessOutcome): OrgObjectAccessEvidence => ({
    object, ...(field ? { field } : {}), outcome, checkedUsers: outcome === 'UNVERIFIED' ? 0 : 2,
    matchedUsers: outcome === 'UNVERIFIED' ? 0 : 2, sampled: false, message: `Outcome=${outcome}`,
  });
  const mock = { getVerificationScope: () => 'test-org',
    verifyObjectRead: async (_p: Persona, object: string) => {
      calls.push(`object:${object}`);
      return evidence(object, undefined, opts.objectOutcome ?? 'VERIFIED');
    },
    verifyFieldRead: async (_p: Persona, object: string, field: string) => {
      calls.push(`field:${object}.${field}`);
      return evidence(object, field, opts.fieldOutcome ?? 'VERIFIED');
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  const verifier = new OrgObjectReadVerificationService(policy, mock);
  async function analyze(queries: SoqlQuery[]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-soql-behavior-'));
    try { return await new SoqlSecurityAnalyzer(resolver, dir, verifier).analyze(persona, queries); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  return { analyze, calls };
}

test('A repository object + field grant is clean and never calls Salesforce', async () => {
  const { analyze, calls } = setup({ objectRead: true, fields: ['Account.Industry'] });
  assert.deepEqual(await analyze([q('Account', ['Industry'])]), []);
  assert.deepEqual(calls, []);
});

test('Repository field grant survives org-backed object Read', async () => {
  const { analyze, calls } = setup({ objectRead: false, fields: ['Account.Industry'] });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, 'OBJECT_READ');
  assert.equal(findings[0].criticality, 'Low');
  assert.deepEqual(calls, ['object:Account']);
});

test('Org-verified object + denied field reports both Low object evidence and High FLS', async () => {
  const { analyze } = setup({ objectRead: false, fieldOutcome: 'DENIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.deepEqual(findings.map(x => x.criticality), ['Low', 'High']);
  assert.deepEqual(findings.map(x => x.findingType), ['OBJECT_READ', 'FIELD_READ']);
});

test('Denied object Read short-circuits field checks and avoids error multiplication', async () => {
  const { analyze, calls } = setup({ objectRead: false, objectOutcome: 'DENIED', fieldOutcome: 'VERIFIED' });
  const findings = await analyze([q('Account', ['Industry', 'BillingCity', 'Name'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, 'High');
  assert.deepEqual(calls, ['object:Account']);
});

test('Unverified object Read does not invent denied FLS', async () => {
  const { analyze, calls } = setup({ objectRead: false, objectOutcome: 'UNVERIFIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, 'Unable to verify');
  assert.deepEqual(calls, ['object:Account']);
});

test('Duplicate field across different SOQL lines yields one org check and separate references', async () => {
  const { analyze, calls } = setup({ objectRead: true, fieldOutcome: 'DENIED' });
  const findings = await analyze([q('Account', ['Industry'], 10), q('Account', ['Industry'], 20)]);
  assert.deepEqual(findings.map(x => x.lineNumber), [10, 20]);
  assert.equal(calls.filter(x => x === 'field:Account.Industry').length, 1);
});

test('Query text and USER_MODE source flag remain intact in security findings', async () => {
  const { analyze } = setup({ objectRead: true, fieldOutcome: 'DENIED' });
  const query = q('Account', ['Industry']);
  const findings = await analyze([query]);
  assert.equal(findings[0].query, query.query);
  assert.equal(findings[0].withUserMode, true);
});

test('Output order remains deterministic despite parallel field verification', async () => {
  const { analyze } = setup({ objectRead: true, fieldOutcome: 'DENIED' });
  const findings = await analyze([q('Account', ['Industry', 'Rating', 'AccountNumber'])]);
  assert.deepEqual(findings.map(x => x.field), ['Industry', 'Rating', 'AccountNumber']);
});


test('Confirmed field denial has one concise explanation without duplicate verifier text', async () => {
  const { analyze } = setup({ objectRead: true, fieldOutcome: 'DENIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, 'High');
  assert.equal(findings[0].reason,
    'Field Account.Industry: Repository metadata did not establish Read access; Salesforce confirmed it is missing for the selected user.');
  assert.doesNotMatch(findings[0].reason, /Outcome=DENIED/);
});

test('Confirmed object denial has one concise explanation without duplicate verifier text', async () => {
  const { analyze } = setup({ objectRead: false, objectOutcome: 'DENIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, 'OBJECT_READ');
  assert.equal(findings[0].reason,
    'Object Account: Repository metadata did not establish Read access; Salesforce confirmed it is missing for the selected user.');
  assert.doesNotMatch(findings[0].reason, /Outcome=DENIED/);
});

test('Inconclusive field access keeps the verifier diagnostic', async () => {
  const { analyze } = setup({ objectRead: true, fieldOutcome: 'UNVERIFIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, 'Unable to verify');
  assert.match(findings[0].reason, /Outcome=UNVERIFIED/);
});

test('Verified field read keeps its clear repository-versus-org explanation', async () => {
  const { analyze } = setup({ objectRead: true, fieldOutcome: 'VERIFIED' });
  const findings = await analyze([q('Account', ['Industry'])]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].criticality, 'Low');
  assert.match(findings[0].reason, /Salesforce confirmed access/);
  assert.doesNotMatch(findings[0].reason, /Outcome=VERIFIED/);
});
