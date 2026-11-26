import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {ApexMetadataCapture,ApexMetadataReplay} from "../src/core/metadata/ApexMetadataSnapshot.js";
import type {ApexMetadataProvider} from "../src/core/metadata/ApexMetadataProvider.js";
import {scanApexSoqlWithUnresolved} from "../src/scanner/apexSoqlScanner.js";

const live=<T>(value:T)=>({complete:true,source:"LIVE_ORG" as const,value});
function fixture(){
  let calls=0;
  const provider:ApexMetadataProvider={
    scopeKey:"ORG|USER|SECRET_INSTANCE|EPOCH",
    getObjectFieldNames:async()=>{calls++;return live(["Id","OrderSummaryId"]);},
    getObjectSchema:async name=>{calls++;return live({name,fields:[{name:"Id",nameField:false,relationshipName:null,referenceTo:[]},{name:"OrderSummaryId",type:"reference",relationshipName:"OrderSummary",referenceTo:["OrderSummary"]}]});},
    getCustomLabelValue:async name=>{calls++;return name==="Missing"?{complete:false,source:"LIVE_ORG",reason:"private error with token=secret"}:live("Id,Name");},
    getFieldSetFields:async()=>{calls++;return live(["OrderSummary.OrderNumber","Id"]);},
    getCustomMetadataRecords:async (_name,_fields,filters)=>{calls++;return {...live(filters?.[0]?.value===true?[{DeveloperName:"A",Active__c:true}]:[]),filterEvidence:"SERVER_FILTERED"};}
  };
  return {provider,calls:()=>calls};
}
test("capture round trips all five provider operations, typed filters and ordered fields without live fallback",async()=>{
  const f=fixture(),capture=new ApexMetadataCapture(f.provider),p=capture.provider;
  const args=["Config__mdt",["Active__c"],[{field:"Active__c",value:true}]] as const;
  const expected=await Promise.all([p.getObjectFieldNames("OrderItemSummary"),p.getObjectSchema!("OrderItemSummary"),p.getCustomLabelValue!("Columns"),p.getFieldSetFields!("OrderItemSummary","Columns"),p.getCustomMetadataRecords(...args)]);
  await p.getCustomMetadataRecords("Config__mdt",["Active__c"],[{field:"Active__c",value:"true"}]);
  await p.getCustomLabelValue!("Missing");
  assert.equal(f.calls(),7);
  const dir=await mkdtemp(path.join(tmpdir(),"aue-snapshot-"));
  try{
    const file=await capture.save(dir),raw=await readFile(file,"utf8");
    assert.ok(!raw.includes("SECRET_INSTANCE")&&!raw.includes("token=secret"));
    const replay=await ApexMetadataReplay.load(file),q=replay.provider;
    assert.deepEqual(await Promise.all([q.getObjectFieldNames("OrderItemSummary"),q.getObjectSchema!("OrderItemSummary"),q.getCustomLabelValue!("Columns"),q.getFieldSetFields!("OrderItemSummary","Columns"),q.getCustomMetadataRecords(...args)]),expected);
    assert.deepEqual((await q.getCustomMetadataRecords("Config__mdt",["Active__c"],[{field:"Active__c",value:"true"}])).value,[]);
    assert.equal((await q.getCustomLabelValue!("Missing")).complete,false);
    assert.equal((await q.getObjectSchema!("NotCaptured")).complete,false);
    assert.equal((await q.getCustomMetadataRecords("Config__mdt",["Other__c"],args[2])).complete,false);
    assert.deepEqual(replay.stats,{captured:7,used:7,missing:2});
    assert.equal(f.calls(),7);
    const schema=await q.getObjectSchema!("OrderItemSummary");
    assert.equal(schema.value?.fields[1].nameField,undefined);
    (schema.value?.fields[1] as {name:string}).name="Changed";
    assert.equal((await q.getObjectSchema!("OrderItemSummary")).value?.fields[1].name,"OrderSummaryId");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("capture rejects conflicting responses without changing live values, and preserves absent optional capabilities",async()=>{
  let n=0;
  const capture=new ApexMetadataCapture({scopeKey:"test",getObjectFieldNames:async()=>live([++n===1?"Id":"Name"]),getCustomMetadataRecords:async()=>live([])});
  assert.deepEqual((await capture.provider.getObjectFieldNames("Account")).value,["Id"]);
  assert.deepEqual((await capture.provider.getObjectFieldNames("Account")).value,["Name"]);
  assert.throws(()=>capture.snapshot(),/incomplete or conflicting/);
  const clean=new ApexMetadataCapture({scopeKey:"test",getObjectFieldNames:async()=>live(["Id"]),getCustomMetadataRecords:async()=>live([])});
  assert.equal(new ApexMetadataReplay(clean.snapshot()).provider.getObjectSchema,undefined);
  const invalid=clean.snapshot();invalid.version=2 as 1;
  assert.throws(()=>new ApexMetadataReplay(invalid),/unsupported/);
});
test("same repository scanner reproduces captured metadata-driven query and unresolved evidence offline",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"aue-replay-"));
  const f=fixture();
  try{
    await writeFile(path.join(dir,"Example.cls"),"public class Example {public static void run(){String cols=System.Label.Columns;String q='SELECT '+cols+' FROM Account';Database.query(q);String other=System.Label.Missing;Database.query(other);}}");
    const capture=new ApexMetadataCapture(f.provider);
    const original=await scanApexSoqlWithUnresolved(dir,capture.provider);
    assert.ok(original.queries.some(q=>q.query.includes("Id,Name")),JSON.stringify(original));
    assert.ok(original.unresolvedDynamic.length>0);
    const count=f.calls(),replay=new ApexMetadataReplay(capture.snapshot());
    const offline=await scanApexSoqlWithUnresolved(dir,replay.provider);
    assert.deepEqual(offline.queries,original.queries);
    assert.deepEqual(offline.unresolvedDynamic.map(x=>[x.lineNumber,x.failureKind]),original.unresolvedDynamic.map(x=>[x.lineNumber,x.failureKind]));
    assert.equal(replay.stats.missing,0);
    assert.equal(f.calls(),count);
  }finally{await rm(dir,{recursive:true,force:true});}
});
