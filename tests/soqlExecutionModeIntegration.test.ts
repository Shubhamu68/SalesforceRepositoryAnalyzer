import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SoqlSecurityAnalyzer } from '../src/analyzer/soqlSecurityAnalyzer.js';
import { OrgObjectReadVerificationService } from '../src/services/OrgObjectReadVerificationService.js';
import type { Persona } from '../src/models/Persona.js';
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from '../src/analyzer/PersonaPermissionResolver.js';
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from '../src/salesforce/SalesforcePersonaAccessVerifier.js';
import type { SoqlQuery } from '../src/models/SoqlQuery.js';
import { extractSoqlQueries } from '../src/scanner/apexSoqlScanner.js';

const persona: Persona = { name: 'Test', profile: undefined, permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
const resolved = { persona, permissionSetGroups: [], directPermissionSets: [], permissionSetGrants: [],
  mutingPermissionSets: [], mutesByGroup: new Map() } as ResolvedPersonaPermissions;
const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
const evidence = (object: string, field?: string): OrgObjectAccessEvidence => ({
  object, ...(field ? { field } : {}), outcome: 'DENIED', checkedUsers: 1, matchedUsers: 1,
  sampled: false, message: 'Salesforce confirmed missing Read.',
});
const org = { getVerificationScope: () => 'test-org', verifyObjectRead: async (_p: Persona, object: string) => evidence(object),
  verifyFieldRead: async (_p: Persona, object: string, field: string) => evidence(object, field),
} as unknown as SalesforcePersonaAccessVerifier;
const policy = { statusNeutralObjectRead: new Set<string>() };
async function run(mode: string, version: string): Promise<ReturnType<SoqlSecurityAnalyzer['analyze']> extends Promise<infer R> ? R : never> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-mode-int-'));
  try {
    const sourcePath = path.join(dir, 'Service.cls');
    await writeFile(`${sourcePath}-meta.xml`, `<ApexClass><apiVersion>${version}</apiVersion></ApexClass>`);
    const query: SoqlQuery = extractSoqlQueries(`List<Account> items = [SELECT Name FROM Account ${mode}];`, sourcePath)[0];
    const verifier = new OrgObjectReadVerificationService(policy, org);
    return await new SoqlSecurityAnalyzer(resolver, dir, verifier).analyze(persona, [query]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Denied Read is Low for API 66 system mode and not a runtime failure', async () => {
  const findings = await run('', '66.0');
  assert.equal(findings[0].criticality, 'Low');
  assert.equal(findings[0].severity, 'INFO');
  assert.equal(findings[0].verificationSource, 'ORG_DENIED');
  assert.equal(findings[0].effectiveMode, 'SYSTEM_MODE');
  assert.equal(findings[0].runtimeImpact, 'Not enforced by query');
});
test('Same denied object Read in default API 67 user mode is potential runtime failure', async () => {
  const findings = await run('', '67.0');
  assert.equal(findings[0].criticality, 'High');
  assert.equal(findings[0].effectiveMode, 'USER_MODE');
  assert.equal(findings[0].runtimeImpact, 'Potential access failure');
});
test('Explicit USER_MODE under API 66 overrides system default', async () => {
  const finding = (await run('WITH USER_MODE', '66.0'))[0];
  assert.equal(finding.runtimeImpact, 'Potential access failure');
  assert.equal(finding.criticality, 'High');
});
test('Explicit SYSTEM_MODE under API 67 overrides user default', async () => {
  const finding = (await run('WITH SYSTEM_MODE', '67.0'))[0];
  assert.equal(finding.runtimeImpact, 'Not enforced by query');
  assert.equal(finding.criticality, 'Low');
});
test('SECURITY_ENFORCED under API 67 is separately reported as an invalid clause', async () => {
  const findings = await run('WITH SECURITY_ENFORCED', '67.0');
  assert.ok(findings.some(f => f.findingType === 'QUERY_MODE' && f.runtimeImpact === 'Unsupported query clause'));
});

test('Missing FLS is Low in system mode and High in user mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-mode-field-'));
  try {
    const file = path.join(dir, 'FieldCheck.cls');
    const ps = { name: 'PS', label: 'PS', objectPermissions: [{ object: 'Account', allowRead: true,
      allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false,
      modifyAllRecords: false, viewAllFields: false }], fieldPermissions: [] };
    const grants = { ...resolved, directPermissionSets: [ps], permissionSetGrants: [
      { permissionSet: ps, type: 'directPermissionSet' as const },
    ] } as unknown as ResolvedPersonaPermissions;
    const withObject = { resolve: async () => grants } as unknown as PersonaPermissionResolver;
    const verifier = new OrgObjectReadVerificationService(policy, org);
    for (const version of [66, 67]) {
      await writeFile(`${file}-meta.xml`, `<ApexClass><apiVersion>${version}.0</apiVersion></ApexClass>`);
      const query = extractSoqlQueries('List<Account> a = [SELECT Industry FROM Account];', file)[0];
      const findings = await new SoqlSecurityAnalyzer(withObject, dir, verifier).analyze(persona, [query]);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].findingType, 'FIELD_READ');
      assert.equal(findings[0].criticality, version === 66 ? 'Low' : 'High');
      assert.equal(findings[0].runtimeImpact, version === 66 ? 'Not enforced by query' : 'Potential access failure');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SECURITY_ENFORCED API 66 requires field Read and produces High for a denial', async () => {
  const finding = (await run('WITH SECURITY_ENFORCED', '66.0'))[0];
  assert.equal(finding.criticality, 'High');
  assert.equal(finding.effectiveMode, 'SECURITY_ENFORCED');
});
