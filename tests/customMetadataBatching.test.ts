import {test} from "node:test";
import assert from "node:assert/strict";
import {SalesforceApexMetadataProvider} from "../src/salesforce/SalesforceApexMetadataProvider.js";
import type {SalesforceOrgConnection} from "../src/salesforce/SalesforceOrgConnection.js";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexMetadataCapture,ApexMetadataReplay} from "../src/core/metadata/ApexMetadataSnapshot.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";
import type {CustomMetadataRead} from "../src/core/metadata/ApexMetadataProvider.js";
const request=(key:string,field:string,value:string|boolean="One"):CustomMetadataRead=>({key,type:"Config__mdt",selected:[field],filters:[{field:"Selector__c",value}]});
test("CMDT union shares only identical typed filters and projects exact standalone rows",async()=>{
 const calls:string[]=[];
 const provider=new SalesforceApexMetadataProvider({status:{},queryAll:async(q:string)=>{
  calls.push(q);return [{DeveloperName:"A",Selector__c:"One",First__c:"Name",Second__c:"Id"}];
 }} as unknown as SalesforceOrgConnection);
 const result=await provider.getCustomMetadataRecordsBatch([request("a","First__c"),request("b","Second__c"),request("c","First__c",true),request("d","First__c","Other")]);
 assert.equal(calls.length,1);assert.match(calls[0],/WHERE Selector__c = 'One'/);
 assert.deepEqual(result.get("a")?.value,[{DeveloperName:"A",First__c:"Name",Selector__c:"One"}]);
 assert.deepEqual(result.get("b")?.value,[{DeveloperName:"A",Second__c:"Id",Selector__c:"One"}]);
 assert.equal(result.get("a")?.filterEvidence,"SERVER_FILTERED");
 assert.equal(result.has("c"),false);assert.equal(result.has("d"),false);
});
test("CMDT engine fallback and snapshot replay preserve original request shapes",async()=>{
 const calls:string[]=[];
 let fail=false;
 const provider=new SalesforceApexMetadataProvider({status:{},queryAll:async(q:string)=>{
  calls.push(q);
  if(fail&&q.includes("First__c")&&q.includes("Second__c"))throw Error("union unavailable");
  return [{DeveloperName:"A",Selector__c:"One",First__c:"Name",Second__c:"Id"}];
 }} as unknown as SalesforceOrgConnection);
 const run=(engine:ApexAnalysisEngine)=>Promise.all(["First__c","Second__c"].map(field=>engine.analyze(field+".cls",ctx=>
  ctx.resolveExternal("Apex.metadataRows",[textValue("[SELECT "+field+" FROM Config__mdt WHERE Selector__c = :s]"),textValue("One")]))));
 const capture=new ApexMetadataCapture(provider);
 const first=await run(new ApexAnalysisEngine(undefined,capture.provider));
 assert.equal(calls.length,1);
 assert.equal(capture.snapshot().entries.length,2);
 const replay=new ApexMetadataReplay(capture.snapshot());
 assert.deepEqual(await run(new ApexAnalysisEngine(undefined,replay.provider)),first);
 assert.equal(replay.stats.missing,0);
 fail=true;
 assert.deepEqual(await run(new ApexAnalysisEngine(undefined,provider)),first);
 assert.equal(calls.length,4);
});
test("CMDT union preserves empty results and rejects incomplete projection",async()=>{
 let rows:unknown[]=[];
 const provider=new SalesforceApexMetadataProvider({status:{},queryAll:async()=>rows} as unknown as SalesforceOrgConnection);
 const requests=[request("a","First__c"),request("b","Second__c")];
 assert.deepEqual((await provider.getCustomMetadataRecordsBatch(requests)).get("a")?.value,[]);
 rows=[{DeveloperName:"A",Selector__c:"One",First__c:"Id"}];
 assert.equal((await provider.getCustomMetadataRecordsBatch(requests)).size,0);
});
