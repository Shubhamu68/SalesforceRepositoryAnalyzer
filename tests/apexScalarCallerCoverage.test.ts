import assert from "node:assert/strict";
import {test} from "node:test";
import {evaluateApexExpression,textValue,booleanValue,unknown,runtimeParameter,describePartialApexText} from "../src/core/apex/ApexValueEvaluator.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";

test("typed null differs from string null, empty string and runtime unknown",()=>{
  const values=new Map([["runtime",unknown("external")]]);
  const evaluate=(expr:string)=>evaluateApexExpression(expr,{values});
  assert.deepEqual(evaluate("null"),{kind:"null"});
  assert.deepEqual(evaluate("'null'"),textValue("null"));
  assert.deepEqual(evaluate("null == null"),booleanValue(true));
  assert.deepEqual(evaluate("'null' == null"),booleanValue(false));
  assert.deepEqual(evaluate("'' != null"),booleanValue(true));
  assert.deepEqual(evaluate("String.isBlank(null)"),booleanValue(true));
  assert.deepEqual(evaluate("String.isNotBlank(null)"),booleanValue(false));
  assert.equal(evaluate("runtime == null").kind,"unknown");
  assert.deepEqual(evaluate("null != null && runtime > 0"),booleanValue(false));
});
test("numeric comparisons and exact arithmetic respect precedence and unsupported precision stays unknown",()=>{
  const evaluate=(expr:string)=>evaluateApexExpression(expr,{values:new Map()});
  assert.deepEqual(evaluate("2 + 3 * 4 >= 14"),booleanValue(true));
  assert.deepEqual(evaluate("10 - 3 - 2"),{kind:"number",value:5});
  assert.deepEqual(evaluate("8 / 2"),{kind:"number",value:4});
  assert.deepEqual(evaluate("3 + -2"),{kind:"number",value:1});
  assert.deepEqual(evaluate("null >= 0"),booleanValue(false));
  assert.equal(evaluate("1 / 0").kind,"unknown");
  assert.equal(evaluate("5 / 2").kind,"unknown");
  assert.equal(evaluate("2147483647 + 1").kind,"unknown");
  assert.deepEqual(evaluate("'Account' == 'account'"),booleanValue(true));
  assert.deepEqual(evaluate("new List<String>{'Id','Name'}"),{kind:"collection",items:["Id","Name"],unique:false});
});
const service=[
  "public class Gateway {",
  " public static void fetch(String objectName,List<String> fields,String filter,Integer pageSize,Integer offsetSize){",
  "  String query='SELECT '+String.join(fields,', ')+' FROM '+objectName;",
  "  if(String.isNotBlank(filter)){query+=' WHERE '+filter;}",
  "  if(pageSize!=null && pageSize>0){query+=' LIMIT '+pageSize;}",
  "  if(offsetSize!=null && offsetSize>=0){query+=' OFFSET '+offsetSize;}",
  "  Database.query(query);",
  " }",
  "}",
].join("\n");
test("actual pagination pattern: known null and integer caller inputs yield complete variants",()=>{
  const caller="public class Entry {public static void run(){ Gateway.fetch('Account',new List<String>{'Id','Name'},null,25,0); Gateway.fetch('Contact',new List<String>{'Id','Email'},null,null,null); }}";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:service},{filePath:"Entry.cls",source:caller}]);
  const result=extractDynamicSoqlQueries(service,"Gateway.cls",undefined,index);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].knownVariants,2);
  assert.ok(result.queries.every(q=>q.coverage==="KNOWN_CALLER_CONTEXT"));
  assert.deepEqual(result.queries.map(q=>q.query).sort(),["SELECT Id, Email FROM Contact","SELECT Id, Name FROM Account LIMIT 25 OFFSET 0"]);
});
test("unknown bind values do not hide known query structure, but external entry remains unverified",()=>{
  const code="public class Gateway { public static void fetch(String objectName,Id recordId){Database.query('SELECT Id FROM '+objectName+' WHERE Id = :recordId',AccessLevel.USER_MODE);} }";
  const caller="public class Entry { public static void run(Id runtimeId){Gateway.fetch('Account',runtimeId);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:code},{filePath:"Entry.cls",source:caller}]);
  const result=extractDynamicSoqlQueries(code,"Gateway.cls",undefined,index);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.queries.length,1);
  assert.equal(result.queries[0].coverage,"KNOWN_CALLER_CONTEXT");
  assert.equal(result.queries[0].query,"SELECT Id FROM Account WHERE Id = :recordId");
  assert.equal(result.queries[0].dynamicAccessLevel,"USER_MODE");
});
test("unknown structural fragments and unknown access mode do not produce a false grant",()=>{
  const code="public class Gateway { public static void fetch(String objectName,String fields,AccessLevel mode){Database.query('SELECT '+fields+' FROM '+objectName,mode);} }";
  const caller="public class Entry { public static void run(String fields){Gateway.fetch('Account',fields,AccessLevel.USER_MODE);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:code},{filePath:"Entry.cls",source:caller}]);
  const result=extractDynamicSoqlQueries(code,"Gateway.cls",undefined,index);
  assert.equal(result.unresolved.length,1);assert.equal(result.queries.length,0);
});


test("typed symbolic concatenation retains ordered fragments but never becomes executable query text",()=>{
  const values=new Map([["size",runtimeParameter("size","Integer","runtime pagination")],["fields",runtimeParameter("fields","String","runtime field inventory")]]);
  const result=evaluateApexExpression("'SELECT '+fields+' FROM Account LIMIT '+size",{values});
  assert.equal(result.kind,"unknown");
  if(result.kind!=="unknown")return;
  assert.deepEqual(result.fragments,[
    {kind:"literal",text:"SELECT "},
    {kind:"hole",symbol:{name:"fields",type:"string"}},
    {kind:"literal",text:" FROM Account LIMIT "},
    {kind:"hole",symbol:{name:"size",type:"integer"}},
  ]);
  assert.match(describePartialApexText(result),/2 known text fragment\(s\), 2 unknown fragment\(s\).*integer, string/);
  assert.doesNotMatch(describePartialApexText(result),/Account/);
});

test("symbolic runtime pagination and structural inputs retain REVIEW and mask literal contents",()=>{
  const code="public class QueryService { public static void run(Integer pageSize){String q='SELECT Id FROM Account'; q+=' LIMIT '+pageSize; Database.query(q);} }";
  const result=extractDynamicSoqlQueries(code,"QueryService.cls");
  assert.equal(result.queries.length,1);
  assert.equal(result.queries[0].coverage,"PROVEN_PARTIAL_STRUCTURE");
  assert.equal(result.unresolved[0].partialStructureVariants,1);
  assert.equal(result.unresolved.length,1);
  assert.match(result.unresolved[0].reason,/Partial expression evidence.*integer/);
});

test("single partial query argument retains source structure across explicit multi-hop callers",()=>{
  const gateway="public class Gateway { public static void fetch(String query){Database.query(query);} }";
  const relay="public class Relay { public static void forward(String query){Gateway.fetch(query);} }";
  const entry="public class Entry { public static void run(Integer size){Relay.forward('SELECT Name FROM Account LIMIT '+size);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:gateway},{filePath:"Relay.cls",source:relay},{filePath:"Entry.cls",source:entry}]);
  const result=extractDynamicSoqlQueries(gateway,"Gateway.cls",undefined,index);
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account LIMIT 1"&&q.coverage==="PROVEN_PARTIAL_STRUCTURE"),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].knownVariants,undefined);
});
test("fragment-only context never proves arbitrary runtime structural strings",()=>{
  const gateway="public class Gateway { public static void fetch(String query){Database.query(query);} }";
  const entry="public class Entry { public static void run(String fields){Gateway.fetch('SELECT '+fields+' FROM Account');} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:gateway},{filePath:"Entry.cls",source:entry}]);
  const result=extractDynamicSoqlQueries(gateway,"Gateway.cls",undefined,index);
  assert.equal(result.queries.length,0,JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
});
test("direct private instance calls contribute argument evidence without receiver-state claims",()=>{
  const source="public class Controller {public void run(String obj){fetch(obj);} public void known(){this.fetch('Account');} private void fetch(String obj){Database.query('SELECT Name FROM '+obj);}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"Controller.cls",source}]);
  const evidence=index.probeInvocationContexts("Controller.cls",source.indexOf("Database.query"),["'SELECT Name FROM '+obj"]);
  assert.ok(evidence?.arguments.some(args=>args[0].kind==="text"&&args[0].values.includes("SELECT Name FROM Account")),JSON.stringify(evidence));
  const result=extractDynamicSoqlQueries(source,"Controller.cls",undefined,index);
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="KNOWN_CALLER_CONTEXT"),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
});
test("private instance argument evidence does not transfer unknown receiver state or nested effects",()=>{
  const base="public class Controller {private String fields;public void run(String obj){fetch(obj);} public void known(){CALL} private List<SObject> fetch(String obj){return Database.query(QUERY);}}";
  for(const [call,query] of [
    ["this.fetch('Account');","'SELECT '+fields+' FROM '+obj"],
    ["Other.consume(this.fetch('Account'));","'SELECT Name FROM '+obj"],
    ["this.fetch(Other.getObject());","'SELECT Name FROM '+obj"]
  ]){
    const source=base.replace("CALL",call).replace("QUERY",query);
    const index=new ApexRepositoryMethodIndex([{filePath:"Controller.cls",source}]);
    const evidence=index.probeInvocationContexts("Controller.cls",source.indexOf("Database.query"),[query]);
    assert.ok(!evidence?.arguments.some(args=>args[0].kind==="text"&&args[0].values.some(v=>v.startsWith("SELECT "))),JSON.stringify(evidence));
  }
});
test("mixed-case private callers cannot silently disappear from exhaustive closure",()=>{
  const source="public class Controller {public static void known(){fetch('Account');} public static void open(String obj){FETCH(obj);} private static void fetch(String obj){Database.query('SELECT Name FROM '+obj);}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"Controller.cls",source}]);
  const result=extractDynamicSoqlQueries(source,"Controller.cls",undefined,index);
  assert.equal(result.unresolved.length,1,JSON.stringify(result));
  assert.ok(!result.queries.some(q=>q.coverage===undefined),JSON.stringify(result));
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="KNOWN_CALLER_CONTEXT"),JSON.stringify(result));
});
