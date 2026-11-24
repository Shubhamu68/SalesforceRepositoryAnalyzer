import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {ApexAnalysisEngine,analyzeApexInvocations,inspectApexInvocationContexts} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexDataFlowEngine} from "../src/core/apex/ApexDataFlowEngine.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {dynamicDatabaseQuerySelector} from "../src/core/apex/ApexInvocationModel.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";

test("multi-hop known caller variants remain separate from unknown external entry coverage",()=>{
  const gateway="public class Gateway { public static void fetch(String objectName,String fields){String q='SELECT '+fields+' FROM '+objectName; Database.query(q);} }";
  const intermediate="public class Bridge { public static void forward(String obj,String f){ Gateway.fetch(obj,f); } }";
  const caller="public class Entry { public static void run(){ Bridge.forward('Account','Id,Name'); Bridge.forward('Contact','Id,Email'); } }";
  const files=[{filePath:"Gateway.cls",source:gateway},{filePath:"Bridge.cls",source:intermediate},{filePath:"Entry.cls",source:caller}];
  const index=new ApexRepositoryMethodIndex(files);
  const method=indexApexMethods(gateway).find(m=>m.name==="fetch")!;
  const contexts=index.resolveCallerContexts("Gateway.cls",method);
  assert.equal(contexts.externallyCallable,true);
  assert.equal(contexts.known.length,2);
  const offset=gateway.indexOf("Database.query");
  const evidence=inspectApexInvocationContexts("Gateway.cls",offset,["q"],undefined,index)!;
  assert.deepEqual(evidence.arguments.map(a=>a[0]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [textValue("SELECT Id,Email FROM Contact"),textValue("SELECT Id,Name FROM Account")]);
  const report=extractDynamicSoqlQueries(gateway,"Gateway.cls",undefined,index);
  assert.equal(report.queries.length,2);
  assert.ok(report.queries.every(q=>q.coverage==="KNOWN_CALLER_CONTEXT"));
  assert.equal(report.unresolved[0].knownVariants,2);
  assert.equal(report.unresolved.length,1);
  assert.match(report.unresolved[0].reason,/structurally valid query variants in probed contexts: 2/);
});
test("unqualified static calls propagate known inputs through the repository index",()=>{
  const code="public class Entry { public static void run(){ forward('Account'); } public static void forward(String obj){ Gateway.fetch(obj); } }";
  const gateway="public class Gateway { public static void fetch(String obj){ Database.query('SELECT Id FROM '+obj); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Entry.cls",source:code},{filePath:"Gateway.cls",source:gateway}]);
  const evidence=inspectApexInvocationContexts("Gateway.cls",gateway.indexOf("Database.query"),["'SELECT Id FROM '+obj"],undefined,index)!;
  assert.deepEqual(evidence.arguments,[[textValue("SELECT Id FROM Account")]]);
  assert.equal(evidence.contexts.externallyCallable,true);
});
test("constructor initialization, alias writes and distinct allocations work through shared session",async()=>{
  const config=[
    "public class QueryConfig {",
    " public String objectName;",
    " public String fields='Id';",
    " { fields=fields+', Name'; }",
    " public QueryConfig(String obj){this.objectName=obj;}",
    "}",
  ].join("\n");
  const code=[
    "public class Consumer { public static void run(){",
    " QueryConfig first=new QueryConfig('Account');",
    " QueryConfig second=new QueryConfig('Contact');",
    " QueryConfig alias=first;",
    " alias.fields+=', Phone';",
    " Database.query('SELECT '+first.fields+' FROM '+first.objectName);",
    " Database.query('SELECT '+second.fields+' FROM '+second.objectName);",
    "} }",
  ].join("\n");
  const index=new ApexRepositoryMethodIndex([{filePath:"Consumer.cls",source:code},{filePath:"QueryConfig.cls",source:config}]);
  const result=await new ApexAnalysisEngine(index).analyze("Consumer.cls",ctx=>extractDynamicSoqlQueries(code,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query),["SELECT Id, Name, Phone FROM Account","SELECT Id, Name FROM Contact"]);
});
test("nested wrapper constructor arguments can be inspected through a non-SOQL selector",()=>{
  const code="public class Consumer { public class Config { public String field; public Config(String input){this.field=input;} } public static void run(){ Config cfg=new Config('Name'); Inspector.inspect(cfg.field); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Consumer.cls",source:code}]);
  const flow=analyzeApexInvocations(code,"Consumer.cls",name=>name==="Inspector.inspect"?{method:name,argumentIndices:[0]}:undefined,undefined,index);
  assert.equal(flow.sites.length,1);
  assert.deepEqual(flow.captures.get(flow.sites[0].offset)?.[0].arguments,[textValue("Name")]);
});
test("unknown instance mutation is not silently treated as a complete query",()=>{
  const config="public class Config { public String field; public Config(String input){this.field=input;} }";
  const code="public class Consumer { public static void run(){ Config cfg=new Config('Name'); External.modify(cfg); Database.query('SELECT '+cfg.field+' FROM Account'); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Consumer.cls",source:code},{filePath:"Config.cls",source:config}]);
  const flow=analyzeApexInvocations(code,"Consumer.cls",dynamicDatabaseQuerySelector,undefined,index);
  assert.equal(flow.captures.get(flow.sites[0].offset)?.[0].query.kind,"unknown");
});
test("unsupported constructor effects and ambiguous overloads fail closed",()=>{
  const files=[{filePath:"Config.cls",source:"public class Config { public String field; public Config(String input){this.field=input; mutate();} public void mutate(){field='Changed';} }"},
    {filePath:"Overloaded.cls",source:"public class Overloaded {public String field; public Overloaded(String a){field=a;} public Overloaded(Integer a){field='Id';}}"}];
  const index=new ApexRepositoryMethodIndex(files);
  assert.equal(index.constructInstance("Config.cls","Config",[textValue("Name")])?.kind,"unknown");
  assert.equal(index.constructInstance("Overloaded.cls","Overloaded",[textValue("Name")])?.kind,"unknown");
});
test("target-prefix scalar liveness removes paths used only after the invocation",()=>{
  const code="public class Consumer { public static void run(Boolean a,Boolean b,Boolean c){ String x=''; String y=''; String z=''; if(a){x='A';} if(b){y='B';} if(c){z='C';} Database.query('SELECT Id FROM Account'); System.debug(x+y+z); } }";
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const flow=engine.analyze();
  assert.equal(flow.exceeded,false);
  assert.deepEqual(flow.captures.get(engine.sites[0].offset)?.map(x=>x.query),[textValue("SELECT Id FROM Account")]);
});
