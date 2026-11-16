import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractSoqlQueries, scanApexSoql } from '../src/scanner/apexSoqlScanner.js';

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
