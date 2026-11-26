import assert from "node:assert/strict";
import {test} from "node:test";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {proveLocalSoqlPermissionShape} from "../src/analyzer/soqlSourceStructuralEvidence.js";
import {proveCallerPermissionShapes,proveLiteralHelperPermissionShapes} from "../src/analyzer/soqlCallerStructuralEvidence.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {proveLabelBackedPermissionShapes} from "../src/analyzer/soqlLabelStructuralEvidence.js";
import {aggregatePermissionShapes,simplePermissionShape} from "../src/analyzer/soqlPermissionAggregation.js";
import {dynamicDatabaseQuerySelector,discoverApexInvocations} from "../src/core/apex/ApexInvocationModel.js";
import {extractSoqlExpressionFields} from "../src/analyzer/soqlExpressionInventory.js";
import {provePartialSoql} from "../src/analyzer/soqlPartialStructure.js";
import {addApexValues,runtimeParameter,textValue} from "../src/core/apex/ApexValueEvaluator.js";

const fixture=[
  "public class Selector {",
  " public class Filter { @InvocableVariable public Date fromDate; @InvocableVariable public Date toDate; }",
  " public static List<SObject> run(Filter input,Boolean flag,Boolean sort,Set<Id> ids){",
  "  String query = 'SELECT Id, ' + (flag ? 'Name, ' : '') + 'Phone FROM Account WHERE CreatedDate >= '",
  "    + String.valueOf(input.fromDate).substring(0,10) + ' AND CreatedDate <= ' + String.valueOf(input.toDate).substring(0,10) + ' AND ';",
  "  if(flag){query += 'Industry = \\'Retail\\' AND ';} else {query += 'AnnualRevenue > 0 AND ';}",
  "  if(ids!=null){query += 'Id IN :ids';}",
  "  if(query.endsWith('AND ')){query=query.substring(0,query.length()-4);}",
  "  if(sort){query += ' ORDER BY LastModifiedDate ASC';}",
  "  return Database.query(query,AccessLevel.USER_MODE);",
  " }",
  "}"
].join("\n");
function proof(code:string){
  const site=discoverApexInvocations(code,dynamicDatabaseQuerySelector)[0];
  return proveLocalSoqlPermissionShape(code,site);
}
test("SOQL-only structural aggregation of typed wrapper dates, conditional SELECT, predicates and ORDER BY",()=>{
  const result=proof(fixture);
  assert.equal(result.length,1,JSON.stringify(result));
  const fields=extractSoqlExpressionFields(result[0]);
  assert.equal(fields.parsed,true,JSON.stringify(fields));
  assert.deepEqual(new Set(fields.fields.map(f=>f.context+":"+f.fieldPath)),
    new Set(["SELECT:Id","SELECT:Name","SELECT:Phone","WHERE:CreatedDate","WHERE:Industry","WHERE:AnnualRevenue","WHERE:Id","ORDER_BY:LastModifiedDate"]));
  const scan=extractDynamicSoqlQueries(fixture,"Selector.cls");
  assert.equal(scan.queries.length,1,JSON.stringify(scan));
  assert.equal(scan.queries[0].coverage,"PROVEN_PARTIAL_STRUCTURE");
  assert.equal(scan.queries[0].dynamicAccessLevel,"USER_MODE");
  assert.equal(scan.unresolved.length,1);
  assert.match(scan.unresolved[0].reason,/Permission inventory aggregated/);
});
test("unknown structural input and mode are not replaced by arbitrary placeholders",()=>{
  for(const source of [
    fixture.replace("public Date fromDate","public String fromDate"),
    fixture.replace("query += 'Industry = \\'Retail\\' AND ';","query += input.fromDate;"),
    fixture.replace("'Phone FROM Account WHERE CreatedDate >= '","'Phone FROM '+input.fromDate+' WHERE CreatedDate >= '"),
    fixture.replace("query += ' ORDER BY LastModifiedDate ASC';","query = Other.rewrite(query);")
  ])assert.deepEqual(proof(source),[],source);
  const unknownMode=fixture.replace("AccessLevel.USER_MODE","runtimeMode");
  assert.equal(extractDynamicSoqlQueries(unknownMode,"Selector.cls").queries.length,0);
});
test("aggregate distinct object and execution-mode groups without converting WHERE to SELECT",()=>{
  const queries=[
    "SELECT Name FROM Account WHERE Industry = 'Retail' WITH SECURITY_ENFORCED",
    "SELECT Phone FROM Account WHERE AnnualRevenue > 0 WITH SECURITY_ENFORCED",
    "SELECT Email FROM Contact WITH SECURITY_ENFORCED",
    "SELECT Id FROM Account WITH USER_MODE"
  ];
  const shapes=queries.map(s=>simplePermissionShape(s)!);
  assert.ok(shapes.every(Boolean));
  const result=aggregatePermissionShapes(shapes);
  assert.equal(result.length,3);
  const account=result.find(s=>s.includes("SECURITY_ENFORCED")&&s.includes("FROM Account"))!;
  assert.deepEqual(new Set(extractSoqlExpressionFields(account).fields.map(f=>f.context+":"+f.fieldPath)),
    new Set(["SELECT:Name","SELECT:Phone","WHERE:Industry","WHERE:AnnualRevenue"]));
  assert.equal(simplePermissionShape("SELECT Id,(SELECT Id FROM Contacts) FROM Account"),undefined);
});
test("typed date and boolean are value slots only, arbitrary Strings and object holes remain unknown",()=>{
  for(const [type,value] of [["Date","2000-01-01"],["Datetime","2000-01-01T00:00:00Z"],["Boolean","true"],["Decimal","0"]]){
    const hole=runtimeParameter("v",type,"runtime");
    assert.equal(provePartialSoql(addApexValues(textValue("SELECT Name FROM Account WHERE CreatedDate >= "),hole))?.text,
      "SELECT Name FROM Account WHERE CreatedDate >= "+value);
    assert.equal(provePartialSoql(addApexValues(textValue("SELECT Name FROM "),hole)),undefined);
    assert.equal(provePartialSoql(addApexValues(textValue("SELECT "),hole)),undefined);
  }
});
test("arbitrary UI-selected field list remains a review, not invented fields",()=>{
  const source="public class UI { @AuraEnabled public static void run(String fields){ List<String> names=new List<String>(); for(String field:fields.split(',')){names.add(field);} String q='SELECT '+String.join(names,',')+' FROM Account'; Database.query(q); } }";
  const result=extractDynamicSoqlQueries(source,"UI.cls");
  assert.equal(result.queries.length,0,JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
});

test("correlated incomplete identifier pieces cannot manufacture new field combinations",()=>{
  const code="public class Builder { public static void run(Boolean flag,Date d){ String q='SELECT '+(flag?'Billing':'Shipping')+(flag?'Street':'City')+' FROM Account WHERE CreatedDate >= '+d; Database.query(q); } }";
  assert.deepEqual(proof(code),[]);
});
test("unknown loop or opaque field source cannot be rescued by a known zero-iteration capture",()=>{
  const code="public class Builder { public static void run(List<String> input){ String q='SELECT Id FROM Account'; for(String field:input){q+=' WHERE '+field+' != null';} Database.query(q); } }";
  const result=extractDynamicSoqlQueries(code,"Builder.cls");
  assert.equal(result.queries.length,0,JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
});

test("all cached caller seeds contribute distinct field evidence without increasing execution probe budget",()=>{
  const source="public class Service { public static void fetch(String predicate){String q='SELECT Id FROM Account WHERE '+predicate;Database.query(q);} }";
  const caller="public class Entry { public static void run(){"+Array.from({length:12},(_,i)=>"Service.fetch('Field"+i+"__c != null');").join("")+"} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Service.cls",source},{filePath:"Entry.cls",source:caller}]);
  const result=extractDynamicSoqlQueries(source,"Service.cls",undefined,index);
  const inventory=new Set(result.queries.flatMap(q=>extractSoqlExpressionFields(q.query).fields.map(f=>f.context+":"+f.fieldPath)));
  for(let i=0;i<12;i++)assert.ok(inventory.has("WHERE:Field"+i+"__c"),JSON.stringify(result));
  assert.equal(result.queries.filter(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE").length,1,JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].aggregatedPermissionInventories,1);
});
test("caller templates reject mutable parameters and never substitute unproven structural strings",()=>{
  const code="public class Service { public static void fetch(String fields){String q='SELECT '+fields+' FROM Account';Database.query(q);} }";
  const site=discoverApexInvocations(code,dynamicDatabaseQuerySelector)[0];
  assert.deepEqual(proveCallerPermissionShapes(code,site,[[runtimeParameter("fields","String","UI input")]]),[]);
  const changed=code.replace("String q=","fields=Other.load();String q=");
  assert.deepEqual(proveCallerPermissionShapes(changed,discoverApexInvocations(changed,dynamicDatabaseQuerySelector)[0],[[textValue("Name")]]),[]);
});
test("literal helper alternatives stay grouped by object and mode and retain unknown execution coverage",()=>{
  const code="public class Cleanup { public static void run(Integer step){String q=build(step);Database.query(q);} private static String build(Integer step){if(step==1){return 'SELECT Name FROM Account';}else if(step==2){return 'SELECT Industry FROM Account';}else if(step==3){return 'SELECT Email FROM Contact WITH USER_MODE';}return null;} }";
  const site=discoverApexInvocations(code,dynamicDatabaseQuerySelector)[0];
  const alternatives=proveLiteralHelperPermissionShapes(code,site);
  assert.equal(alternatives.length,3,JSON.stringify(alternatives));
  const grouped=aggregatePermissionShapes(alternatives.map(s=>simplePermissionShape(s)!));
  assert.equal(grouped.length,2);
  const result=extractDynamicSoqlQueries(code,"Cleanup.cls");
  assert.equal(result.queries.length,2,JSON.stringify(result));
  assert.equal(result.queries.filter(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE").length,2);
  assert.equal(result.unresolved.length,1);
  const unknown=code.replace("return null;","return Other.load();");
  assert.deepEqual(proveLiteralHelperPermissionShapes(unknown,discoverApexInvocations(unknown,dynamicDatabaseQuerySelector)[0]),[]);
});

test("read-only label-backed cache is resolved independently of batch static lifetime and runtime dates",()=>{
  const code=[
    "public class Worker {",
    " private static List<String> cached;",
    " private Date sinceDate;",
    " private void detect(){List<String> fields=getFields();if(fields.isEmpty())return;fetch(fields);}",
    " private void display(){List<String> fields=getFields();if(fields.isEmpty())return;for(String field:fields){System.debug(field);}}",
    " private List<Account> fetch(List<String> fields){String q='SELECT '+String.join(fields,',')+' FROM Account WHERE CreatedDate >= '+dateFilter();return (List<Account>)Database.query(q);}",
    " private String dateFilter(){DateTime dt=DateTime.newInstance(sinceDate,Time.newInstance(0,0,0,0));return dt.formatGMT('yyyy-MM-dd\\'T\\'HH:mm:ss\\'Z\\'');}",
    " private static List<String> getFields(){if(cached!=null)return cached;cached=new List<String>();if(String.isBlank(Label.Fields))return cached;String normalized=Label.Fields.replace(';',',');for(String field:normalized.split(',')){if(!String.isBlank(field)){cached.add(field.trim());}}return cached;}",
    "}"
  ].join("\n");
  let reads=0;
  const resolver=(name:string,args:import("../src/core/apex/ApexValueEvaluator.js").ApexValue[])=>{
    if(name==="System.Label"){reads++;assert.deepEqual(args,[textValue("Fields")]);return textValue("Id; Name,  Industry ,");}
    return undefined;
  };
  const site=discoverApexInvocations(code,dynamicDatabaseQuerySelector)[0];
  const result=proveLabelBackedPermissionShapes(code,site,resolver);
  assert.equal(result.length,1,JSON.stringify(result));
  assert.deepEqual(new Set(extractSoqlExpressionFields(result[0]).fields.map(f=>f.context+":"+f.fieldPath)),new Set(["SELECT:Id","SELECT:Name","SELECT:Industry","WHERE:CreatedDate"]));
  assert.equal(reads,1);
  for(const changed of [
    code.replace("fetch(fields);","fields.add('Secret__c');fetch(fields);"),
    code.replace("System.debug(field);","Other.mutate(fields);"),
    code.replace("private Date sinceDate;","private String sinceDate;"),
    code.replace("private static List<String> cached;","public static List<String> cached;")
  ]){
    assert.deepEqual(proveLabelBackedPermissionShapes(changed,discoverApexInvocations(changed,dynamicDatabaseQuerySelector)[0],resolver),[],changed);
  }
});


test("aggregate COUNT() object evidence does not invent SELECT Id or drop WHERE fields",()=>{
 const count=simplePermissionShape("SELECT COUNT() FROM Account");
 assert.ok(count?.countOnly);
 assert.deepEqual(count.fields,[]);
 assert.deepEqual(aggregatePermissionShapes([count]),["SELECT COUNT() FROM Account"]);
 const filtered=simplePermissionShape("SELECT COUNT() FROM Account WHERE Name != null");
 assert.ok(filtered?.countOnly);
 assert.deepEqual(aggregatePermissionShapes([count,filtered]),["SELECT COUNT() FROM Account WHERE Name != null"]);
});
