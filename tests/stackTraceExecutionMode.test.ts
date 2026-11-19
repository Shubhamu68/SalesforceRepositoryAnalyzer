import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StackTraceImpactService } from '../src/services/StackTraceImpactService.js';
import { OrgObjectReadVerificationService } from '../src/services/OrgObjectReadVerificationService.js';
import type { PersonaConfigLoader } from '../src/config/PersonaConfigLoader.js';
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from '../src/analyzer/PersonaPermissionResolver.js';
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from '../src/salesforce/SalesforcePersonaAccessVerifier.js';
import type { Persona } from '../src/models/Persona.js';

const persona: Persona = { name: 'Test Persona', profile: undefined, permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
const resolved: ResolvedPersonaPermissions = { persona, permissionSetGroups: [], directPermissionSets: [], permissionSetGrants: [],
  mutingPermissionSets: [], mutesByGroup: new Map() };
const loader = { getAllPersonas: async () => [persona] } as unknown as PersonaConfigLoader;
const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
const evidence = (obj: string, field?: string): OrgObjectAccessEvidence => ({
  object: obj, ...(field ? { field } : {}), outcome: 'DENIED', checkedUsers: 1, matchedUsers: 1,
  sampled: false, message: 'Denied by Salesforce',
});
const live = { getVerificationScope: () => 'test',
  verifyObjectRead: async (_p: Persona, obj: string) => evidence(obj),
  verifyFieldRead: async (_p: Persona, obj: string, field: string) => evidence(obj, field),
} as unknown as SalesforcePersonaAccessVerifier;

async function execute(version: number, clause: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-stack-mode-'));
  try {
    await mkdir(path.join(dir, 'objects'));
    const file = path.join(dir, 'Demo.cls');
    const lines = [
      'public class Demo {',
      '  public static void run() {',
      `    List<Account> a = [SELECT Industry FROM Account ${clause}];`,
      '  }',
      '}',
    ];
    await writeFile(file, lines.join('\n'));
    await writeFile(`${file}-meta.xml`, `<ApexClass><apiVersion>${version}.0</apiVersion></ApexClass>`);
    const readVerifier = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, live);
    const service = new StackTraceImpactService(dir, path.join(dir, 'objects'), loader, resolver,
      path.join(dir, 'muting'), readVerifier);
    return await service.analyze('Class.Demo.run: line 3, column 1');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Stack trace marks Salesforce-denied Read as advisory when Apex API 66 default is system mode', async () => {
  const result = await execute(66, '');
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].effectiveMode, 'SYSTEM_MODE');
  assert.equal(result.queries[0].personas[0].status, 'ADVISORY');
  assert.equal(result.personas[0].status, 'ADVISORY');
  assert.equal(result.summary.advisory, 1);
});
test('Stack trace marks Salesforce-denied Read as at risk when API 67 defaults to user mode', async () => {
  const result = await execute(67, '');
  assert.equal(result.queries[0].effectiveMode, 'USER_MODE');
  assert.equal(result.personas[0].status, 'AT_RISK');
});
test('Explicit WITH USER_MODE changes the stack verdict even at API 66', async () => {
  const result = await execute(66, 'WITH USER_MODE');
  assert.equal(result.personas[0].status, 'AT_RISK');
});
test('Unsupported SECURITY_ENFORCED at API 67 is review not green', async () => {
  const result = await execute(67, 'WITH SECURITY_ENFORCED');
  assert.equal(result.queries[0].effectiveMode, 'INVALID_CLAUSE');
  assert.equal(result.personas[0].status, 'REVIEW');
});

test('Stack Trace consolidates inaccessible compound components under the proven denied parent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-stack-compound-'));
  try {
    await mkdir(path.join(dir, 'objects'));
    const file = path.join(dir, 'Demo.cls');
    await writeFile(file, [
      'public class Demo {',
      '  public static void run() {',
      '    List<Example__c> rows = [SELECT Delivery_Address__City__s, Delivery_Address__Street__s FROM Example__c WITH USER_MODE];',
      '  }',
      '}',
    ].join('\n'));
    await writeFile(`${file}-meta.xml`, '<ApexClass><apiVersion>67.0</apiVersion></ApexClass>');
    const parent = 'Delivery_Address__c';
    const live = {
      getVerificationScope: () => 'test-org',
      verifyObjectRead: async (_p: Persona, object: string): Promise<OrgObjectAccessEvidence> => ({
        object, outcome: 'VERIFIED', checkedUsers: 1, matchedUsers: 1, sampled: false,
        message: 'Object Read verified.',
      }),
      verifyFieldRead: async (_p: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence> => ({
        object, field, outcome: 'DENIED', checkedUsers: 1, matchedUsers: 1, sampled: false,
        deniedCompoundParent: parent,
        message: `Salesforce denied compound parent ${object}.${parent}; component access unresolved.`,
      }),
    } as unknown as SalesforcePersonaAccessVerifier;
    const verifier = new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, live);
    const service = new StackTraceImpactService(dir, path.join(dir, 'objects'), loader, resolver,
      path.join(dir, 'muting'), verifier);
    const result = await service.analyze('Class.Demo.run: line 3, column 1');
    assert.equal(result.queries.length, 1);
    const impact = result.queries[0].personas[0];
    assert.equal(impact.status, 'AT_RISK');
    assert.equal(impact.missing.length, 1, 'both address components depend on one denied parent');
    assert.equal(impact.missing[0].field, parent);
    assert.equal(impact.missing[0].orgOutcome, 'DENIED');
    assert.match(impact.missing[0].orgMessage ?? '', /compound parent/i);
    assert.ok(result.queries[0].checkedFields.some((field) => field.field === 'Delivery_Address__City__s'));
    assert.ok(result.queries[0].checkedFields.some((field) => field.field === 'Delivery_Address__Street__s'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
