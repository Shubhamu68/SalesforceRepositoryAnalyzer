import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractApexMethods, extractMethodCalls, maskApex, parseApexStackTrace, countArguments, matchPair, lineAt, resolveMethodCalls, createApexMethodIndex } from '../src/scanner/apexMethodScanner.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Parses Class and Trigger Apex stack frames', () => {
  const frames = parseApexStackTrace('Class.OMSQueryService.getOrderItemSummariesByIds: line 414, column 1\nTrigger.OrderProductPromotionTrigger: line 23, column 1');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].className, 'OMSQueryService');
  assert.equal(frames[0].methodName, 'getOrderItemSummariesByIds');
  assert.equal(frames[1].kind, 'Trigger');
  assert.equal(frames[1].methodName, undefined);
});

test('Ignores non-Apex lines in a mixed stack trace', () => {
  assert.equal(parseApexStackTrace('System.NullPointerException\nRandom text\nClass.Helper.run: line 18').length, 1);
});

test('Apex source masking preserves character offsets and newlines', () => {
  const src = "// helper()\nString test = 'ignore()';\n/* skip() */\nrun();";
  const masked = maskApex(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.equal(masked.includes('run();'), true);
  assert.equal(masked.includes('skip()'), false);
});

test('Nested pair matching respects balanced source structure', () => {
  const source = 'fn(a, nested(b), c)';
  assert.equal(matchPair(source, source.indexOf('('), '(', ')'), source.length - 1);
});

test('Apex source offsets map to correct line', () => {
  assert.equal(lineAt('first\nsecond\nthird', 13), 3);
});

test('Argument count recognizes empty and ordinary method arguments', () => {
  assert.equal(countArguments(''), 0);
  assert.equal(countArguments('a, b, c'), 3);
});

test('Method extraction attaches static SOQL to the containing method', () => {
  const source = 'public class QueryClass {\n public static void run() {\n  List<Account> a = [SELECT Name FROM Account];\n }\n}';
  const methods = extractApexMethods(source, 'QueryClass.cls');
  assert.equal(methods.length, 1);
  assert.equal(methods[0].methodName, 'run');
  assert.equal(methods[0].queries.length, 1);
  assert.equal(methods[0].queries[0].object, 'Account');
});

test('Method call scanner skips embedded strings and static SOQL', () => {
  const source = 'public class QueryClass { public static void run() { helper(); List<Account> a = [SELECT Id FROM Account]; String str = \'fake()\'; } }';
  const [method] = extractApexMethods(source, 'QueryClass.cls');
  const calls = extractMethodCalls(method);
  assert.ok(calls.some(c => c.method === 'helper'));
  assert.equal(calls.some(c => c.method === 'fake'), false);
});

test('Same-class method calls resolve to the correct method', () => {
  const source = 'public class QueryClass { public static void run() { helper(); } public static void helper() { } }';
  const methods = extractApexMethods(source, 'QueryClass.cls');
  const index = { classes: new Map([['queryclass', methods]]), methods } as unknown as Parameters<typeof resolveMethodCalls>[1];
  const result = resolveMethodCalls(methods.find(m => m.methodName === 'run')!, index, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].methodName, 'helper');
});

test('Indexes classes from repository source files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-apex-index-'));
  try {
    await writeFile(path.join(dir, 'QueryClass.cls'), 'public class QueryClass { public static void run() { } }');
    const index = await createApexMethodIndex(dir);
    assert.ok(index.classes.has('queryclass'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
