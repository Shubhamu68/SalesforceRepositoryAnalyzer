import assert from "node:assert/strict";
import {test} from "node:test";
import {readdirSync,readFileSync} from "node:fs";
import path from "node:path";
import {traceApexDependencies} from "../src/core/apex/ApexBackwardDependencyEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {collectApexLiteralStringReturns} from "../src/core/apex/ApexLiteralReturnEvidence.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {evaluateApexExpression,textValue,type ApexValue} from "../src/core/apex/ApexValueEvaluator.js";
import {parseApexAccessLevel,defaultApexDatabaseAccessMode} from "../src/core/apex/ApexDatabaseAccessMode.js";
import {readApexOperandBoundary} from "../src/core/apex/ApexOperandBoundary.js";
import {maskApexSource} from "../src/core/apex/ApexSourceModel.js";
import {OBJECT_PERMISSION_KEYS} from "../src/models/ObjectPrivilegeAccess.js";
import {MATRIX_PERMISSION_KEYS} from "../src/models/ObjectAccessMatrixResult.js";

test("shared backward engine traces non-SOQL collection dependency through callers and loop",()=>{
  const files=[
    {filePath:"Writer.cls",source:"public class Writer {public static void save(List<String> names){Sink.consume(names);}}"},
    {filePath:"Bridge.cls",source:"public class Bridge {public static void forward(List<String> names){Writer.save(names);}}"},
    {filePath:"Entry.cls",source:"public class Entry {public static void start(Boolean flag){Set<String> values=new Set<String>{'Status'};for(String item:new List<String>{'Amount','Description'}){values.add(item);}if(flag){values.add('OwnerId');}Bridge.forward(new List<String>(values));}}"}
  ];
  const source=files[0].source;
  const trace=traceApexDependencies(source,files[0].filePath,{expression:"names",offset:source.indexOf("Sink.consume")},new ApexRepositoryMethodIndex(files));
  assert.equal(trace.kind,"SOURCE_CANDIDATES");
  const collections=trace.candidates.flatMap(e=>e.value.kind==="collection"?[e.value.items]:[]);
  assert.deepEqual(collections.map(items=>new Set(items)),[new Set(["Status","Amount","Description","OwnerId"])],JSON.stringify(trace));
  assert.ok(trace.callerEdges>=2);
});
test("default tracer does not invent a conditional String merge or expand an unknown metadata selector",()=>{
  const source="public class Worker {public static void run(Boolean flag){String s='base';if(flag){s+='extra';}Sink.consume(s);}}";
  const trace=traceApexDependencies(source,"Worker.cls",{expression:"s",offset:source.indexOf("Sink.consume")});
  assert.ok(trace.candidates.every(e=>e.value.kind==="unknown"));
  const metadata="public class Worker {public static void run(String key){Config__mdt cfg=Config__mdt.getInstance(key);Sink.consume(cfg.Name__c);}}";
  let calls=0;
  const read=traceApexDependencies(metadata,"Worker.cls",{expression:"cfg.Name__c",offset:metadata.indexOf("Sink.consume")},undefined,()=>{calls++;return undefined;});
  assert.equal(calls,0);
  assert.ok(read.candidates.every(e=>e.value.kind==="unknown"));
});
test("generic String join does not need a SQL grammar",()=>{
  const source="public class Worker {public static void run(){List<String> names=new List<String>{'A','B'};String s=String.join(names,'/');Sink.consume(s);}}";
  const trace=traceApexDependencies(source,"Worker.cls",{expression:"s",offset:source.indexOf("Sink.consume")});
  assert.deepEqual(trace.candidates.map(e=>e.value),[textValue("A/B")]);
});
test("generic helper return evidence can describe non-query alternatives",()=>{
  const source="public class Worker {public static void run(Integer step){Sink.consume(operation(step));}private static String operation(Integer step){switch on step {when 1 {return 'insert';}when 2 {return 'update';}when else {return null;}}}}";
  const methods=indexApexMethods(source),owner=methods.find(m=>m.name==="run")!;
  assert.deepEqual(new Set(collectApexLiteralStringReturns(source,owner,"operation(step)",[],methods)),new Set(["insert","update"]));
});
test("Apex core never imports SOQL analyzer, scanner, permission or report layer",()=>{
  const directory=path.resolve("src/core/apex");
  for(const name of readdirSync(directory).filter(n=>n.endsWith(".ts"))){
    const source=readFileSync(path.join(directory,name),"utf8");
    const imports=[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]);
    for(const target of imports)assert.doesNotMatch(target,/(?:^|\/)(?:analyzer|scanner|reporter|services|salesforce|config|models)\//i,name+": "+target);
  }
});

test("shared access mode and operand parsing do not depend on query grammar",()=>{
  assert.equal(parseApexAccessLevel("AccessLevel.USER_MODE"),"USER_MODE");
  assert.equal(parseApexAccessLevel("mode"),null);
  assert.equal(parseApexAccessLevel(),undefined);
  assert.equal(defaultApexDatabaseAccessMode(66),"SYSTEM_MODE");
  assert.equal(defaultApexDatabaseAccessMode(67),"USER_MODE");
  assert.equal(defaultApexDatabaseAccessMode(),undefined);
  const input="new Map<String,List<String>>().get('x')[0], rest";
  assert.equal(readApexOperandBoundary(maskApexSource(input),0)?.end,input.indexOf(", rest"));
  assert.equal(readApexOperandBoundary("service.call(",0)?.malformed,true);
  assert.equal(OBJECT_PERMISSION_KEYS,MATRIX_PERMISSION_KEYS);
});


test("loop-header lookup and chained built-ins reuse evaluator in backward evidence",()=>{
  const source="public class Worker {public static void run(){List<String> requested=new List<String>{' Name ',' Industry ',' Unknown '};Map<String,String> allowed=new Map<String,String>{'name'=>'Name','industry'=>'Industry'};Set<String> fields=new Set<String>();for(String item:requested){String normalized=item.trim().toLowerCase();if(allowed.containsKey(normalized)){fields.add(normalized);}}Sink.consume(fields);}}";
  const trace=traceApexDependencies(source,"Worker.cls",{expression:"fields",offset:source.indexOf("Sink.consume")});
  assert.deepEqual(trace.candidates.map(e=>e.value.kind==="collection"?e.value.items:e.value),[["name","industry"]],JSON.stringify(trace));
});
test("unknown maps and input collections and loop mutation remain unresolved",()=>{
  const sources=[
    "public class Worker {public static void run(List<String> requested){Set<String> fields=new Set<String>();for(String item:requested){fields.add(item);}Sink.consume(fields);}}",
    "public class Worker {public static void run(Map<String,String> allowed){List<String> requested=new List<String>{'Name'};Set<String> fields=new Set<String>();for(String item:requested){if(allowed.containsKey(item)){fields.add(item);}}Sink.consume(fields);}}",
    "public class Worker {public static void run(){List<String> requested=new List<String>{'Name'};Set<String> fields=new Set<String>();for(String item:requested){requested.clear();fields.add(item);}Sink.consume(fields);}}",
    "public class Worker {public static void run(){List<String> requested=new List<String>{'Name'};Map<String,String> allowed=new Map<String,String>{'Name'=>'Name'};Set<String> fields=new Set<String>();for(String item:requested){if(allowed.containsKey(item)){fields.add(item);}allowed.clear();}Sink.consume(fields);}}"
  ];
  for(const source of sources){
    const trace=traceApexDependencies(source,"Worker.cls",{expression:"fields",offset:source.indexOf("Sink.consume")});
    assert.ok(trace.candidates.every(e=>e.value.kind==="unknown"),JSON.stringify(trace));
  }
});
test("shared parser retains enhanced-for element types and evaluator handles chains",()=>{
  const source="public class Worker {public static void run(List<OrderSummary> orders){for(OrderSummary os:orders){Sink.consume(os);}}}";
  const loop=indexApexMethods(source).find(m=>m.name==="run")!.body[0];
  assert.equal(loop.kind,"for");assert.equal(loop.loopVariableType,"OrderSummary");assert.equal(loop.loopVariable,"os");assert.equal(loop.iterable,"orders");
  assert.deepEqual(evaluateApexExpression("item.trim().toLowerCase()",{values:new Map([["item",textValue(" Name ")]])}),textValue("name"));
});


test("backward traversal reuses class-level initializer for copied list and loop",()=>{
  const source="public class Worker {private static final List<String> BASE_FIELDS=new List<String>{' Id ',' Name '};public static void run(){List<String> requested=new List<String>(BASE_FIELDS);Set<String> safeFields=new Set<String>();for(String item:requested){safeFields.add(item.trim());}Sink.consume(safeFields);}}";
  const filePath="Worker.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
  const events:string[]=[];
  const result=traceApexDependencies(source,filePath,{expression:"safeFields",offset:source.indexOf("Sink.consume")},index,undefined,{observe:e=>events.push(e.code)});
  assert.deepEqual(result.candidates.map(e=>e.value),[{kind:"collection",items:["Id","Name"],unique:true}],JSON.stringify(result));
  assert.ok(events.includes("CLASS_MEMBER_RESOLVED"));
});
test("local and parameter scope take precedence over a class-level member",()=>{
  for(const [method,expected] of [
    ["public static void run(){String FIELD='Industry';Sink.consume(FIELD);}",textValue("Industry")],
    ["public static void run(){String FIELD;Sink.consume(FIELD);}",undefined],
    ["public static void run(String FIELD){Sink.consume(FIELD);}",undefined],
    ["public static void run(){String f='Phone';{String FIELD=f;Sink.consume(FIELD);}}",textValue("Phone")],
  ] as const){
    const source="public class Worker {private static final String FIELD='Name';"+method+"}";
    const filePath="Worker.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const trace=traceApexDependencies(source,filePath,{expression:"FIELD",offset:source.indexOf("Sink.consume")},index);
    if(expected)assert.deepEqual(trace.candidates.map(e=>e.value),[expected]);
    else assert.ok(trace.candidates.length&&trace.candidates.every(e=>e.value.kind==="unknown"),JSON.stringify(trace));
  }
});
test("class-level lookup does not accept mutable, alias-escaped, blank or instance snapshots",()=>{
  for(const body of [
    "private static final List<String> BASE_FIELDS=new List<String>{'Id'}; public static void mutate(){BASE_FIELDS.add('Name');}",
    "private static List<String> BASE_FIELDS=new List<String>{'Id'}; public static void mutate(){List<String> alias=BASE_FIELDS;alias.clear();}",
    "private static List<String> BASE_FIELDS;",
    "private List<String> BASE_FIELDS=new List<String>{'Id'};",
  ]){
    const source="public class Worker {"+body+"public void run(){Sink.consume(BASE_FIELDS);}}";
    const filePath="Worker.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const trace=traceApexDependencies(source,filePath,{expression:"BASE_FIELDS",offset:source.indexOf("Sink.consume")},index);
    assert.ok(trace.candidates.length&&trace.candidates.every(e=>e.value.kind==="unknown"),JSON.stringify(trace));
  }
});
test("caller dependencies resolve members in the declaring caller class, not the sink class",()=>{
  const files=[
    {filePath:"Worker.cls",source:"public class Worker {private static String FIELD='Wrong';public static void run(String item){Sink.consume(item);}}"},
    {filePath:"Caller.cls",source:"public class Caller {private static String FIELD='Name';public static void load(){Worker.run(FIELD);}}"}
  ];
  const root=files[0];
  const trace=traceApexDependencies(root.source,root.filePath,{expression:"item",offset:root.source.indexOf("Sink.consume")},new ApexRepositoryMethodIndex(files));
  assert.deepEqual(trace.candidates.map(e=>e.value),[textValue("Name")],JSON.stringify(trace));
});


test("add-only unknown iterations preserve known members and explicit incompleteness without inventing a joined String",()=>{
  const source="public class Worker {public static void run(List<String> extra){Set<String> items=new Set<String>{'A'};if(extra!=null){for(String f:extra){if(String.isNotBlank(f)){items.add(f.trim());}}}Sink.consume(items);}}";
  const result=traceApexDependencies(source,"Worker.cls",{expression:"items",offset:source.indexOf("Sink.consume")});
  assert.deepEqual(result.candidates.map(e=>({value:e.value,runtime:e.runtimeMembers})),[{value:{kind:"collection",items:["A"],unique:true},runtime:{}}],JSON.stringify(result));
  const joined=traceApexDependencies(source,"Worker.cls",{expression:"String.join(items,',')",offset:source.indexOf("Sink.consume")});
  assert.ok(joined.candidates.every(e=>e.value.kind==="unknown"),JSON.stringify(joined));
});
