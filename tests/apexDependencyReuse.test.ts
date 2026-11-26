import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,utimes} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";
import type {ApexMetadataProvider,MetadataResult} from "../src/core/metadata/ApexMetadataProvider.js";
import {scanApexSoqlWithUnresolved} from "../src/scanner/apexSoqlScanner.js";
import {withApexPerformance} from "../src/core/apex/ApexPerformance.js";
const live=<T>(value:T):MetadataResult<T>=>({complete:true,source:"LIVE_ORG",value});
test("dependency validation refreshes complete label/Field Set/CMDT inputs, rejects changes and incomplete responses",async()=>{
 let version="Name",missing=false,calls=0;
 const p:ApexMetadataProvider={scopeKey:"org-a",getObjectFieldNames:async()=>live(["Id"]),
  getCustomLabelValue:async()=>{calls++;return missing?{complete:false,source:"LIVE_ORG"}:live(version);},
  getFieldSetFields:async()=>{calls++;return live(["Id",version]);},
  getCustomMetadataRecords:async()=>{calls++;return {...live([{DeveloperName:"A",Field__c:version}]),filterEvidence:"SERVER_FILTERED"};}
 };
 const consumer=(ctx:import("../src/core/apex/ApexAnalysisEngine.js").ApexAnalysisContext)=>[
  ctx.resolveExternal("System.Label",[textValue("Columns")]),
  ctx.resolveExternal("Schema.fieldSetFields",[textValue("Account"),textValue("Fields")]),
  ctx.resolveExternal("Apex.metadataRows",[textValue("[SELECT Field__c FROM Config__mdt]")]),
 ];
 const first=await new ApexAnalysisEngine(undefined,p).analyzeWithDependencies("X.cls",consumer);
 assert.ok(first.manifest);assert.equal(first.manifest.dependencies.length,3);assert.equal(calls,3);
 assert.equal(await new ApexAnalysisEngine(undefined,p).canReuse(first.manifest),true);assert.equal(calls,6);
 version="Industry";
 const changed=new ApexAnalysisEngine(undefined,p);
 assert.equal(await changed.canReuse(first.manifest),false);
 assert.notDeepEqual((await changed.analyzeWithDependencies("X.cls",consumer)).analysis,first.analysis);
 assert.equal(calls,9,"changed metadata is reused only inside the new scan");
 missing=true;
 const unavailable=await new ApexAnalysisEngine(undefined,p).analyzeWithDependencies("X.cls",consumer);
 assert.equal(unavailable.manifest,undefined);
 assert.equal(await new ApexAnalysisEngine(undefined,{...p,scopeKey:"org-b"}).canReuse(first.manifest),false);
});
test("warm scan reuses unchanged dynamic analysis only after refreshing metadata, reruns on changed caller or metadata",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"sf-dynamic-reuse-"));
 const old=process.env.SALESFORCE_APEX_REUSE,trace=process.env.SALESFORCE_SOQL_TRACE,capture=process.env.SALESFORCE_APEX_METADATA_CAPTURE;
 delete process.env.SALESFORCE_SOQL_TRACE;delete process.env.SALESFORCE_APEX_METADATA_CAPTURE;delete process.env.SALESFORCE_APEX_REUSE;
 try{
  let field="Name",reads=0;
  const provider:ApexMetadataProvider={scopeKey:"reuse-test",getObjectFieldNames:async()=>live(["Id"]),getCustomMetadataRecords:async()=>live([]),
   getCustomLabelValue:async()=>{reads++;return live(field);}};
  const cls=path.join(root,"A.cls"),helper=path.join(root,"Helper.cls");
  await writeFile(cls,"public class A {public static void run(){Database.query('SELECT '+System.Label.Columns+' FROM Account');}}");
  await writeFile(helper,"public class Helper {public static String value(){return 'A';}}");
  // ctime cannot be backdated with utimes: respect the actual recent-edit guard.
  await delay(2100);
  const counts=new Map<string,number>();
  const scan=()=>withApexPerformance({count:(n,c)=>counts.set(n,(counts.get(n)??0)+c),duration:()=>{}},()=>scanApexSoqlWithUnresolved(root,provider));
  const first=await scan();assert.equal(first.queries[0]?.fields[0],"Name");assert.equal(reads,1);
  counts.clear();const second=await scan();assert.deepEqual(second,first);assert.equal(reads,2);
  assert.equal(counts.get("engine.instances")??0,0);
  field="Industry";counts.clear();const changed=await scan();assert.equal(changed.queries[0]?.fields[0],"Industry");
  assert.equal(reads,3);assert.ok((counts.get("engine.instances")??0)>0);
  await writeFile(helper,"public class Helper {public static String value(){return 'B';}}");
  counts.clear();assert.deepEqual(await scan(),changed);assert.ok((counts.get("engine.instances")??0)>0);
  // Legacy environment values cannot turn off the release optimization.
  // Allow the recent-edit guard to expire and establish a stable warm scan.
  await delay(2100);
  await scan();
  process.env.SALESFORCE_APEX_REUSE="0";counts.clear();
  assert.deepEqual(await scan(),changed);
  assert.equal(counts.get("engine.instances")??0,0);
  assert.ok((counts.get("metadata.reuse_dependency_checks")??0)>0);
 }finally{
  for(const [key,value] of [["SALESFORCE_APEX_REUSE",old],["SALESFORCE_SOQL_TRACE",trace],["SALESFORCE_APEX_METADATA_CAPTURE",capture]] as const)
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  await rm(root,{recursive:true,force:true});
 }
});
