import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractSoqlQueries, scanApexSoql, scanApexSoqlWithUnresolved } from '../src/scanner/apexSoqlScanner.js';
import { createApexMethodIndex } from '../src/scanner/apexMethodScanner.js';

const from = (source: string) => extractSoqlQueries(source, 'classes/Queries.cls');

test('Finds one static SELECT and identifies root object', () => {
  const queries = from('public class Queries { void check(){ List<Account> a = [SELECT Id, Name FROM Account]; } }');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].object, 'Account');
  assert.ok(queries[0].fields.includes('Name'));
});

test('Scans several static queries in source order', () => {
  const queries = from('List<Account> a = [SELECT Name FROM Account];\nList<Contact> c = [SELECT LastName FROM Contact];');
  assert.deepEqual(queries.map(q => q.object), ['Account', 'Contact']);
  assert.equal(queries[1].lineNumber > queries[0].lineNumber, true);
});

test('Does not treat bracketed Apex collection indexing as SOQL', () => {
  assert.equal(from('String field = names[0]; Integer x = array[index];').length, 0);
});

test('Ignores SOQL-looking text inside Apex line comments', () => {
  assert.equal(from('// [SELECT Name FROM Account]\nString test = \'hello\';').length, 0);
});

test('Ignores SOQL-looking text inside Apex block comments', () => {
  assert.equal(from('/* [SELECT Name FROM Account] */\nSystem.debug(1);').length, 0);
});

test('Ignores SOQL-looking text in strings', () => {
  assert.equal(from('String literal = \'[SELECT Name FROM Account]\';').length, 0);
});

test('WITH USER_MODE is recognized', () => {
  const queries = from('List<Account> a = [SELECT Name FROM Account WITH USER_MODE];');
  assert.equal(queries[0].withUserMode, true);
  assert.equal(queries[0].securityMode, 'USER_MODE');
});

test('Legacy query without USER_MODE remains classified without it', () => {
  const queries = from('List<Account> a = [SELECT Name FROM Account];');
  assert.equal(queries[0].withUserMode, false);
  assert.equal(queries[0].securityMode, 'UNSPECIFIED');
});

test('Child relationship SELECTs are retained for downstream inventory analysis', () => {
  const queries = from('List<Account> a = [SELECT Name, (SELECT LastName FROM Contacts) FROM Account];');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].subqueries[0]?.relationshipName, 'Contacts');
});

test('Repository walker excludes Apex test classes and includes normal .cls files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-soql-scanner-'));
  try {
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'Service.cls'), 'List<Account> a = [SELECT Name FROM Account];');
    await writeFile(path.join(dir, 'nested', 'ExampleTest.cls'), 'List<Contact> a = [SELECT Name FROM Contact];');
    const queries = await scanApexSoql(dir);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].object, 'Account');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("Apex constructor bind with generic angle brackets stays inside one valid SOQL query", () => {
  const source = [
    "List<Shipment__c> pending = [SELECT Id, OrderSummary__c FROM Shipment__c WHERE",
    "    OrderSummary__c IN :mapOfOrderSummaries.keySet() AND",
    "    Status__c IN :new Set<String>{'Draft', 'Discrepancy'} WITH USER_MODE];",
  ].join("\n");
  const queries = from(source);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].object, "Shipment__c");
  assert.equal(queries[0].lineNumber, 1);
  assert.equal(queries[0].securityMode, "USER_MODE");
});

test('Shared discovery excludes generated trees but preserves real Apex and each scanner test-class policy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-discovery-policy-'));
  try {
    const put = async (relative: string, source: string) => {
      const file = path.join(dir, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    };
    await put('force-app/main/default/classes/Service.cls', 'public class Service { public void run(){ List<Account> a = [SELECT Name FROM Account]; } }');
    await put('extra-package/classes/Other.cls', 'public class Other { public void run(){ List<Lead> a = [SELECT Id FROM Lead]; } }');
    await put('extra-package/classes/ServiceTest.cls', 'public class ServiceTest { public void run(){ List<Case> a = [SELECT Id FROM Case]; } }');
    for (const root of ['.sfdx/tools/264/StandardApexLibrary/System', '.SF/cache', '.git/objects', 'node_modules/dependency', 'packages/build', 'packages/dist', '.next/cache', 'coverage/tmp']) {
      await put(root + '/Database.cls', 'public class Database { public void run(){ List<Contact> a = [SELECT Id FROM Contact]; } }');
    }
    const queries = await scanApexSoql(dir);
    assert.deepEqual(queries.map(q => q.object).sort(), ['Account', 'Lead']);
    const index = await createApexMethodIndex(dir);
    assert.deepEqual(index.files.map(file => path.basename(file)).sort(), ['Other.cls', 'Service.cls', 'ServiceTest.cls']);
    assert.ok(!index.classes.has('database'));
    assert.ok(index.classes.has('servicetest'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Tooling Database stub cannot suppress lifecycle evidence; real source shadow remains rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-discovery-shadow-'));
  try {
    const classes = path.join(dir, 'force-app', 'main', 'default', 'classes');
    const tools = path.join(dir, '.sfdx', 'tools', '264', 'StandardApexLibrary', 'System');
    await mkdir(classes, { recursive: true });
    await mkdir(tools, { recursive: true });
    await writeFile(path.join(tools, 'Database.cls'), 'public class Database {}');
    await writeFile(path.join(classes, 'Work.cls'), "public class Work implements Database.Batchable<SObject>,Database.Stateful{private String query;public Work(){query='SELECT Name FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator('SELECT Id FROM Account');}public void execute(Database.BatchableContext bc,List<SObject> rows){this.fetch();}private void fetch(){Database.query(query);}public void finish(Database.BatchableContext bc){}}");
    const clean = await scanApexSoqlWithUnresolved(dir);
    assert.ok(clean.queries.some(q => q.query === 'SELECT Name FROM Account' && q.coverage === 'CONDITIONAL_FRAMEWORK_CONTEXT'), JSON.stringify(clean));
    assert.equal(clean.unresolvedDynamic.length, 1);
    assert.ok(!clean.unresolvedDynamic[0].reason.includes('rejected_platform_class_shadow'));
    const custom = path.join(classes, 'Database.cls');
    await writeFile(custom, 'public class Database { public static void customMethod() {} }');
    const shadowed = await scanApexSoqlWithUnresolved(dir);
    assert.ok(!shadowed.queries.some(q => q.query === 'SELECT Name FROM Account' && q.coverage === 'CONDITIONAL_FRAMEWORK_CONTEXT'), JSON.stringify(shadowed));
    assert.ok(shadowed.unresolvedDynamic.some(u => u.reason.includes('rejected_platform_class_shadow')), JSON.stringify(shadowed));
    assert.ok((await createApexMethodIndex(dir)).files.includes(custom));
    await rm(custom);
    const recovered = await scanApexSoqlWithUnresolved(dir);
    assert.ok(recovered.queries.some(q => q.query === 'SELECT Name FROM Account' && q.coverage === 'CONDITIONAL_FRAMEWORK_CONTEXT'), JSON.stringify(recovered));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
