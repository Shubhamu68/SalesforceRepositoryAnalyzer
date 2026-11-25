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


test("constructor local calculations, known guards and compound assignments feed shared instance values",()=>{
  const source="public class Config { public String field; public Config(Boolean full){ String prefix='Id'; if(full){prefix+=', Name';} else {prefix+=', Email';} this.field=prefix; } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source}]);
  const yes=index.constructInstance("Config.cls","Config",[{kind:"text",values:["true"],scalarType:"boolean"}]);
  const no=index.constructInstance("Config.cls","Config",[{kind:"text",values:["false"],scalarType:"boolean"}]);
  assert.deepEqual(yes,{kind:"instance",className:"Config",entries:[["field",textValue("Id, Name")]]});
  assert.deepEqual(no,{kind:"instance",className:"Config",entries:[["field",textValue("Id, Email")]]});
  assert.equal(index.constructInstance("Config.cls","Config",[{kind:"unknown",reason:"runtime"}])?.kind,"unknown");
});

test("constructor delegation preserves initializer order and rejects cycles and ambiguous overloads",()=>{
  const source="public class Config { public String field='Id'; public Config(){this('Name'); field+=', Phone';} public Config(String input){field+=', '+input;} }";
  const cycle="public class Cycle { public String field; public Cycle(){this('Name');} public Cycle(String input){this();} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source},{filePath:"Cycle.cls",source:cycle}]);
  assert.deepEqual(index.constructInstance("Config.cls","Config",[]),{kind:"instance",className:"Config",entries:[["field",textValue("Id, Name, Phone")]]});
  assert.equal(index.constructInstance("Cycle.cls","Cycle",[])?.kind,"unknown");
});


test("typed custom object list retains paired fields and objects through enhanced for",async()=>{
  const wrapper="public class Config { public String objectName; public String fieldName; public Config(String obj,String field){objectName=obj;fieldName=field;} }";
  const consumer="public class Consumer { public static void run(){ List<Config> configs=new List<Config>{new Config('Account','Name'),new Config('Contact','Email')}; for(Config info:configs){ Database.query('SELECT '+info.fieldName+' FROM '+info.objectName); } } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source:wrapper},{filePath:"Consumer.cls",source:consumer}]);
  const result=await new ApexAnalysisEngine(index).analyze("Consumer.cls",ctx=>extractDynamicSoqlQueries(consumer,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query).sort(),["SELECT Email FROM Contact","SELECT Name FROM Account"]);
});

test("custom object lists support add/get and preserve tracked member aliases",async()=>{
  const wrapper="public class Config { public String field; public Config(String value){field=value;} }";
  const consumer="public class Consumer { public static void run(){ List<Config> configs=new List<Config>(); Config first=new Config('Name'); configs.add(first); first.field='Phone'; Config selected=configs.get(0); Database.query('SELECT '+selected.field+' FROM Account'); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source:wrapper},{filePath:"Consumer.cls",source:consumer}]);
  const result=await new ApexAnalysisEngine(index).analyze("Consumer.cls",ctx=>extractDynamicSoqlQueries(consumer,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query),["SELECT Phone FROM Account"]);
});

test("unknown mutation of a custom object list does not appear fully resolved",async()=>{
  const wrapper="public class Config { public String field; public Config(String value){field=value;} }";
  const consumer="public class Consumer { public static void run(){ List<Config> configs=new List<Config>{new Config('Name')}; External.modify(configs); for(Config info:configs){ Database.query('SELECT '+info.field+' FROM Account'); } } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source:wrapper},{filePath:"Consumer.cls",source:consumer}]);
  const result=await new ApexAnalysisEngine(index).analyze("Consumer.cls",ctx=>extractDynamicSoqlQueries(consumer,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});

test("structural mutation while iterating a custom object list retains uncertainty",async()=>{
  const wrapper="public class Config { public String field; public Config(String value){field=value;} }";
  const consumer="public class Consumer { public static void run(){ List<Config> configs=new List<Config>{new Config('Name'),new Config('Email')}; for(Config info:configs){ configs.clear(); Database.query('SELECT '+info.field+' FROM Account'); } } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source:wrapper},{filePath:"Consumer.cls",source:consumer}]);
  const result=await new ApexAnalysisEngine(index).analyze("Consumer.cls",ctx=>extractDynamicSoqlQueries(consumer,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(result.unresolved.length,1);
});


test("direct executeBatch allocations expose bounded receiver variants without closing framework coverage",async()=>{
  const batch="public class QueryBatch implements Database.Batchable<SObject> { private String query; public QueryBatch(String obj){query='SELECT Id FROM '+obj;} public Database.QueryLocator start(Database.BatchableContext bc){ return Database.getQueryLocator(query); } public void execute(Database.BatchableContext bc,List<SObject> scope){} public void finish(Database.BatchableContext bc){} }";
  const caller="public class Entry { public static void run(){ Database.executeBatch(new QueryBatch('Account')); Database.executeBatch(new QueryBatch('Contact'),10); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"QueryBatch.cls",source:batch},{filePath:"Entry.cls",source:caller}]);
  const result=await new ApexAnalysisEngine(index).analyze("QueryBatch.cls",ctx=>extractDynamicSoqlQueries(batch,"QueryBatch.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.deepEqual(result.queries.map(q=>q.query).sort(),["SELECT Id FROM Account","SELECT Id FROM Contact"]);
  assert.ok(result.queries.every(q=>q.coverage==="KNOWN_CALLER_CONTEXT"));
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].knownVariants,2);
});

test("framework receiver probing does not infer state after an intervening helper effect",async()=>{
  const batch="public class QueryBatch implements Database.Batchable<SObject> { private String query; public QueryBatch(String obj){query='SELECT Id FROM '+obj;} public Database.QueryLocator start(Database.BatchableContext bc){ mutate(); return Database.getQueryLocator(query); } private void mutate(){query='SELECT Id FROM Lead';} public void execute(Database.BatchableContext bc,List<SObject> scope){} public void finish(Database.BatchableContext bc){} }";
  const caller="public class Entry { public static void run(){ Database.executeBatch(new QueryBatch('Account')); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"QueryBatch.cls",source:batch},{filePath:"Entry.cls",source:caller}]);
  const result=await new ApexAnalysisEngine(index).analyze("QueryBatch.cls",ctx=>extractDynamicSoqlQueries(batch,"QueryBatch.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.ok(!result.queries.some(q=>q.query==="SELECT Id FROM Account"));
  assert.equal(result.unresolved.length,1);
});


test("repeated immutable scalar comparison facts avoid incompatible paths",()=>{
  const code="public class Builder { public static void run(String mode){ String fields='Id'; if(mode == 'Full'){fields='Name';} if(mode == 'Full'){fields+=', Phone';} Database.query('SELECT '+fields+' FROM Account'); } }";
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const result=engine.analyze();
  assert.equal(result.exceeded,false);
  assert.deepEqual(result.captures.get(engine.sites[0].offset)?.map(c=>c.query).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [textValue("SELECT Id FROM Account"),textValue("SELECT Name, Phone FROM Account")]);
});

test("comparison correlation is rejected if the parameter is reassigned",()=>{
  const code="public class Builder { public static void run(String mode){ String fields='Id'; if(mode == 'Full'){fields='Name';} mode='Full'; if(mode == 'Full'){fields+=', Phone';} Database.query('SELECT '+fields+' FROM Account'); } }";
  const engine=new ApexDataFlowEngine(code);
  const result=engine.analyze();
  assert.deepEqual(result.captures.get(engine.sites[0].offset)?.map(c=>c.query).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [textValue("SELECT Id, Phone FROM Account"),textValue("SELECT Name, Phone FROM Account")]);
});

test("batch receiver context survives a source-proven scalar local prefix",async()=>{
  const batch="public class QueryBatch implements Database.Batchable<SObject> { private String query; public QueryBatch(String obj){query='SELECT Id FROM '+obj;} public Database.QueryLocator start(Database.BatchableContext bc){ String localQuery=this.query; return Database.getQueryLocator(localQuery); } public void execute(Database.BatchableContext bc,List<SObject> scope){} public void finish(Database.BatchableContext bc){} }";
  const caller="public class Entry { public static void run(){ Database.executeBatch(new QueryBatch('Account')); } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"QueryBatch.cls",source:batch},{filePath:"Entry.cls",source:caller}]);
  const report=await new ApexAnalysisEngine(index).analyze("QueryBatch.cls",ctx=>extractDynamicSoqlQueries(batch,"QueryBatch.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.deepEqual(report.queries.map(q=>q.query),["SELECT Id FROM Account"]);
  assert.ok(report.queries.every(q=>q.coverage==="KNOWN_CALLER_CONTEXT"));
  assert.equal(report.unresolved.length,1);
});

test("constructor can use supported pure String predicates with proven scalar inputs",()=>{
  const source="public class Config { public String field; public Config(String input){if(String.isBlank(input)){field='Id';}else{field=input;}} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Config.cls",source}]);
  assert.deepEqual(index.constructInstance("Config.cls","Config",[textValue("")]),{kind:"instance",className:"Config",entries:[["field",textValue("Id")]]});
  assert.deepEqual(index.constructInstance("Config.cls","Config",[textValue("Name")]),{kind:"instance",className:"Config",entries:[["field",textValue("Name")]]});
});

test("direct leading if-condition caller contributes a bounded known query variant",()=>{
  const gateway="public class Gateway { public static Boolean fetch(String obj){Database.query('SELECT Id FROM '+obj);return true;} }";
  const caller="public class Entry { public static void run(){ if(Gateway.fetch('Account')){System.debug('done');} } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:gateway},{filePath:"Entry.cls",source:caller}]);
  const report=extractDynamicSoqlQueries(gateway,"Gateway.cls",undefined,index);
  assert.deepEqual(report.queries.map(q=>q.query),["SELECT Id FROM Account"]);
  assert.equal(report.unresolved.length,1);
});

test("non-leading short-circuited calls are not promoted to proven caller contexts",()=>{
  const gateway="public class Gateway { public static Boolean fetch(String obj){Database.query('SELECT Id FROM '+obj);return true;} }";
  const caller="public class Entry { public static void run(){ if(false && Gateway.fetch('Account')){System.debug('done');} } }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Gateway.cls",source:gateway},{filePath:"Entry.cls",source:caller}]);
  const report=extractDynamicSoqlQueries(gateway,"Gateway.cls",undefined,index);
  assert.equal(report.queries.length,0);
  assert.equal(report.unresolved.length,1);
});
