import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSoqlQueries, scanApexSoqlWithUnresolved } from "../src/scanner/apexSoqlScanner.js";
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


test("report RCA: bracketed SOQL in Database.getQueryLocator is handled only as static SOQL",()=>{
  const code=[
    "public class BatchMailAndPhoneMaskOnAccount {",
    "  public Database.QueryLocator start(Database.BatchableContext bc){",
    "    return Database.getQueryLocator([SELECT Id, Phone, MailBox__c, Domain__c, DataMasked__c",
    "      FROM Account WHERE DataMasked__c = FALSE]);",
    "  }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"BatchMailAndPhoneMaskOnAccount.cls");
  const staticQueries=extractSoqlQueries(code,"BatchMailAndPhoneMaskOnAccount.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,0);
  assert.equal(staticQueries.length,1);
  assert.equal(staticQueries[0].object,"Account");
});
test("report RCA: bracketed ErrorLogRetryBatch locator is not duplicate unresolved SOQL",()=>{
  const code=[
    "public class ErrorLogRetryBatch {",
    "  public Database.QueryLocator start(Database.BatchableContext bc){",
    "    return Database.getQueryLocator(",
    "      [SELECT Id, Event_Type__c, OrderSummary__c, Status__c FROM Error_Log__c WHERE Status__c = 'Pending']);",
    "  }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"ErrorLogRetryBatch.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,0);
  assert.equal(extractSoqlQueries(code,"ErrorLogRetryBatch.cls").length,1);
});
test("report RCA: a busy unrelated method cannot exhaust another site's budget",()=>{
  const noise=Array.from({length:5200},(_,i)=>"Integer unused"+i+" = "+i+";").join("\n");
  const code=[
    "public class ReportBudget {",
    " public static void unrelated(){",noise," }",
    " public static void fetch(){",
    "   Database.query('SELECT Id, Name FROM Account');",
    " }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"ReportBudget.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,1);
  assert.equal(scanned.queries[0].object,"Account");
});
test("report RCA: expensive query only affects its own site, not a neighboring simple query",()=>{
  const noise=Array.from({length:5205},(_,i)=>"Integer unused"+i+" = "+i+";").join("\n");
  const code=[
    "public class ReportBudget {",
    " public static void expensive(){",noise,
    "   Database.query('SELECT Id FROM Account');",
    " }",
    " public static void cheap(){",
    "   Database.query('SELECT Id FROM Contact');",
    " }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"ReportBudget.cls");
  assert.equal(scanned.unresolved.length,1);
  assert.match(scanned.unresolved[0].reason,/execution site's dependency path exceeded/i);
  assert.equal(scanned.queries.length,1);
  assert.equal(scanned.queries[0].object,"Contact");
});
test("supported string-built getQueryLocator remains dynamic rather than being suppressed",()=>{
  const code=[
    "public class DynamicLocator {",
    " public static Database.QueryLocator start() {",
    "   String q='SELECT Id FROM Account WHERE Name != null';",
    "   return Database.getQueryLocator(q);",
    " }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"DynamicLocator.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,1);
  assert.equal(scanned.queries[0].object,"Account");
});
