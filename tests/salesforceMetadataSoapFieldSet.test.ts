import assert from "node:assert/strict";
import {test} from "node:test";
import {SalesforceOrgConnection} from "../src/salesforce/SalesforceOrgConnection.js";

const soap=(fullName:string)=>'<?xml version="1.0" encoding="UTF-8"?>'+
  '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" '+
  'xmlns:met="http://soap.sforce.com/2006/04/metadata">'+
  '<env:Body><met:readMetadataResponse><met:result>'+
  '<met:records><met:fullName>'+fullName+'</met:fullName>'+
  '<met:displayedFields><met:field>Name</met:field></met:displayedFields>'+
  '<met:displayedFields><met:field>Owner.Name</met:field></met:displayedFields>'+
  '</met:records></met:result></met:readMetadataResponse></env:Body></env:Envelope>';

test("Stage 3: Metadata SOAP reader uses read-only call and exact Field Set identity",async()=>{
  const connection=new SalesforceOrgConnection();
  const mutable=connection as unknown as {
    connection:unknown;connect:()=>Promise<void>;
  };
  mutable.connection={accessToken:"faketoken",instanceUrl:"https://test.my.salesforce.com",
    organizationId:"00Dmock",userId:"005mock",connectedAt:"session-1"};
  mutable.connect=async()=>{};
  const oldFetch=globalThis.fetch;
  const calls:Array<{url:string;method:string;body:string}>=[];
  globalThis.fetch=async(input,init)=>{
    calls.push({url:String(input),method:init?.method??"",body:String(init?.body)});
    return new Response(soap("Account.Export_Fields"),{status:200,
      headers:{"content-type":"text/xml"}});
  };
  try{
    const fields=await connection.readFieldSetMetadata("Account","Export_Fields");
    assert.deepEqual(fields,["Name","Owner.Name"]);
    assert.equal(calls.length,1);
    assert.equal(calls[0].method,"POST");
    assert.match(calls[0].url,/\/services\/Soap\/m\//);
    assert.match(calls[0].body,/<met:readMetadata>/);
    assert.doesNotMatch(calls[0].body,/<met:(?:updateMetadata|deploy|createMetadata)>/);
  }finally{globalThis.fetch=oldFetch;}
});

test("Stage 3: SOAP Field Set mismatched identity is rejected",async()=>{
  const connection=new SalesforceOrgConnection();
  const mutable=connection as unknown as {
    connection:unknown;connect:()=>Promise<void>;
  };
  mutable.connection={accessToken:"faketoken",instanceUrl:"https://test.my.salesforce.com",
    organizationId:"00Dmock",userId:"005mock",connectedAt:"session-1"};
  mutable.connect=async()=>{};
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(soap("Contact.Export_Fields"),{status:200});
  try{
    await assert.rejects(connection.readFieldSetMetadata("Account","Export_Fields"),
      /identity did not match/);
  }finally{globalThis.fetch=oldFetch;}
});


test("Metadata SOAP batch correlates reversed records, rejects duplicate/invalid/missing names and enforces ten-name limit",async()=>{
 const connection=new SalesforceOrgConnection();
 const mutable=connection as unknown as {connection:unknown;connect:()=>Promise<void>};
 mutable.connection={accessToken:"faketoken",instanceUrl:"https://test.my.salesforce.com",
  organizationId:"00Dmock",userId:"005mock",connectedAt:"session-1"};
 mutable.connect=async()=>{};
 const original=globalThis.fetch;
 const requests:string[]=[];
 const record=(name:string,field:string)=>"<met:records><met:fullName>"+name+"</met:fullName><met:displayedFields><met:field>"+field+"</met:field></met:displayedFields></met:records>";
 let records=record("Contact.Fields","Email")+record("Account.Fields","Owner.Name")+record("Case.Fields","Id")+record("Case.Fields","Subject")+record("Lead.Fields","Bad field");
 globalThis.fetch=async(_input,init)=>{
  requests.push(String(init?.body));
  return new Response('<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata"><env:Body><met:readMetadataResponse><met:result>'+records+'</met:result></met:readMetadataResponse></env:Body></env:Envelope>',{status:200});
 };
 try{
  const names=["Account.Fields","Contact.Fields","Case.Fields","Lead.Fields","Task.Fields"];
  const result=await connection.readFieldSetMetadataBatch(names);
  assert.deepEqual(result,new Map([["Contact.Fields",["Email"]],["Account.Fields",["Owner.Name"]]]));
  assert.equal(requests.length,1);
  for(const name of names)assert.ok(requests[0].includes("<met:fullNames>"+name+"</met:fullNames>"));
  await assert.rejects(connection.readFieldSetMetadataBatch(Array.from({length:11},(_,i)=>"Account.Fields"+i)),/Invalid Field Set batch/);
  assert.equal(requests.length,1);
  records=record("Unrequested.Fields","Id");
  await assert.rejects(connection.readFieldSetMetadataBatch(["Account.Fields","Contact.Fields"]),/identity did not match/);
 }finally{globalThis.fetch=original;}
});
