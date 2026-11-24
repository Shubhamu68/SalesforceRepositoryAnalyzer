import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {withApexPerformance} from "../src/core/apex/ApexPerformance.js";
import {SalesforceUserFieldAccessGateway} from "../src/salesforce/SalesforceUserFieldAccessGateway.js";
import type {SalesforceOrgConnection} from "../src/salesforce/SalesforceOrgConnection.js";

test("repository build parses each distinct source once, including short classes",()=>{
  const files=Array.from({length:12},(_,i)=>({filePath:"Class"+i+".cls",
    source:"public class Class"+i+" { private static String FIELD; public static String getField(){if(FIELD==null){FIELD='Name';}return FIELD;} }"}));
  const counts=new Map<string,number>();
  const index=withApexPerformance({count:(name,n)=>counts.set(name,(counts.get(name)??0)+n),duration:()=>{}},
    ()=>new ApexRepositoryMethodIndex(files));
  assert.equal(counts.get("syntax.method_cache_miss"),files.length);
  assert.ok((counts.get("syntax.method_cache_hit")??0)>=files.length);
  assert.ok(Object.isFrozen(index.indexedMethods(files[0].filePath,files[0].source)));
  assert.deepEqual(index.evaluateLazyGetter("Class0","getField"),{kind:"text",values:["Name"]});
});

const user="005000000000001";
function row(field:string,read:boolean,edit:boolean){
  return {UserId:user,FieldDefinition:{QualifiedApiName:field},IsAccessible:read,IsUpdatable:edit};
}
function connection(query:(soql:string)=>Promise<unknown[]>){
  return {status:{organizationId:"org-a",instanceUrl:"https://test.salesforce.com"},
    queryAll:query,describeSObject:async()=>({fields:[]})} as unknown as SalesforceOrgConnection;
}

test("targeted batches preserve explicit grant and denial and recheck omitted fields",async()=>{
  const queries:string[]=[];
  const conn=connection(async soql=>{
    queries.push(soql);
    if(soql.includes("QualifiedApiName IN ("))return [row("First__c",true,true),row("Second__c",false,false)];
    if(soql.includes("QualifiedApiName = 'Third__c'"))return [row("Third__c",true,false)];
    return [];
  });
  const gateway=new SalesforceUserFieldAccessGateway(conn);
  const results=await Promise.all(["First__c","Second__c","Third__c"].map(field=>gateway.verifyUserField(user,"Account",field)));
  assert.deepEqual(results,[{read:true,edit:true},{read:false,edit:false},{read:true,edit:false}]);
  assert.equal(queries.filter(q=>q.includes("QualifiedApiName IN (")).length,1);
  assert.equal(queries.filter(q=>/FieldDefinition\.QualifiedApiName = /.test(q)).length,1);
});

test("unsupported targeted IN query falls back to original exact checks",async()=>{
  const queries:string[]=[];
  const conn=connection(async soql=>{
    queries.push(soql);
    if(soql.includes("QualifiedApiName IN ("))throw Object.assign(new Error("unsupported"),{statusCode:400});
    if(soql.includes("QualifiedApiName = 'First__c'"))return [row("First__c",false,false)];
    return [];
  });
  const gateway=new SalesforceUserFieldAccessGateway(conn);
  const result=await Promise.all(["First__c","Second__c"].map(field=>gateway.verifyUserField(user,"Account",field)));
  assert.deepEqual(result,[{read:false,edit:false},{read:null,edit:null}]);
  assert.equal(queries.filter(q=>q.includes("QualifiedApiName IN (")).length,1);
  assert.equal(queries.filter(q=>/FieldDefinition\.QualifiedApiName = /.test(q)).length,2);
});

test("mismatched or conflicting targeted rows cannot grant access",async()=>{
  const conn=connection(async soql=>{
    if(soql.includes("QualifiedApiName IN ("))return [row("First__c",true,true),row("First__c",false,false),row("Unrequested__c",true,true)];
    if(soql.includes("QualifiedApiName = 'First__c'"))return [row("First__c",false,false)];
    return [];
  });
  const gateway=new SalesforceUserFieldAccessGateway(conn);
  assert.deepEqual(await Promise.all(["First__c","Second__c"].map(field=>gateway.verifyUserField(user,"Account",field))),
    [{read:false,edit:false},{read:null,edit:null}]);
});
