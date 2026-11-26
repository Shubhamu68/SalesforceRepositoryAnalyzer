import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";
import {ApexMetadataCapture,ApexMetadataReplay} from "../src/core/metadata/ApexMetadataSnapshot.js";
import {ScanMetadataBatcher} from "../src/core/metadata/ScanMetadataBatcher.js";
import {SalesforceApexMetadataProvider} from "../src/salesforce/SalesforceApexMetadataProvider.js";
import type {SalesforceOrgConnection} from "../src/salesforce/SalesforceOrgConnection.js";
import type {ApexMetadataProvider,MetadataResult} from "../src/core/metadata/ApexMetadataProvider.js";
const live=<T>(value:T):MetadataResult<T>=>({complete:true,source:"LIVE_ORG",value});
const status={organizationId:"00Dfixture",userId:"005fixture",instanceUrl:"https://example.invalid",connectedAt:"fixture"};

test("scan-local batcher bounds chunks, preserves request order and falls back for omitted/invalid/failed results",async()=>{
 const batches:string[][]=[],singles:string[]=[];
 const batcher=new ScanMetadataBatcher<string,string>(name=>name,async name=>{singles.push(name);return live(name+" exact");},
  async names=>{
   batches.push([...names]);
   if(names.includes("D"))throw Error("batch failed");
   return new Map(names.filter(n=>n!=="B").map(n=>[n,n==="C"?{complete:false,source:"LIVE_ORG"} as MetadataResult<string>:live(n+" batch")]));
  },3,value=>typeof value==="string");
 const result=await Promise.all(["A","B","C","D","E","F","G"].map(n=>batcher.read(n)));
 assert.deepEqual(batches,[["A","B","C"],["D","E","F"]]);
 assert.deepEqual(singles.sort(),["B","C","D","E","F","G"]);
 assert.deepEqual(result.map(r=>r.value),["A batch","B exact","C exact","D exact","E exact","F exact","G exact"]);
});

test("Salesforce bulk provider accepts unique exact labels and validated Field Sets only",async()=>{
 const queries:string[]=[];
 const sets:string[][]=[];
 const connection={
  status,
  queryAll:async(soql:string,api:string)=>{
   assert.equal(api,"tooling");queries.push(soql);
   return [{Name:"Alpha",Value:"Id,Name",NamespacePrefix:null},{Name:"Beta",Value:"Id"},
    {Name:"Beta",Value:"Email",NamespacePrefix:"pkg"},{Name:"Gamma",Value:null}];
  },
  readFieldSetMetadataBatch:async(names:readonly string[])=>{
    sets.push([...names]);
    return new Map([["Account.Fields",["Owner.Name","Id"]],["Contact.Fields",["Bad field"]]]);
  },
 } as unknown as SalesforceOrgConnection;
 const provider=new SalesforceApexMetadataProvider(connection);
 const labels=await provider.getCustomLabelValues(["Alpha","Beta","Gamma","Missing"]);
 assert.deepEqual([...labels],[["Alpha",live("Id,Name")]]);
 assert.match(queries[0],/Name IN \('Alpha','Beta','Gamma','Missing'\)/);
 assert.doesNotMatch(queries[0],/ LIMIT /);
 const fields=await provider.getFieldSetFieldsBatch(["Account","Contact","Case"].map(objectApiName=>({objectApiName,fieldSetDeveloperName:"Fields"})));
 assert.deepEqual([...fields],[["Account.Fields",live(["Owner.Name","Id"])]]);
 assert.deepEqual(sets,[["Account.Fields","Contact.Fields","Case.Fields"]]);
 assert.equal((await provider.getCustomLabelValues(["Alpha","bad'name"])).size,0);
 assert.equal(queries.length,1);
});

test("shared engine batches only proven dependencies, deduplicates, captures individual results and refreshes across scans",async()=>{
 const bulkLabels:string[][]=[],bulkSets:string[][]=[],singles:string[]=[];
 let version="Name";
 const provider:ApexMetadataProvider={
  scopeKey:"fixture",
  getObjectFieldNames:async()=>live(["Id"]),
  getCustomMetadataRecords:async()=>live([]),
  getCustomLabelValue:async name=>{singles.push(name);return live(version);},
  getCustomLabelValues:async names=>{
    bulkLabels.push([...names]);return new Map(names.filter(n=>n!=="Fallback").map(n=>[n,live(version)]));
  },
  getFieldSetFields:async(object,name)=>{singles.push(object+"."+name);return live(["Id",version]);},
  getFieldSetFieldsBatch:async identities=>{
    bulkSets.push(identities.map(i=>i.objectApiName+"."+i.fieldSetDeveloperName));
    return new Map(identities.filter(i=>i.objectApiName!=="Case").map(i=>[i.objectApiName+"."+i.fieldSetDeveloperName,live(["Id",version])]));
  },
 };
 const run=(engine:ApexAnalysisEngine)=>Promise.all([
  ...["Alpha","Beta","Fallback","Alpha"].map(name=>engine.analyze(name+".cls",ctx=>ctx.resolveExternal("System.Label",[textValue(name)]))),
  ...["Account","Contact","Case","Account"].map(object=>engine.analyze(object+".cls",ctx=>ctx.resolveExternal("Schema.fieldSetFields",[textValue(object),textValue("Fields")]))),
 ]);
 const capture=new ApexMetadataCapture(provider);
 const before=await run(new ApexAnalysisEngine(undefined,capture.provider));
 assert.deepEqual(bulkLabels,[["Alpha","Beta","Fallback"]]);
 assert.deepEqual(bulkSets,[["Account.Fields","Contact.Fields","Case.Fields"]]);
 assert.deepEqual(singles.sort(),["Case.Fields","Fallback"]);
 const replay=new ApexMetadataReplay(capture.snapshot());
 assert.equal(replay.stats.captured,6);
 assert.deepEqual(await run(new ApexAnalysisEngine(undefined,replay.provider)),before);
 assert.equal(replay.stats.missing,0);assert.equal(replay.stats.used,6);
 version="Industry";
 const after=await run(new ApexAnalysisEngine(undefined,provider));
 assert.notDeepEqual(after,before);
 assert.equal(bulkLabels.length,2);assert.equal(bulkSets.length,2);
 assert.equal(singles.length,4);
});
