import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDynamicSoqlQueries } from "../src/scanner/dynamicSoqlScanner.js";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";

const source = (body: string) => [
  "public with sharing class DynamicSample {",
  "  public static void execute() {",
  body,
  "  }",
  "}",
].join("\n");
const file = "/tmp/DynamicSample.cls";

test("v0.1.1 resolves inline literal without altering static scan", () => {
  const text = source("    List<SObject> a = Database.query('SELECT Id, Name FROM Account WITH USER_MODE');");
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].object, "Account");
  assert.equal(result.queries[0].securityMode, "USER_MODE");
  assert.equal(result.queries[0].lineNumber, 3);
  assert.equal(extractSoqlQueries(text, file).length, 0);
});

test("v0.1.1 resolves known local variables and repeated concatenations", () => {
  const text = source([
    "    String fields = 'Id, Name';",
    "    String root = 'Account';",
    "    String q = 'SELECT ' + fields;",
    "    q += ' FROM ' + root;",
    "    List<SObject> result = Database.query(q);",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].query, "SELECT Id, Name FROM Account");
});

test("v0.1.1 resolves dynamic queryWithBinds access mode", () => {
  const text = source([
    "    String q = 'SELECT Id FROM Account WHERE Name = :name';",
    "    Database.queryWithBinds(q, binds, AccessLevel.USER_MODE);",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].dynamicAccessLevel, "USER_MODE");
});

test("v0.1.1 reports unsupported runtime string construction unresolved", () => {
  const text = source([
    "    String fields = getFieldsFromMetadata();",
    "    Database.query('SELECT ' + fields + ' FROM Account');",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.queries.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /unsupported/i);
});

test("v0.1.1 enumerates both feasible conditional assignment variants", () => {
  const text = source([
    "    String q = 'SELECT Id FROM Account';",
    "    if (addName) { q = 'SELECT Id, Name FROM Account'; }",
    "    Database.query(q);",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.queries.map(q=>q.query).sort(),
    ["SELECT Id FROM Account","SELECT Id, Name FROM Account"].sort());
});

test("v0.1.1 ignores commented-out Database calls and strings", () => {
  const text = source([
    "    // Database.query('SELECT Id FROM Contact');",
    "    /* Database.query('SELECT Id FROM Lead'); */",
    "    String comment = 'Database.query(fake)';",
    "    Database.query('SELECT Id FROM Account');",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.queries.length, 1);
  assert.equal(result.unresolved.length, 0);
});

test("v0.1.1 assigns distinct identities to two dynamic calls on one source line", () => {
  const text = source("    Database.query('SELECT Id FROM Account'); Database.query('SELECT Id FROM Contact');");
  const result = extractDynamicSoqlQueries(text, file);
  assert.deepEqual(result.queries.map(q => q.object), ["Account", "Contact"]);
  assert.equal(result.unresolved.length, 0);
  assert.notEqual(result.queries[0].queryVariantId, result.queries[1].queryVariantId);
  assert.equal(result.queries[0].lineNumber, result.queries[1].lineNumber);
});

test("v0.1.1 reports unknown AccessLevel instead of inventing query enforcement", () => {
  const text = source([
    "    String q = 'SELECT Id FROM Account';",
    "    Database.query(q, accessLevel);",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(text, file);
  assert.equal(result.queries.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /accesslevel/i);
});


test("v0.1.1 enumerates mutually exclusive valid WHERE variants", () => {
  const code = source([
    "    String query = 'SELECT Id FROM Account';",
    "    if (flag) { query += ' WHERE Name = :name'; }",
    "    else { query += ' WHERE Phone = :phone'; }",
    "    Database.query(query);",
  ].join("\n"));
  const result = extractDynamicSoqlQueries(code,file);
  assert.equal(result.unresolved.length,0);
  assert.deepEqual(result.queries.map(q=>q.query).sort(),[
    "SELECT Id FROM Account WHERE Name = :name",
    "SELECT Id FROM Account WHERE Phone = :phone",
  ]);
});
test("v0.1.1 keeps both optional WHERE cases when condition is runtime dependent",()=>{
  const code=source([
    "    String query = 'SELECT Id FROM Account';",
    "    if (!String.isBlank(searchKey)) { query += ' WHERE Name LIKE :searchKey'; }",
    "    Database.query(query);",
  ].join("\n"));
  const result=extractDynamicSoqlQueries(code,file);
  assert.equal(result.unresolved.length,0);
  assert.equal(result.queries.length,2);
});
test("v0.1.1 resolves a List joined into SELECT and preserves field order",()=>{
  const code=source([
    "    List<String> cols = new List<String>();",
    "    cols.add('Id');",
    "    cols.add('Name');",
    "    String query = 'SELECT ' + String.join(cols, ', ') + ' FROM Account';",
    "    Database.query(query);",
  ].join("\n"));
  const result=extractDynamicSoqlQueries(code,file);
  assert.equal(result.unresolved.length,0);
  assert.equal(result.queries[0].query,"SELECT Id, Name FROM Account");
});
test("v0.1.1 does not assume unknown field-list method output",()=>{
  const code=source([
    "    List<String> fields = Utils.getFieldListFromFieldSet('Case','Details');",
    "    String query = 'SELECT ' + String.join(fields, ',') + ' FROM Case';",
    "    Database.query(query);",
  ].join("\n"));
  const result=extractDynamicSoqlQueries(code,file);
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});
test("v0.1.1 follows same-class method return values when arguments are known",()=>{
  const code=[
    "public class M {",
    "  private static String build(String fieldName) {",
    "    return 'SELECT ' + fieldName + ' FROM Account';",
    "  }",
    "  public static void run() {",
    "    String query = build('Id');",
    "    Database.query(query);",
    "  }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,file);
  assert.equal(result.unresolved.length,0);
  assert.equal(result.queries[0].query,"SELECT Id FROM Account");
});
test("v0.1.1 does not fabricate numeric LIMIT values through string addition",()=>{
  const code=source([
    "    Integer limitSize = 50;",
    "    String query = 'SELECT Id FROM Account LIMIT ' + (limitSize + 1);",
    "    Database.query(query);",
  ].join("\n"));
  const result=extractDynamicSoqlQueries(code,file);
  assert.equal(result.unresolved.length,0);
  assert.equal(result.queries[0].query,"SELECT Id FROM Account LIMIT 51");
});
