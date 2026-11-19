import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersonaConfigLoader } from '../src/config/PersonaConfigLoader.js';
import { loadOrgVerificationStatusPolicy, isStatusNeutralOrgObjectRead } from '../src/config/orgVerificationStatusPolicy.js';
import { isIgnoredField, isAggregateExpression, isSystemField } from '../src/analyzer/soqlSystemFields.js';

async function fixture<T>(name: string, contents: string, fn: (filepath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-config-test-'));
  try {
    const filepath = path.join(dir, name);
    await writeFile(filepath, contents);
    return await fn(filepath);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const persona = (name: string) => ({ name, profile: 'CSR', permissionSetGroups: [], permissionSets: [], mutingPermissionSets: [] });

test('Persona configuration loads and resolves names case-insensitively', async () => {
  await fixture('personas.json', JSON.stringify({ personas: [persona('OMS View Only'), persona('OFA OTC')] }), async file => {
    const loader = new PersonaConfigLoader(file);
    assert.equal((await loader.getPersona('oms view only')).name, 'OMS View Only');
    assert.equal((await loader.getAllPersonas()).length, 2);
    await assert.rejects(loader.getPersona('missing'), /Persona not found/);
  });
});

test('Persona configuration rejects non-array and malformed entries', async () => {
  for (const bad of [null, {}, { personas: {} }, { personas: [null] },
    { personas: [{ ...persona('A'), name: '' }] },
    { personas: [{ ...persona('A'), profile: '' }] },
    { personas: [{ ...persona('A'), permissionSetGroups: [123] }] },
    { personas: [{ ...persona('A'), permissionSets: 'PS' }] },
    { personas: [{ ...persona('A'), mutingPermissionSets: [null] }] }]) {
    await fixture('bad.json', JSON.stringify(bad), async file => {
      await assert.rejects(new PersonaConfigLoader(file).load(), Error);
    });
  }
});

test('Persona configuration rejects invalid JSON', async () => {
  await fixture('bad.json', '{invalid', async file => {
    await assert.rejects(new PersonaConfigLoader(file).load(), /Invalid JSON/);
  });
});

test('Org status-neutral policy normalizes case and never exempts FLS', async () => {
  await fixture('status.json', JSON.stringify({ statusNeutralObjectRead: ['OrderItemSummary', 'OrderSummary'] }), async file => {
    const policy = await loadOrgVerificationStatusPolicy(file);
    assert.equal(isStatusNeutralOrgObjectRead(policy, 'orderitemsummary'), true);
    assert.equal(isStatusNeutralOrgObjectRead(policy, 'ORDERITEMSUMMARY', 'Order_Quantity_Change__c'), false);
    assert.equal(isStatusNeutralOrgObjectRead(policy, 'Contact'), false);
  });
});

test('Org status-neutral policy rejects missing, invalid, or malformed entries', async () => {
  for (const input of [{}, [], null, { statusNeutralObjectRead: null },
    { statusNeutralObjectRead: ['Account', 5] },
    { statusNeutralObjectRead: ['../Account'] },
    { statusNeutralObjectRead: ['Account.Field'] }]) {
    await fixture('policy.json', JSON.stringify(input), async file => {
      await assert.rejects(loadOrgVerificationStatusPolicy(file), Error);
    });
  }
});

test('No project-specific field snapshot is required for generic SOQL classification', () => {
  // Standard fields cannot be globally skipped because an org's actual
  // IsPermissionable metadata may require FLS checks.
  assert.equal(isIgnoredField('Name', 'Account'), false);
  assert.equal(isIgnoredField('BillingCity', 'Account'), false);
  assert.equal(isIgnoredField('CreatedDate', 'Contact'), false);
  // Every SObject ID is intrinsic and does not need an independent FLS row.
  assert.equal(isIgnoredField('Id', 'Contact'), true);
});

test('SOQL system fields, aggregate recognition, and legacy exceptions', () => {
  assert.equal(isSystemField('CREATEDDATE'), true);
  assert.equal(isSystemField('Custom_Field__c'), false);
  for (const agg of ['COUNT(Id)', 'SUM(Quantity)', 'AVG(Amount)', 'MAX(Amount)', 'MIN(Amount)']) {
    assert.equal(isAggregateExpression(agg), true, agg);
  }
  assert.equal(isAggregateExpression('Name'), false);
  // Explicit metadata wins over generic legacy system-field suppression.
  assert.equal(isIgnoredField('BillingCity', 'Account'), false);
});
