import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanApexSoqlWithUnresolved } from "../src/scanner/apexSoqlScanner.js";
import { extractDynamicSoqlQueries } from "../src/scanner/dynamicSoqlScanner.js";

test("mixed static and dynamic SOQL retains both original source locations", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-soql-"));
  try {
    const sample=[
      "public class MixedQueries {",
      "  public static void run() {",
      "    List<Account> a = [SELECT Id FROM Account];",
      "    String q = 'SELECT Name FROM Contact';",
      "    Database.query(q);",
      "    Database.query('SELECT Id FROM Opportunity');",
      "  }",
      "}",
    ].join("\n");
    await writeFile(path.join(dir,"MixedQueries.cls"),sample);
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.deepEqual(inventory.queries.map(q=>q.object).sort(),["Account","Contact","Opportunity"]);
    assert.deepEqual(inventory.queries.map(q=>q.lineNumber).sort((a,b)=>a-b),[3,5,6]);
    assert.equal(inventory.unresolvedDynamic.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("unknown client-supplied object and field list fails closed",()=>{
  const source=[
    "public class RelatedList {",
    " @AuraEnabled public static void fetch(String targetObjectApiName, String fieldList) {",
    "   String query='SELECT '+fieldList+' FROM '+targetObjectApiName;",
    "   Database.query(query);",
    " }",
    "}",
  ].join("\n");
  const r=extractDynamicSoqlQueries(source,"RelatedList.cls");
  assert.equal(r.queries.length,0);
  assert.equal(r.unresolved.length,1);
  assert.match(r.unresolved[0].reason,/runtime|dependency|symbol|unknown/i);
});
test("method-returned dynamic SELECT with unknown caller parameter stays unresolved",()=>{
  const source=[
    "public class Helper {",
    " private static String base(String field) {return 'SELECT '+field+' FROM Account';}",
    " public static void run(String userField) {",
    "   Database.query(base(userField));",
    " }",
    "}",
  ].join("\n");
  const r=extractDynamicSoqlQueries(source,"Helper.cls");
  assert.equal(r.queries.length,0);
  assert.equal(r.unresolved.length,1);
});
