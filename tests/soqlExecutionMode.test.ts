import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { classifySoqlMode, resolveSoqlExecutionMode, runtimeImpactForFinding } from '../src/analyzer/soqlExecutionMode.js';
import { ApexExecutionSecurityModeResolver } from '../src/services/ApexExecutionSecurityModeResolver.js';
import { extractSoqlQueries } from '../src/scanner/apexSoqlScanner.js';

const query = (suffix: string) => `SELECT Id, Name FROM Account ${suffix}`;

test('Explicit USER_MODE enforces object/FLS even with API 66', () => {
  assert.equal(resolveSoqlExecutionMode('USER_MODE', 66).enforcement, 'FULL');
});
test('Explicit SYSTEM_MODE disables object/FLS enforcement even with API 67', () => {
  assert.equal(resolveSoqlExecutionMode('SYSTEM_MODE', 67).enforcement, 'NONE');
});
test('API 66 defaults to SYSTEM_MODE, API 67 defaults to USER_MODE', () => {
  assert.equal(resolveSoqlExecutionMode('UNSPECIFIED', 66).effectiveMode, 'SYSTEM_MODE');
  assert.equal(resolveSoqlExecutionMode('UNSPECIFIED', 67).effectiveMode, 'USER_MODE');
  assert.equal(resolveSoqlExecutionMode('UNSPECIFIED', 68).effectiveMode, 'USER_MODE');
});
test('Absent API metadata is unknown, not an assumed system-mode exemption', () => {
  assert.equal(resolveSoqlExecutionMode('UNSPECIFIED').enforcement, 'UNKNOWN');
});
test('SECURITY_ENFORCED through API 66 checks SELECT and object, not WHERE-only FLS', () => {
  assert.equal(resolveSoqlExecutionMode('SECURITY_ENFORCED', 66).enforcement, 'SELECT_ONLY');
});
test('SECURITY_ENFORCED API 67+ is unsupported and never treated as a normal permission result', () => {
  assert.equal(resolveSoqlExecutionMode('SECURITY_ENFORCED', 67).enforcement, 'INVALID');
});
test('SECURITY_ENFORCED with missing API version stays unknown', () => {
  assert.equal(resolveSoqlExecutionMode('SECURITY_ENFORCED').enforcement, 'UNKNOWN');
});
test('Clause classifier ignores string literals and comments', () => {
  assert.equal(classifySoqlMode(query("WHERE Name = 'WITH USER_MODE'")), 'UNSPECIFIED');
  assert.equal(classifySoqlMode(query('-- WITH USER_MODE\nLIMIT 10')), 'UNSPECIFIED');
  assert.equal(classifySoqlMode(query('/* WITH SYSTEM_MODE */ WITH USER_MODE')), 'USER_MODE');
  assert.equal(classifySoqlMode(query('WITH SECURITY_ENFORCED')), 'SECURITY_ENFORCED');
});
test('Static SOQL parser retains all four explicit modes', () => {
  for (const [text, expected] of [
    ['WITH USER_MODE', 'USER_MODE'], ['WITH SYSTEM_MODE', 'SYSTEM_MODE'],
    ['WITH SECURITY_ENFORCED', 'SECURITY_ENFORCED'], ['', 'UNSPECIFIED'],
  ]) {
    const [q] = extractSoqlQueries(`List<Account> a = [${query(text)}];`, '/repo/My.cls');
    assert.equal(q.securityMode, expected);
    assert.equal(q.withUserMode, expected === 'USER_MODE');
  }
});
test('Runtime impact is separate from denied/verified access', () => {
  assert.equal(runtimeImpactForFinding(resolveSoqlExecutionMode('UNSPECIFIED', 66), 'DENIED'), 'Not enforced by query');
  assert.equal(runtimeImpactForFinding(resolveSoqlExecutionMode('UNSPECIFIED', 67), 'DENIED'), 'Potential access failure');
  assert.equal(runtimeImpactForFinding(resolveSoqlExecutionMode('USER_MODE', 66), 'VERIFIED'), 'Access confirmed');
  assert.equal(runtimeImpactForFinding(resolveSoqlExecutionMode('USER_MODE', 66), 'UNVERIFIED'), 'Undetermined');
});
test('Apex class metadata versions are read and memoized', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-execution-mode-'));
  try {
    const file = path.join(dir, 'MyClass.cls');
    const meta = `${file}-meta.xml`;
    await writeFile(meta, '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>66.0</apiVersion></ApexClass>');
    const resolver = new ApexExecutionSecurityModeResolver();
    assert.equal((await resolver.resolve(query(''), file)).effectiveMode, 'SYSTEM_MODE');
    await writeFile(meta, '<ApexClass><apiVersion>67.0</apiVersion></ApexClass>');
    assert.equal((await resolver.resolve(query(''), file)).effectiveMode, 'SYSTEM_MODE');
    assert.equal((await new ApexExecutionSecurityModeResolver().resolve(query(''), file)).effectiveMode, 'USER_MODE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Missing and malformed metadata are represented as UNKNOWN', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-execution-unknown-'));
  try {
    const file = path.join(dir, 'WithoutVersion.cls');
    const resolver = new ApexExecutionSecurityModeResolver();
    assert.equal((await resolver.resolve(query(''), file)).effectiveMode, 'UNKNOWN');
    await writeFile(`${file}-meta.xml`, '<ApexClass><apiVersion>invalid</apiVersion></ApexClass>');
    assert.equal((await new ApexExecutionSecurityModeResolver().resolve(query(''), file)).effectiveMode, 'UNKNOWN');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
