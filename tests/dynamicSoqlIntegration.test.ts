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
    "public class AccountMaskingBatch {",
    "  public Database.QueryLocator start(Database.BatchableContext bc){",
    "    return Database.getQueryLocator([SELECT Id, Phone, BillingCity, BillingPostalCode, Industry",
    "      FROM Account WHERE Industry = FALSE]);",
    "  }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"AccountMaskingBatch.cls");
  const staticQueries=extractSoqlQueries(code,"AccountMaskingBatch.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,0);
  assert.equal(staticQueries.length,1);
  assert.equal(staticQueries[0].object,"Account");
});
test("report RCA: bracketed RetryBatch locator is not duplicate unresolved SOQL",()=>{
  const code=[
    "public class RetryBatch {",
    "  public Database.QueryLocator start(Database.BatchableContext bc){",
    "    return Database.getQueryLocator(",
    "      [SELECT Id, Priority, Origin, Status FROM Case WHERE Status = 'Pending']);",
    "  }",
    "}",
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"RetryBatch.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.equal(scanned.queries.length,0);
  assert.equal(extractSoqlQueries(code,"RetryBatch.cls").length,1);
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
test("report RCA: irrelevant statements within the queried method no longer exhaust the site budget",()=>{
  const noise=Array.from({length:5205},(_,i)=>"Integer unused"+i+" = "+i+";").join("\n");
  const code=[
    "public class ReportBudget {",
    " public static void expensive(){",noise,
    "   Database.query('SELECT Id FROM Account');",
    " }",
    " public static void cheap(){",
    "   Database.query('SELECT Id FROM Contact');",
    " }",
    "}"
  ].join("\n");
  const scanned=extractDynamicSoqlQueries(code,"ReportBudget.cls");
  assert.equal(scanned.unresolved.length,0);
  assert.deepEqual(scanned.queries.map(q=>q.object).sort(),["Account","Contact"]);
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


test("report RCA: provably private helper receives known List fields from its caller",()=>{
 const code=[
  "public class OrderFieldQueryHelper {",
  " private static List<SObject> fetch(List<String> orderFields){",
  "   String query='SELECT Id, '+String.join(orderFields, ', ')+' FROM OrderSummary';",
  "   return Database.query(query);",
  " }",
  " public static void run(){",
  "   fetch(new List<String>{'Name','AccountId'});",
  " }",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"OrderFieldQueryHelper.cls");
 assert.equal(scanned.unresolved.length,0);
 assert.equal(scanned.queries.length,1);
 assert.equal(scanned.queries[0].query,"SELECT Id, Name, AccountId FROM OrderSummary");
});
test("report RCA: private helper accumulates every distinct known caller's query variant",()=>{
 const code=[
  "public class OrderFieldQueryHelper {",
  " private static void fetch(String field){",
  "   Database.query('SELECT '+field+' FROM Account');",
  " }",
  " public static void run(){",
  "   fetch('Id');",
  "   fetch('Name');",
  " }",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"OrderFieldQueryHelper.cls");
 assert.equal(scanned.unresolved.length,0);
 assert.deepEqual(scanned.queries.map(q=>q.query).sort(),
   ["SELECT Id FROM Account","SELECT Name FROM Account"].sort());
});
test("report RCA: unrestricted public field-list input must remain unresolved",()=>{
 const code=[
  "public class OrderFieldQueryHelper {",
  " public static void fetchOrderSummaries(List<String> fields){",
  "   Database.query('SELECT Id, '+String.join(fields, ', ')+' FROM OrderSummary');",
  " }",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"OrderFieldQueryHelper.cls");
 assert.equal(scanned.queries.length,0);
 assert.equal(scanned.unresolved.length,1);
 assert.match(scanned.unresolved[0].reason,/String\.join/i);
});
test("report RCA: private helper with one unknown caller is not falsely Resolved",()=>{
 const code=[
  "public class Helper {",
  " private static void fetch(String field){",
  "   Database.query('SELECT '+field+' FROM Account');",
  " }",
  " public static void known(){fetch('Id');}",
  " public static void unknown(String field){fetch(field);}",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"Helper.cls");
 assert.equal(scanned.queries.length,0);
 assert.equal(scanned.unresolved.length,1);
});


test("mutable SELECT-field collection passed to unknown helper must not appear fully resolved",()=>{
 const code=[
  "public class CollectionMutations {",
  " public static void run(){",
  "   List<String> fields = new List<String>{'Id'};",
  "   UnknownUtility.addMoreColumns(fields);",
  "   String q = 'SELECT '+String.join(fields, ', ')+' FROM Account';",
  "   Database.query(q);",
  " }",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"CollectionMutations.cls");
 assert.equal(scanned.queries.length,0);
 assert.equal(scanned.unresolved.length,1);
 assert.match(scanned.unresolved[0].reason,/mutable collection|String\.join/i);
});
test("known local collection operations remain resolvable after mutation guard",()=>{
 const code=[
  "public class CollectionMutations {",
  " public static void run(){",
  "   Set<String> fields = new Set<String>();",
  "   fields.add('Id');",
  "   fields.add('Name');",
  "   String q = 'SELECT '+String.join(new List<String>(fields), ', ')+' FROM Account';",
  "   Database.query(q);",
  " }",
  "}",
 ].join("\n");
 const scanned=extractDynamicSoqlQueries(code,"CollectionMutations.cls");
 assert.equal(scanned.unresolved.length,0);
 assert.equal(scanned.queries.length,1);
 assert.match(scanned.queries[0].query,/^SELECT Id, Name FROM Account$/);
});

test("site slicing prunes unrelated conditional mutations without losing relevant variants",()=>{
  const unrelated=Array.from({length:45},(_,i)=>
    "if (flag"+i+") { String note"+i+" = 'unused"+i+"'; }").join("\n");
  const code=[
    "public class SelectiveBudget {",
    " public static void run(Boolean useName) {",
    "   String query = 'SELECT Id FROM Account';",
    unrelated,
    "   if(useName){query += ' WHERE Name = :name';}",
    "   Database.query(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"SelectiveBudget.cls");
  assert.equal(result.unresolved.length,0);
  assert.deepEqual(result.queries.map(q=>q.query).sort(),[
    "SELECT Id FROM Account",
    "SELECT Id FROM Account WHERE Name = :name",
  ]);
});

test("query-relevant conditional paths are not discarded to satisfy a budget",()=>{
  const branches=Array.from({length:7},(_,i)=>
    "if (flag"+i+") {query += ' AND Field"+i+"__c = null';}").join("\n");
  const code=[
    "public class QueryPathBudget {",
    " public static void run(){",
    "   String query='SELECT Id FROM Account WHERE Name != null';",
    branches,
    "   Database.query(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"QueryPathBudget.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
  assert.match(result.unresolved[0].reason,/budget|limit|alternatives/i);
});

test("unresolved += retains original metadata or caller dependency",()=>{
  const code=[
    "public class RootCause {",
    " public static void run() {",
    "   String fields = MissingConfig.fields();",
    "   String query = 'SELECT ' + fields;",
    "   query += ' FROM Account';",
    "   Database.query(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"RootCause.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
  assert.match(result.unresolved[0].reason,/MissingConfig\.fields|unsupported/i);
});

test("optional FROM built only on one feasible path must not be assumed unconditional",()=>{
  const code=[
    "public class OptionalFrom {",
    " public static void run(String whereClause) {",
    "   String query = 'SELECT Id';",
    "   if (String.isNotBlank(whereClause)) { query += ' FROM Account WHERE ' + whereClause; }",
    "   Database.query(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"OptionalFrom.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});

test("Stage 1 regression: outer query declaration survives both OrderSummary batch branches",()=>{
  const code=[
    "public class OrderSummaryEnrichmentBatch {",
    " private List<Id> orderSummaryIds;",
    " public Database.QueryLocator start(Database.BatchableContext bc) {",
    "   String query;",
    "   if (orderSummaryIds != null && orderSummaryIds.size() > 0) {",
    "     query = 'SELECT Id, Status FROM OrderSummary WHERE Id IN :orderSummaryIds';",
    "   } else {",
    "     Integer minimumAgeMinutes = getOrderSummaryMinimumAgeMinutes();",
    "     Datetime eligibleCreatedDate = System.now().addMinutes(-minimumAgeMinutes);",
    "     query = 'SELECT Id, Status FROM OrderSummary ' +",
    "             'WHERE Status = :status ' +",
    "             'AND CreatedDate >= :createdOnOrAfter ' +",
    "             'AND CreatedDate <= :eligibleCreatedDate';",
    "   }",
    "   return Database.getQueryLocator(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"OrderSummaryEnrichmentBatch.cls");
  assert.equal(result.unresolved.length,0);
  assert.deepEqual(result.queries.map(q=>q.query).sort(),[
    "SELECT Id, Status FROM OrderSummary WHERE Id IN :orderSummaryIds",
    "SELECT Id, Status FROM OrderSummary WHERE Status = :status AND CreatedDate >= :createdOnOrAfter AND CreatedDate <= :eligibleCreatedDate",
  ].sort());
});

test("Stage 1 scope: branch-only variable cannot escape without outer declaration",()=>{
  const code=[
    "public class BranchScope {",
    " public static void run(Boolean flag) {",
    "   if(flag) { String query = 'SELECT Id FROM Account'; }",
    "   else { String query = 'SELECT Id FROM Contact'; }",
    "   Database.query(query);",
    " }",
    "}"
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"BranchScope.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});

test("Stage 2: repository-wide cross-class field-list helper resolves complete SELECT",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-cross-helper-"));
  try {
    await writeFile(path.join(dir,"FieldLibrary.cls"),[
      "public class FieldLibrary {",
      " public static List<String> fields() {return new List<String>{'Id','Name'};}",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AccountReader.cls"),[
      "public class AccountReader {",
      " public static void run() {",
      "   List<String> fields=FieldLibrary.fields();",
      "   String query='SELECT '+String.join(fields, ', ')+' FROM Account';",
      "   Database.query(query);",
      " }",
      "}",
    ].join("\n"));
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.equal(inventory.unresolvedDynamic.length,0);
    assert.deepEqual(inventory.queries.map(q=>q.query),
      ["SELECT Id, Name FROM Account"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2: caller argument is propagated into a cross-class string return",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-cross-args-"));
  try {
    await writeFile(path.join(dir,"FieldLibrary.cls"),[
      "public class FieldLibrary {",
      " public static String selectFields(String input) {",
      "   return 'Id, '+input;",
      " }",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AccountReader.cls"),[
      "public class AccountReader {",
      " public static void run() {",
      "   String fields=FieldLibrary.selectFields('Name');",
      "   Database.query('SELECT '+fields+' FROM Account WITH USER_MODE');",
      " }",
      "}",
    ].join("\n"));
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.equal(inventory.unresolvedDynamic.length,0);
    assert.equal(inventory.queries[0].query,
      "SELECT Id, Name FROM Account WITH USER_MODE");
    assert.equal(inventory.queries[0].securityMode,"USER_MODE");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2: changing cross-class helper invalidates unchanged caller scan cache",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-cross-refresh-"));
  try {
    const helper=path.join(dir,"FieldLibrary.cls");
    const reader=path.join(dir,"AccountReader.cls");
    const body=(field:string)=>[
      "public class FieldLibrary {",
      " public static String field(){return '"+field+"';}",
      "}",
    ].join("\n");
    await writeFile(helper,body("Name"));
    await writeFile(reader,[
      "public class AccountReader {",
      " public static void run(){",
      "   Database.query('SELECT Id, '+FieldLibrary.field()+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const before=await scanApexSoqlWithUnresolved(dir);
    assert.equal(before.unresolvedDynamic.length,0);
    assert.equal(before.queries[0].query,"SELECT Id, Name FROM Account");
    await writeFile(helper,body("Phone"));
    const after=await scanApexSoqlWithUnresolved(dir);
    assert.equal(after.unresolvedDynamic.length,0);
    assert.equal(after.queries[0].query,"SELECT Id, Phone FROM Account");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2: known repository caller does not prove exhaustive public field-list inputs",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-public-callers-"));
  try {
    await writeFile(path.join(dir,"FieldQuery.cls"),[
      "public class FieldQuery {",
      " public static void fetch(List<String> fields){",
      "   Database.query('SELECT '+String.join(fields, ', ')+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AccountCaller.cls"),[
      "public class AccountCaller {",
      " public static void run(){",
      "   FieldQuery.fetch(new List<String>{'Id','Name'});",
      " }",
      "}",
    ].join("\n"));
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.equal(inventory.queries.length,0);
    assert.equal(inventory.unresolvedDynamic.length,1);
    assert.match(inventory.unresolvedDynamic[0].reason,/String\.join/i);
    assert.match(inventory.unresolvedDynamic[0].reason,/externally callable/i);
    assert.match(inventory.unresolvedDynamic[0].reason,/1 known/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2: unknown cross-class field helper remains unresolved",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-cross-unknown-"));
  try {
    await writeFile(path.join(dir,"FieldLibrary.cls"),[
      "public class FieldLibrary {",
      " public static List<String> fields(String runtimeField){",
      "   return new List<String>{runtimeField};",
      " }",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AccountReader.cls"),[
      "public class AccountReader {",
      " public static void run(String userField){",
      "   List<String> fields=FieldLibrary.fields(userField);",
      "   Database.query('SELECT '+String.join(fields, ', ')+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.equal(inventory.queries.length,0);
    assert.equal(inventory.unresolvedDynamic.length,1);
    assert.match(inventory.unresolvedDynamic[0].reason,/runtime|unknown|unresolved/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2: repository helper recursion fails closed instead of fabricating columns",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-cross-cycle-"));
  try {
    await writeFile(path.join(dir,"FieldA.cls"),[
      "public class FieldA {public static String fields(){return FieldB.fields();}}",
    ].join("\n"));
    await writeFile(path.join(dir,"FieldB.cls"),[
      "public class FieldB {public static String fields(){return FieldA.fields();}}",
    ].join("\n"));
    await writeFile(path.join(dir,"AccountReader.cls"),[
      "public class AccountReader {",
      " public static void run(){Database.query('SELECT '+FieldA.fields()+' FROM Account');}",
      "}",
    ].join("\n"));
    const inventory=await scanApexSoqlWithUnresolved(dir);
    assert.equal(inventory.queries.length,0);
    assert.equal(inventory.unresolvedDynamic.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
