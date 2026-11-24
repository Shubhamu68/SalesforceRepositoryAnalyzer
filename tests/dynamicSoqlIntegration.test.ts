import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseKnownJsonMap } from "../src/core/apex/ApexValueEvaluator.js";
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

test("Stage 2 hardening: proven nested private callers resolve distinct query variants",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-private-nested-"));
  try {
    await writeFile(path.join(dir,"PrivateChain.cls"),[
      "public class PrivateChain {",
      " private static void fetch(String field){",
      "   Database.query('SELECT '+field+' FROM Account');",
      " }",
      " private static void middle(String column){fetch(column);}",
      " public static void run(){",
      "   middle('Id');",
      "   middle('Name');",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,0);
    assert.deepEqual(result.queries.map(q=>q.query).sort(),
      ["SELECT Id FROM Account","SELECT Name FROM Account"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2 hardening: unknown public input to private query remains unresolved",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-private-unknown-"));
  try {
    await writeFile(path.join(dir,"PrivateChain.cls"),[
      "public class PrivateChain {",
      " private static void fetch(String field){",
      "   Database.query('SELECT '+field+' FROM Account');",
      " }",
      " public static void known(){fetch('Id');}",
      " public static void runtimeField(String value){fetch(value);}",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.queries.length,0);
    assert.equal(result.unresolvedDynamic.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2 hardening: public query stays unresolved even with class-qualified constant callers",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-public-query-"));
  try {
    await writeFile(path.join(dir,"QueryLibrary.cls"),[
      "public class QueryLibrary {",
      " public static void fetch(List<String> fields){",
      "   Database.query('SELECT '+String.join(fields, ', ')+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"QueryCaller.cls"),[
      "public class QueryCaller {",
      " public static void run(){QueryLibrary.fetch(new List<String>{'Id','Name'});}",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.queries.length,0);
    assert.equal(result.unresolvedDynamic.length,1);
    assert.match(result.unresolvedDynamic[0].reason,/externally callable/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2 hardening: guarded fallback dynamic SOQL retains its actual unresolved dependency",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-product-fallback-"));
  try {
    await writeFile(path.join(dir,"ProductSelectorPattern.cls"),[
      "public class ProductSelectorPattern {",
      " public static void run(String input){",
      "   String query;",
      "   List<String> fields = ConfigHelper.getFields(input);",
      "   String columns = String.join(fields, ',');",
      "   String soql = 'SELECT Id, '+columns+' FROM Product2';",
      "   List<Product2> rows = Database.query(soql);",
      "   if (!rows.isEmpty()) {return;}",
      "   if (!String.isEmpty(columns)){",
      "     query = 'SELECT Id, '+columns+' FROM Product2';",
      "   }",
      "   query = String.escapeSingleQuotes(query);",
      "   Database.query(query);",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,2);
    assert.equal(result.queries.length,0);
    assert.ok(result.unresolvedDynamic.every(finding=>
      !/outside a supported method or execution path/i.test(finding.reason)));
    assert.ok(result.unresolvedDynamic.some(finding=>
      /String\\.join|ConfigHelper|columns|escapeSingleQuotes|query dependency/i.test(finding.reason)));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2 hardening: private wrapper establishes known cross-class caller evidence",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-private-wrapper-"));
  try {
    await writeFile(path.join(dir,"QueryLibrary.cls"),[
      "public class QueryLibrary {",
      " public static void fetch(String field){",
      "   Database.query('SELECT '+field+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"CallThrough.cls"),[
      "public class CallThrough {",
      " private static void forward(String input){",
      "   QueryLibrary.fetch(input);",
      " }",
      " public static void run(){forward('Name');}",
      "}",
    ].join("\n"));
    const r=await scanApexSoqlWithUnresolved(dir);
    assert.equal(r.queries.length,0);
    assert.equal(r.unresolvedDynamic.length,1);
    assert.match(r.unresolvedDynamic[0].reason,/1 known and 0 unproven/i);
    assert.match(r.unresolvedDynamic[0].reason,/externally callable/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3: org Custom Label JSON drives Product2 and Authorized Product field selections",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-label-product-"));
  const label=JSON.stringify({
    Product2:{"1":"Name","4":"ProductCode__c","5":"Description",
      "6":"Packed_Size__c","7":"Full_UPC__c","8":"Item_UPC__c",
      "9":"Client_Item_Code__c","10":"From_Date__c","11":"To_Date__c"},
    Authorized_Product__c:{"2":"Item_Code__c","3":"Store_Code__c"},
  });
  try{
    await writeFile(path.join(dir,"MetaObjectNames.cls"),[
      "public class MetaObjectNames {",
      " public static final String PRODUCT = 'Product2';",
      " public static final String AUTH = 'Authorized_' + 'Product__c';",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AdvantageConstants.cls"),[
      "public class AdvantageConstants {",
      " public static String PRODUCT_APINAME = MetaObjectNames.PRODUCT;",
      " public static String AUTHORIZED_PRODUCT_APINAME = MetaObjectNames.AUTH;",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"ProductSelectorProof.cls"),[
      "public class ProductSelectorProof {",
      " private static Map<String, List<String>> getFieldConfig() {",
      "   String labelString = System.Label.Add_Products_Configurable_Columns;",
      "   Map<String, Map<String, String>> sequencedFields = (Map<String, Map<String, String>>) JSON.deserialize(labelString, Map<String, Map<String, String>>.class);",
      "   List<String> product2Fields = new List<String>();",
      "   List<String> authProdFields = new List<String>();",
      "   for (String objectName : sequencedFields.keySet()) {",
      "     Map<String, String> fieldsMap = sequencedFields.get(objectName);",
      "     for (String seqStr : fieldsMap.keySet()) {",
      "       String fieldName = fieldsMap.get(seqStr);",
      "       if (objectName == AdvantageConstants.PRODUCT_APINAME) {product2Fields.add(fieldName);}",
      "       else if (objectName == AdvantageConstants.AUTHORIZED_PRODUCT_APINAME) {authProdFields.add(fieldName);}",
      "     }",
      "   }",
      "   return new Map<String, List<String>>{",
      "     AdvantageConstants.PRODUCT_APINAME => product2Fields,",
      "     AdvantageConstants.AUTHORIZED_PRODUCT_APINAME => authProdFields",
      "   };",
      " }",
      " public static void run() {",
      "   Map<String, List<String>> fieldConfig = getFieldConfig();",
      "   List<String> product2Fields = fieldConfig.get('Product2');",
      "   List<String> authProductFields = fieldConfig.get('Authorized_Product__c');",
      "   String query='SELECT Id, '+String.join(product2Fields, ',')+",
      "     ', (SELECT '+String.join(authProductFields, ',')+' FROM Authorized_Products__r)' +",
      "     ' FROM Product2 WITH USER_MODE';",
      "   Database.query(query);",
      " }",
      "}",
    ].join("\n"));
    const provider={
      scopeKey:"org-x/connection-1",
      getCustomLabelValue:async(name:string)=>name==="Add_Products_Configurable_Columns"
        ?{complete:true as const,source:"LIVE_ORG" as const,value:label}
        :{complete:false as const,source:"LIVE_ORG" as const,reason:"Not found"},
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const,
        reason:"Not loaded"}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const,
        reason:"Not loaded"}),
    };
    const scanned=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(scanned.unresolvedDynamic.length,0,JSON.stringify(scanned.unresolvedDynamic));
    assert.equal(scanned.queries.length,1);
    assert.match(scanned.queries[0].query,/Name,ProductCode__c,Description/);
    assert.match(scanned.queries[0].query,/Item_Code__c,Store_Code__c FROM Authorized_Products__r/);
    assert.equal(scanned.queries[0].securityMode,"USER_MODE");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3: absent Custom Label stays unresolved rather than silently using supplied field fixture",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-label-missing-"));
  try{
    await writeFile(path.join(dir,"MissingLabel.cls"),[
      "public class MissingLabel {",
      " public static void run(){",
      "   String fields=System.Label.Add_Products_Configurable_Columns;",
      "   Database.query('SELECT '+fields+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const without=await scanApexSoqlWithUnresolved(dir);
    assert.equal(without.queries.length,0);
    assert.equal(without.unresolvedDynamic.length,1);
    assert.match(without.unresolvedDynamic[0].reason,/Custom Label/i);
    const provider={
      scopeKey:"org-y/connection-1",
      getCustomLabelValue:async()=>({complete:false as const,source:"LIVE_ORG" as const,
        reason:"Insufficient metadata permissions."}),
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    };
    const withOrg=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(withOrg.queries.length,0);
    assert.equal(withOrg.unresolvedDynamic.length,1);
    assert.match(withOrg.unresolvedDynamic[0].reason,/Insufficient metadata permissions/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3: invalid JSON cannot be promoted to a verified SOQL field inventory",()=>{
  assert.equal(parseKnownJsonMap("{ invalid").kind,"unknown");
  assert.equal(parseKnownJsonMap('{"Account":["Id"]}').kind,"unknown");
});

test("Stage 3: direct SObjectType Describe supplies field whitelist for dynamic SELECT",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-direct-describe-"));
  try{
    await writeFile(path.join(dir,"DescribeFields.cls"),[
      "public class DescribeFields {",
      " public static void run(){",
      "   Map<String, Schema.SObjectField> fieldMap=OrderItemSummary.SObjectType.getDescribe().fields.getMap();",
      "   List<String> fields=new List<String>();",
      "   if(fieldMap.containsKey('Id')){fields.add('Id');}",
      "   if(fieldMap.containsKey('Status')){fields.add('Status');}",
      "   Database.query('SELECT '+String.join(fields, ',')+' FROM OrderItemSummary');",
      " }",
      "}",
    ].join("\n"));
    const provider={
      scopeKey:"org-describe-x/connection-1",
      getObjectFieldNames:async(name:string)=>name==="OrderItemSummary"
        ?{complete:true as const,source:"LIVE_ORG" as const,value:["Id","Status"]}
        :{complete:false as const,source:"LIVE_ORG" as const,reason:"Not found"},
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    };
    const resolved=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(resolved.unresolvedDynamic.length,0,JSON.stringify(resolved.unresolvedDynamic));
    assert.equal(resolved.queries[0].query,"SELECT Id,Status FROM OrderItemSummary");
    const noOrg=await scanApexSoqlWithUnresolved(dir);
    assert.equal(noOrg.queries.length,0);
    assert.equal(noOrg.unresolvedDynamic.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3: same-source org label edits invalidate cached dynamic query",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-label-refresh-"));
  try{
    await writeFile(path.join(dir,"LabelDriven.cls"),[
      "public class LabelDriven {",
      " public static void run(){",
      "   String field=System.Label.Single_Field;",
      "   Database.query('SELECT '+field+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    let label="Id";
    const provider={
      scopeKey:"same-org/same-session",
      getCustomLabelValue:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:label}),
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    };
    const first=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(first.queries[0].query,"SELECT Id FROM Account");
    label="Name";
    const second=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(second.queries[0].query,"SELECT Name FROM Account");
    assert.equal(second.unresolvedDynamic.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3 final: Custom Metadata WHERE filters reconstruct OTC field maps",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-metadata-fields-"));
  try{
    await writeFile(path.join(dir,"MetadataConstants.cls"),[
      "public class MetadataConstants {",
      " public static final String EDI = '945';",
      " public static final String TYPE = 'Draft Invoice';",
      " public static final String SOURCE = 'OrderSummary';",
      " public static final String TARGET = 'Invoice__c';",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"MetadataInvoice.cls"),[
      "public class MetadataInvoice {",
      " public static void run(){",
      "   Map<String,String> fields=new Map<String,String>();",
      "   String q='SELECT Id,';",
      "   for(Field_Mapping__mdt field : [SELECT Source_Field__c, Source_Object__c,",
      "       Target_Field__c, Target_Object__c FROM Field_Mapping__mdt",
      "       WHERE EDI_Code__c = :MetadataConstants.EDI",
      "       AND Type__c = :MetadataConstants.TYPE AND Active__c = true WITH SECURITY_ENFORCED]){",
      "     if(field.Source_Object__c == MetadataConstants.SOURCE &&",
      "        field.Target_Object__c == MetadataConstants.TARGET){",
      "       fields.put(field.Source_Field__c,field.Target_Field__c);",
      "       q += field.Source_Field__c + ',';",
      "     }",
      "   }",
      "   if(!fields.isEmpty()){Database.query(q.removeEnd(',')+' FROM OrderSummary WHERE Id IN :orderIds');}",
      " }",
      "}",
    ].join("\n"));
    const allRecords=[
      {Source_Field__c:"Status",Source_Object__c:"OrderSummary",
        Target_Field__c:"Invoice_Status__c",Target_Object__c:"Invoice__c",
        EDI_Code__c:"945",Type__c:"Draft Invoice",Active__c:true,DeveloperName:"One"},
      {Source_Field__c:"OrderNumber",Source_Object__c:"OrderSummary",
        Target_Field__c:"Invoice_Order__c",Target_Object__c:"Invoice__c",
        EDI_Code__c:"945",Type__c:"Draft Invoice",Active__c:true,DeveloperName:"Two"},
      {Source_Field__c:"Secret__c",Source_Object__c:"OrderSummary",
        Target_Field__c:"Invoice_Secret__c",Target_Object__c:"Invoice__c",
        EDI_Code__c:"946",Type__c:"Draft Invoice",Active__c:true,DeveloperName:"Excluded"},
    ];
    const provider={
      scopeKey:"org-metadata/connection-1",
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:allRecords}),
    };
    const inventory=await scanApexSoqlWithUnresolved(dir,provider);
    const dynamic=inventory.queries.filter(x=>x.dynamicOrigin);
    assert.equal(inventory.unresolvedDynamic.length,0,JSON.stringify(inventory.unresolvedDynamic));
    assert.equal(dynamic.length,1);
    assert.match(dynamic[0].query,/SELECT Id,OrderNumber,Status FROM OrderSummary/);
    assert.doesNotMatch(dynamic[0].query,/Secret__c/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3 final: unproven Custom Metadata WHERE bind cannot manufacture fields",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-metadata-unknown-"));
  try{
    await writeFile(path.join(dir,"RuntimeMetadata.cls"),[
      "public class RuntimeMetadata {",
      " public static void run(String edi){",
      "   String q='SELECT Id,';",
      "   for(Field_Mapping__mdt field : [SELECT Source_Field__c FROM Field_Mapping__mdt",
      "       WHERE EDI_Code__c = :edi AND Active__c = true]){",
      "     q += field.Source_Field__c + ',';",
      "   }",
      "   Database.query(q.removeEnd(',')+' FROM OrderSummary');",
      " }",
      "}",
    ].join("\n"));
    const provider={
      scopeKey:"org-metadata-unknown",
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:[
        {Source_Field__c:"Secret__c",EDI_Code__c:"945",Active__c:true},
      ]}),
    };
    const inventory=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(inventory.queries.filter(x=>x.dynamicOrigin).length,0);
    assert.equal(inventory.unresolvedDynamic.length,1);
    assert.match(inventory.unresolvedDynamic[0].reason,/runtime|unproven|metadata/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3 final: Field Set Describe members generate exact field list",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-fieldset-fields-"));
  try{
    await writeFile(path.join(dir,"FieldSetConsumer.cls"),[
      "public class FieldSetConsumer {",
      " public static void run(){",
      "   Schema.FieldSet fs=Account.SObjectType.getDescribe().fieldSets.getMap().get('Export_Fields');",
      "   List<Schema.FieldSetMember> members=fs.getFields();",
      "   List<String> fields=new List<String>();",
      "   for(Schema.FieldSetMember m : members){",
      "     fields.add(m.getFieldPath());",
      "   }",
      "   Database.query('SELECT '+String.join(fields, ',')+' FROM Account WITH USER_MODE');",
      " }",
      "}",
    ].join("\n"));
    const provider={
      scopeKey:"org-fieldset/connection-1",
      getFieldSetFields:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:["Id","Name","Phone"]}),
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    };
    const inventory=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(inventory.unresolvedDynamic.length,0,JSON.stringify(inventory.unresolvedDynamic));
    assert.equal(inventory.queries.filter(x=>x.dynamicOrigin)[0].query,
      "SELECT Id,Name,Phone FROM Account WITH USER_MODE");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 3 final: inaccessible Field Set members cannot be used as verified query fields",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-fieldset-missing-"));
  try{
    await writeFile(path.join(dir,"FieldSetConsumer.cls"),[
      "public class FieldSetConsumer {",
      " public static void run(){",
      "   List<String> fields=Utils.getFieldListFromFieldSet('Account','Export_Fields');",
      "   Database.query('SELECT '+String.join(fields,',')+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const provider={
      scopeKey:"org-fieldset/missing",
      getFieldSetFields:async()=>({complete:false as const,source:"LIVE_ORG" as const,
        reason:"Field Set metadata permission denied"}),
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    };
    const inventory=await scanApexSoqlWithUnresolved(dir,provider);
    assert.equal(inventory.queries.filter(x=>x.dynamicOrigin).length,0);
    assert.equal(inventory.unresolvedDynamic.length,1);
    assert.match(inventory.unresolvedDynamic[0].reason,/Field Set|permission/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Stage 2 hardening: multiline SOQL concatenation ignores Apex source comments",()=>{
  const code=[
    "public class CommentedQuery {",
    " public static void run(){",
    "   String q='SELECT Id, ';",
    "   q += // internal note, not a field name",
    "       'Name FROM Account ' +",
    "       // ignored line between terms",
    "       'WHERE IsDeleted = false';",
    "   Database.query(q);",
    " }",
    "}",
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"CommentedQuery.cls");
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.equal(result.queries.length,1);
  assert.equal(result.queries[0].query,
    "SELECT Id, Name FROM Account WHERE IsDeleted = false");
});

test("v0.1.1 genuine cross-class static initializer chain builds complete dynamic SOQL",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-constant-chain-"));
  try {
    await writeFile(path.join(dir,"StaticObjects.cls"),[
      "public class StaticObjects {",
      " public static final String PRODUCT2 = 'Product2';",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"AdvantageConstants.cls"),[
      "public class AdvantageConstants {",
      " public static final String PRODUCT_APINAME = StaticObjects.PRODUCT2;",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"ProductQuery.cls"),[
      "public class ProductQuery {",
      " public static void run(){",
      "   String q = 'SELECT Id FROM '+AdvantageConstants.PRODUCT_APINAME;",
      "   Database.query(q);",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.deepEqual(result.queries.map(x=>x.query),["SELECT Id FROM Product2"]);
    assert.equal(result.unresolvedDynamic.length,0);
  }finally {await rm(dir,{recursive:true,force:true});}
});

test("v0.1.1 public nonfinal object name resolves from declared initializer",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-constant-mutable-"));
  try{
    await writeFile(path.join(dir,"AdvantageConstants.cls"),[
      "public class AdvantageConstants {",
      " public static String PRODUCT_APINAME = 'Product2';",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"ProductQuery.cls"),[
      "public class ProductQuery {",
      " public static void run(){",
      "   Database.query('SELECT Id FROM '+AdvantageConstants.PRODUCT_APINAME);",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,0);
    assert.deepEqual(result.queries.map(q=>q.query),["SELECT Id FROM Product2"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("v0.1.1 missing AdvantageConstants source yields explicit missing-class diagnostic",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-constant-missing-"));
  try{
    await writeFile(path.join(dir,"ProductQuery.cls"),[
      "public class ProductQuery {",
      " public static void run(){",
      "   Database.query('SELECT Id FROM '+AdvantageConstants.PRODUCT_APINAME);",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.queries.length,0);
    assert.equal(result.unresolvedDynamic.length,1);
    assert.match(result.unresolvedDynamic[0].reason,/AdvantageConstants.*missing/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("actual nonfinal AdvantageConstants Product Selector map key participates in query reconstruction",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-real-advantage-"));
  try {
    await writeFile(path.join(dir,"AdvantageConstants.cls"),[
      "public class AdvantageConstants {",
      " public static String PRODUCT_APINAME='Product2';",
      " public static String AUTHORIZED_PRODUCT_APINAME='Authorized_Product__c';",
      " public static final String TRX_SET_945 = '945';",
      "}",
    ].join("\n"));
    await writeFile(path.join(dir,"MutableProductSelector.cls"),[
      "public class MutableProductSelector {",
      " public static void run(){",
      "   Map<String, List<String>> fieldConfig = new Map<String, List<String>>{",
      "     AdvantageConstants.PRODUCT_APINAME => new List<String>{'Id','Name'}",
      "   };",
      "   List<String> fields = fieldConfig.get('Product2');",
      "   Database.query('SELECT '+String.join(fields,',')+' FROM Product2');",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,0);
    assert.deepEqual(result.queries.map(q=>q.query),["SELECT Id,Name FROM Product2"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("scope-aware final fields participate in real dynamic query building",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-modifier-scope-"));
  try{
    await writeFile(path.join(dir,"FieldScopes.cls"),[
      "public class FieldScopes {",
      " private static final String STATIC_FIELD = 'Id';",
      " private final String INSTANCE_FIELD = 'Name';",
      " public static void staticQuery(){",
      "   Database.query('SELECT '+STATIC_FIELD+' FROM Account');",
      " }",
      " public void instanceQuery(){",
      "   Database.query('SELECT '+this.INSTANCE_FIELD+' FROM Contact');",
      " }",
      " public static void shadowedQuery(){",
      "   final String STATIC_FIELD = 'Phone';",
      "   Database.query('SELECT '+STATIC_FIELD+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,0,JSON.stringify(result.unresolvedDynamic));
    assert.deepEqual(result.queries.map(x=>x.query).sort(),[
      "SELECT Id FROM Account","SELECT Name FROM Contact","SELECT Phone FROM Account",
    ].sort());
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("instance-final field cannot be used as a static class-qualified constant",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-instance-not-static-"));
  try{
    await writeFile(path.join(dir,"BadFieldScope.cls"),[
      "public class BadFieldScope {",
      " public final String ITEM_FIELD = 'Name';",
      " public static void run(){",
      "   Database.query('SELECT '+BadFieldScope.ITEM_FIELD+' FROM Account');",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.queries.length,0);
    assert.equal(result.unresolvedDynamic.length,1);
    assert.match(result.unresolvedDynamic[0].reason,/instance field.*not static/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("blank final member is not inferred from static initializer side effects",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-static-blank-"));
  try{
    await writeFile(path.join(dir,"BlankField.cls"),[
      "public class BlankField {",
      " public static final String Q;",
      " static { Q='Name'; }",
      " public static void run(){Database.query('SELECT '+BlankField.Q+' FROM Account');}",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.queries.length,0);
    assert.equal(result.unresolvedDynamic.length,1);
    assert.match(result.unresolvedDynamic[0].reason,/no declaration initializer/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("declared class-member snapshot does not freeze reassigned method-local query variables",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"v011-local-snapshot-"));
  try{
    await writeFile(path.join(dir,"LocalMutation.cls"),[
      "public class LocalMutation {",
      " public static String FIELD = 'Name';",
      " public String INSTANCE_FIELD = 'Phone';",
      " public static void run(){",
      "   String fieldName = LocalMutation.FIELD;",
      "   fieldName = 'Id';",
      "   Database.query('SELECT '+fieldName+' FROM Account');",
      " }",
      " public void runInstance(){",
      "   Database.query('SELECT '+this.INSTANCE_FIELD+' FROM Contact');",
      " }",
      "}",
    ].join("\n"));
    const result=await scanApexSoqlWithUnresolved(dir);
    assert.equal(result.unresolvedDynamic.length,0,JSON.stringify(result.unresolvedDynamic));
    assert.deepEqual(result.queries.map(q=>q.query).sort(),
      ["SELECT Id FROM Account","SELECT Phone FROM Contact"].sort());
  }finally{await rm(dir,{recursive:true,force:true});}
});
