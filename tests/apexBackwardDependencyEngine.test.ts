import assert from "node:assert/strict";
import {test} from "node:test";
import {readdirSync,readFileSync} from "node:fs";
import path from "node:path";
import {traceApexDependencies} from "../src/core/apex/ApexBackwardDependencyEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {collectApexLiteralStringReturns} from "../src/core/apex/ApexLiteralReturnEvidence.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {textValue,type ApexValue} from "../src/core/apex/ApexValueEvaluator.js";

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
