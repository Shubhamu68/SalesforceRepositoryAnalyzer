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
