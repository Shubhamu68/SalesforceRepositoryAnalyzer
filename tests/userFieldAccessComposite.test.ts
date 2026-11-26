import assert from "node:assert/strict";
import {test} from "node:test";
import {SalesforceOrgConnection} from "../src/salesforce/SalesforceOrgConnection.js";
import {SalesforceUserFieldAccessGateway} from "../src/salesforce/SalesforceUserFieldAccessGateway.js";

const user="005000000000001",other="005000000000002";
function row(id:string,field:string,read:boolean,edit:boolean|null=false){
 return {UserId:id,FieldDefinition:{QualifiedApiName:field},IsAccessible:read,IsUpdatable:edit};
}
const exactField=(q:string)=>/AND FieldDefinition\.QualifiedApiName = '([^']+)'/.exec(q)?.[1];

test("Tooling Composite uses exact GET requests and accepts only unique complete responses by reference ID",async()=>{
 const connection=new SalesforceOrgConnection();
 const mutable=connection as unknown as {connection:unknown;connect:()=>Promise<void>;epoch:number};
 mutable.connection={accessToken:"fake",instanceUrl:"https://test.my.salesforce.com",organizationId:"fixture",connectedAt:"session"};
 mutable.connect=async()=>{};
 const queries=Array.from({length:5},(_,i)=>"SELECT Id FROM UserFieldAccess WHERE Id = 'field"+i+"'");
 const old=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async(input,init)=>{
  calls++;
  assert.match(String(input),/\/services\/data\/v\d+\.\d\/tooling\/composite$/);
  assert.equal(init?.method,"POST");
  const body=JSON.parse(String(init?.body));
  assert.equal(body.allOrNone,false);assert.equal(body.compositeRequest.length,5);
  for(const [i,entry] of body.compositeRequest.entries()){
   assert.equal(entry.method,"GET");assert.equal(entry.referenceId,"query"+i);
   assert.equal(new URL(entry.url,"https://test.my.salesforce.com").searchParams.get("q"),queries[i]);
  }
  const page=(records:unknown[],done=true)=>({records,totalSize:records.length,done});
  return new Response(JSON.stringify({compositeResponse:[
   {referenceId:"query4",httpStatusCode:200,body:page([])},
   {referenceId:"query0",httpStatusCode:200,body:page([{Id:"row"}])},
   {referenceId:"query1",httpStatusCode:400,body:[{errorCode:"INVALID_FIELD"}]},
   {referenceId:"query2",httpStatusCode:200,body:page([],false)},
   {referenceId:"query3",httpStatusCode:200,body:page([])},
   {referenceId:"query3",httpStatusCode:200,body:page([])}
  ]}),{status:200});
 };
 try{
  assert.deepEqual(await connection.queryToolingComposite(queries),new Map([[0,[{Id:"row"}]],[4,[]]]));
  await assert.rejects(connection.queryToolingComposite([...queries,queries[0]]),/Invalid read-only/);
  await assert.rejects(connection.queryToolingComposite([queries[0],"DELETE FROM Account"]),/Invalid read-only/);
  assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});

test("composite fallback preserves grants, denials, empty rows, conflicts and compound parent evidence across users",async()=>{
 const exact:string[]=[];const groups:string[][]=[];
 const connection={
  status:{organizationId:"fixture",userId:user,instanceUrl:"https://test.my.salesforce.com"},
  queryAll:async(q:string)=>{
   const f=exactField(q);if(!f)return [];
   exact.push(f);
   if(f==="Conflict__c")return [row(user,f,false)];
   if(f==="BillingAddress")return [row(user,f,true,true)];
   if(f==="Failed__c")return [row(other,f,true)];
   return [];
  },
  queryToolingComposite:async(queries:readonly string[])=>{
   groups.push([...queries]);const result=new Map<number,unknown[]>();
   queries.forEach((q,i)=>{
    const f=exactField(q)!;
    if(f==="Granted__c")result.set(i,[row(user,f,true,true)]);
    if(f==="Denied__c")result.set(i,[row(other,f,false)]);
    if(f==="BillingCity")result.set(i,[]);
    if(f==="Conflict__c")result.set(i,[row(user,f,true),row(user,f,false)]);
   });return result;
  },
  describeSObject:async()=>({fields:[{name:"BillingAddress",type:"address"},{name:"BillingCity",compoundFieldName:"BillingAddress"}]})
 } as unknown as SalesforceOrgConnection;
 const gateway=new SalesforceUserFieldAccessGateway(connection,undefined,{compositeExact:true});
 const result=await Promise.all([
  gateway.verifyUserField(user,"Account","Granted__c"),gateway.verifyUserField(other,"Contact","Denied__c"),
  gateway.verifyUserField(user,"Account","BillingCity"),gateway.verifyUserField(user,"Account","Conflict__c"),
  gateway.verifyUserField(other,"Contact","Failed__c")
 ]);
 assert.deepEqual(result,[{read:true,edit:true},{read:false,edit:false},{read:true,edit:null,readFromCompoundParent:"BillingAddress"},{read:false,edit:false},{read:true,edit:false}]);
 assert.equal(groups[0].length,5);
 assert.ok(groups.flat().every(q=>!q.includes(" IN (")));
 assert.deepEqual(exact.sort(),["BillingAddress","Conflict__c","Failed__c"]);
});

test("failed Composite disables speculation for scope, falls back and never turns missing into denial",async()=>{
 let batches=0,exact=0,epoch=0;
 const conn={status:{organizationId:"fixture",userId:user,instanceUrl:"https://test.my.salesforce.com"},
  getReadEpoch:()=>epoch,queryAll:async(q:string)=>{if(exactField(q))exact++;return [];},
  queryToolingComposite:async()=>{batches++;throw Error("not supported");},describeSObject:async()=>({fields:[]})
 } as unknown as SalesforceOrgConnection;
 const gateway=new SalesforceUserFieldAccessGateway(conn,undefined,{compositeExact:true});
 const run=(fields:string[])=>Promise.all(fields.map(f=>gateway.verifyUserField(user,"Account",f)));
 const unknown={read:null,edit:null};
 assert.deepEqual(await run(["A__c","B__c"]),[unknown,unknown]);
 assert.deepEqual(await run(["C__c","D__c"]),[unknown,unknown]);
 assert.equal(batches,1);assert.equal(exact,4);
 epoch++;
 assert.deepEqual(await run(["A__c","B__c"]),[unknown,unknown]);
 assert.equal(batches,2);assert.equal(exact,6);
});

test("scope change while composite is in flight rejects old evidence without querying new org",async()=>{
 let epoch=0,exact=0;
 const conn={status:{organizationId:"fixture",userId:user,instanceUrl:"https://test.my.salesforce.com"},
  getReadEpoch:()=>epoch,queryAll:async(q:string)=>{if(exactField(q))exact++;return [];},
  queryToolingComposite:async(queries:readonly string[])=>{
    epoch++;return new Map(queries.map((q,i)=>[i,[row(user,exactField(q)!,true)]]));
  },describeSObject:async()=>({fields:[]})
 } as unknown as SalesforceOrgConnection;
 const gateway=new SalesforceUserFieldAccessGateway(conn,undefined,{compositeExact:true});
 const result=await Promise.all(["A__c","B__c"].map(f=>gateway.verifyUserField(user,"Account",f)));
 assert.deepEqual(result,[{read:null,edit:null},{read:null,edit:null}]);assert.equal(exact,0);
});
