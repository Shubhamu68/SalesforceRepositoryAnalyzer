import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexDataFlowEngine} from "../src/core/apex/ApexDataFlowEngine.js";
import {ApexAnalysisEngine,analyzeApexInvocations} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {evaluateApexExpression,textValue,unknown,listValue,type ApexEnvironment} from "../src/core/apex/ApexValueEvaluator.js";
import {compactUnknownStates} from "../src/core/apex/ApexUnknownStateCompaction.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {planCustomMetadataRequest,resolveCustomMetadataRows} from "../src/core/apex/ApexCustomMetadataQueries.js";

test("nested try-body scalar liveness removes temporary branch values before the next condition",()=>{
  const source="public class Builder { public static void run(Boolean a,Boolean b,Boolean c){ try { String x='Id'; if(a){x='Name';} System.debug(x); String y='Id'; if(b){y='Email';} System.debug(y); String z='Id'; if(c){z='Phone';} System.debug(z); Database.query('SELECT Id FROM Account'); } catch(Exception e){throw e;} } }";
  const engine=new ApexDataFlowEngine(source,{maxPaths:2});
  const result=engine.analyze();
  assert.equal(result.exceeded,false);
  assert.deepEqual(result.captures.get(engine.sites[0].offset)?.map(c=>c.query),[textValue("SELECT Id FROM Account")]);
});

test("unknown provenance compaction preserves known bindings, distinct aliases and runtime symbol identity",()=>{
  const a=unknown("runtime path a"),b=unknown("runtime path b");
  const shared=listValue(["Id"]);
  const first={values:new Map([["q",a],["a",shared],["b",shared]]) as ApexEnvironment};
  const second={values:new Map([["q",b],["a",shared],["b",shared]]) as ApexEnvironment};
  const result=compactUnknownStates([first,second]);
  assert.equal(result.length,1);
  assert.equal(result[0].values.get("q")?.kind,"unknown");
  assert.equal(result[0].values.get("a"),result[0].values.get("b"));
  const independent={values:new Map([["q",b],["a",listValue(["Id"])],["b",listValue(["Id"])]]) as ApexEnvironment};
  assert.equal(compactUnknownStates([first,independent]).length,2);
  const known={values:new Map([["q",textValue("SELECT Id FROM Account")],["a",shared],["b",shared]]) as ApexEnvironment};
  assert.equal(compactUnknownStates([first,known]).length,2);
});

test("runtime loop may mutate SELECT collection through a helper reference",()=>{
  const source="public class Builder { public static void run(List<String> input){ Set<String> fields=new Set<String>{'Id'}; for(String item:input){ addField(item,fields); } Database.query('SELECT '+String.join(new List<String>(fields),',')+' FROM Account'); } private static void addField(String item,Set<String> fields){fields.add(item);} }";
  const result=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});

test("unknown while retains subsequent invocation and taints mutable string updates",()=>{
  const source="public class Builder { public static void run(Boolean again){ String q='SELECT Id FROM Account'; while(again){q+=' WHERE Name = :name';} Database.query(q); } }";
  const result=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
  assert.match(result.unresolved[0].reason,/loop may change/i);
});

test("unknown loop cannot establish complete helper return when it can return another value",()=>{
  const source="public class Builder { public static String build(List<String> input){ for(String item:input){return item;} return 'SELECT Id FROM Account'; } }";
  const engine=new ApexDataFlowEngine(source);
  assert.equal(engine.summarizeMethodReturn(indexApexMethods(source)[0],[unknown("runtime list")]).kind,"unknown");
});

test("bounded foreach continue skips an iteration, break exits only the current loop",()=>{
  const source="public class Builder { public static void run(){ List<String> fields=new List<String>(); for(String field:new List<String>{'Id','Skip','Name','Stop','Phone'}){if(field=='Skip'){continue;} if(field=='Stop'){break;} fields.add(field);} Database.query('SELECT '+String.join(fields,',')+' FROM Account'); } }";
  const result=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query),["SELECT Id,Name FROM Account"]);
});

test("known collection loop preserves carried scalar and nested iteration control",()=>{
  const source="public class Builder { public static void run(){ String fields='Id'; for(String a:new List<String>{'A','B'}){for(String b:new List<String>{'Skip','Name','Stop'}){if(b=='Skip'){continue;} if(b=='Stop'){break;} fields+=','+b;} } Database.query('SELECT '+fields+' FROM Account'); } }";
  const result=analyzeApexInvocations(source,"Builder.cls",name=>name==="Database.query"?{method:name,argumentIndices:[0]}:undefined);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.map(v=>v.query),[textValue("SELECT Id,Name,Name FROM Account")]);
});

test("exact chained substring, length, endsWith, replacement and integer min are reusable",()=>{
  const ctx={values:new Map([["q",textValue("SELECT Id FROM Account WHERE Id = :id AND ")]])};
  assert.deepEqual(evaluateApexExpression("q.endsWith('AND ')",ctx),{kind:"text",values:["true"],scalarType:"boolean"});
  assert.deepEqual(evaluateApexExpression("q.substring(0,q.length()-4)",ctx),textValue("SELECT Id FROM Account WHERE Id = :id "));
  assert.deepEqual(evaluateApexExpression("String.valueOf(20260101).substring(0,4)",ctx),textValue("2026"));
  assert.deepEqual(evaluateApexExpression("'SELECT Id FROM Account WHERE Name = {name}'.replace('{name}',':b0')",ctx),textValue("SELECT Id FROM Account WHERE Name = :b0"));
  assert.deepEqual(evaluateApexExpression("Math.min(25,200)",ctx),{kind:"number",value:25});
  assert.equal(evaluateApexExpression("q.substring(0,999)",ctx).kind,"unknown");
});

test("metadata LIMIT 1 accepts only uniquely matched configuration and preserves optional nulls",()=>{
  const request=planCustomMetadataRequest("[SELECT Object_Name__c, Group_Field__c, Optional__c FROM Config__mdt WHERE DeveloperName = :name AND Active__c = true LIMIT 1]",[textValue("Example"),{kind:"text",values:["true"],scalarType:"boolean"}]);
  assert.ok(!("kind" in request));
  if("kind" in request)return;
  const record={DeveloperName:"Example",Active__c:true,Object_Name__c:"Account",Group_Field__c:"Name;Phone",Optional__c:null};
  const result=resolveCustomMetadataRows(request,{complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:[record]});
  assert.equal(result.kind,"records");
  const item=evaluateApexExpression("cfgs[0]",{values:new Map([["cfgs",result]])});
  assert.equal(item.kind,"record");
  assert.deepEqual(evaluateApexExpression("cfg.Optional__c",{values:new Map([["cfg",item]])}),{kind:"null"});
  assert.equal(resolveCustomMetadataRows(request,{complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:[record,record]}).kind,"unknown");
});

test("known configuration helper propagates singleton record to another generic selector",async()=>{
  const config="public class ConfigService { public static Config__mdt load(String key){List<Config__mdt> rows=[SELECT Object_Name__c FROM Config__mdt WHERE DeveloperName=:key LIMIT 1];return rows.isEmpty()?null:rows[0];} }";
  const source="public class Consumer { public static void run(){Config__mdt cfg=ConfigService.load('Example'); Inspector.inspect(cfg.Object_Name__c);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"ConfigService.cls",source:config},{filePath:"Consumer.cls",source}]);
  const engine=new ApexAnalysisEngine(index,{scopeKey:"fixture",getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:[{DeveloperName:"Example",Object_Name__c:"Account"}]})});
  const result=await engine.analyzeInvocations(source,"Consumer.cls",name=>name==="Inspector.inspect"?{method:name,argumentIndices:[0]}:undefined);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.map(v=>v.arguments),[[textValue("Account")]]);
});


test("invocation prefix avoids unrelated branches that cannot reach the selected site",()=>{
  const source="public class Builder { public static void run(Boolean route,Boolean a,Boolean b,Boolean c){ if(route){String x='Id';String y='Id';String z='Id';if(a){x='Name';}if(b){y='Phone';}if(c){z='Email';}External.inspect(x,y,z);}else{Inspector.inspect('Name');} } }";
  const result=analyzeApexInvocations(source,"Builder.cls",name=>name==="Inspector.inspect"?{method:name,argumentIndices:[0]}:undefined,undefined,undefined,{maxPaths:2});
  assert.equal(result.exceeded,false);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.map(v=>v.arguments),[[textValue("Name")]]);
});

test("selected invocation frontier does not include post-target branches",()=>{
  const source="public class Builder { public static void run(Boolean route,Boolean a,Boolean b){if(route){String x='Id';if(a){x='Name';}Inspector.inspect(x);}else{String y='Id';if(a){y='Phone';}if(b){y+='Email';}External.inspect(y);}}}";
  const result=analyzeApexInvocations(source,"Builder.cls",name=>name==="Inspector.inspect"?{method:name,argumentIndices:[0]}:undefined,undefined,undefined,{maxPaths:2});
  assert.equal(result.exceeded,false);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.map(v=>v.arguments).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),[[textValue("Id")],[textValue("Name")]]);
});
