import assert from "node:assert/strict";
import { test } from "node:test";
import { SalesforceApexMetadataProvider } from "../src/salesforce/SalesforceApexMetadataProvider.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

function connectionWithLabels(rows:()=>Array<Record<string,unknown>>,
  localizations:()=>Array<Record<string,unknown>>) {
  const calls:string[]=[];
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async(soql:string,api:string)=>{
      calls.push(api+"|"+soql);
      if(api!=="tooling")throw Error("Test must use read-only Tooling query.");
      return soql.includes("FROM ExternalStringLocalization")?localizations():rows();
    },
  } as unknown as SalesforceOrgConnection;
  return {connection,calls};
}
const id="101000000000001AAA";

test("Custom Label uses ExternalString master value only, even when translation API is unsupported",async()=>{
  let masterValue="Id,Name";
  const {connection,calls}=connectionWithLabels(
    ()=>[{Id:id,Name:"My_Columns",Value:masterValue,NamespacePrefix:null}],
    ()=>{throw Error("INVALID_TYPE: ExternalStringLocalization is not supported");});
  const provider=new SalesforceApexMetadataProvider(connection);
  const first=await provider.getCustomLabelValue("My_Columns");
  assert.equal(first.complete,true);
  assert.equal(first.value,"Id,Name");
  masterValue="Name,Phone";
  const second=await provider.getCustomLabelValue("My_Columns");
  assert.equal(second.complete,true);
  assert.equal(second.value,"Name,Phone");
  assert.equal(calls.length,2,"one master-value lookup each time");
  assert.ok(calls.every(call=>call.startsWith("tooling|SELECT ")&&
    call.includes("FROM ExternalString WHERE")&&!call.includes("ExternalStringLocalization")));
});

test("Custom Label provider rejects duplicate or missing org label values",async()=>{
  const {connection}=connectionWithLabels(
    ()=>[{Id:id,Name:"My_Columns",Value:"Id"},
      {Id:"101000000000002AAA",Name:"My_Columns",Value:"Name"}],
    ()=>[]);
  const provider=new SalesforceApexMetadataProvider(connection);
  const invalid=await provider.getCustomLabelValue("My_Columns");
  assert.equal(invalid.complete,false);
  assert.match(invalid.reason??"",/ambiguous/i);
  const unknown=await provider.getCustomLabelValue("bad'name");
  assert.equal(unknown.complete,false);
  assert.match(unknown.reason??"",/invalid/i);
});

test("Stage 3 final: Field Set Tooling metadata produces ordered and validated field paths",async()=>{
  const calls:string[]=[];
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async(soql:string,api:string)=>{
      calls.push(api+"|"+soql);
      assert.equal(api,"tooling");
      if(soql.includes("SELECT Id, DeveloperName")){
        return [{Id:"0IX000000000001AAA",DeveloperName:"Export_Fields",
          EntityDefinition:{QualifiedApiName:"Account"}}];
      }
      return [{Metadata:{displayedFields:[
        {field:"Name"},{field:"Owner.Name"},{field:"Custom_Code__c"}]}}];
    },
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection)
    .getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,true,JSON.stringify(result));
  assert.deepEqual(result.value,["Name","Owner.Name","Custom_Code__c"]);
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.startsWith("tooling|SELECT")));
});
test("Stage 3 final: Field Set metadata missing displayedFields cannot verify fields",async()=>{
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async(soql:string)=>soql.includes("SELECT Id, DeveloperName")
      ?[{Id:"0IX000000000001AAA",DeveloperName:"Export_Fields",
          EntityDefinition:{QualifiedApiName:"Account"}}]
      :[{Metadata:{availableFields:[{field:"Name"}]}}],
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection)
    .getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,false);
  assert.match(result.reason??"",/displayedFields/i);
});
test("Stage 3 final: Custom Metadata snapshots refresh between scans",async()=>{
  const calls:string[]=[];
  let sourceField="Status";
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async(soql:string,api:string)=>{
      calls.push(api+"|"+soql);
      return [{DeveloperName:"Only",Source_Field__c:sourceField,Active__c:true}];
    },
  } as unknown as SalesforceOrgConnection;
  const provider=new SalesforceApexMetadataProvider(connection);
  const before=await provider.getCustomMetadataRecords("Field_Mapping__mdt",
    ["Source_Field__c","Active__c"]);
  assert.equal(before.value?.[0].Source_Field__c,"Status");
  sourceField="OrderNumber";
  const after=await provider.getCustomMetadataRecords("Field_Mapping__mdt",
    ["Source_Field__c","Active__c"]);
  assert.equal(after.value?.[0].Source_Field__c,"OrderNumber");
  assert.equal(calls.length,2);
});

test("Metadata API Field Set primary path is read-only and scoped to the exact object",async()=>{
  const calls:Array<{object:string;name:string}>=[];
  let toolingCalls=0;
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async()=>{toolingCalls++;throw Error("Tooling FieldSet metadata not available");},
    readFieldSetMetadata:async(object:string,name:string)=>{
      calls.push({object,name});
      return ["Id","Account.Name","CreatedDate"];
    },
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection)
    .getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,true,JSON.stringify(result));
  assert.deepEqual(result.value,["Id","Account.Name","CreatedDate"]);
  assert.deepEqual(calls,[{object:"Account",name:"Export_Fields"}]);
  assert.equal(toolingCalls,0);
});

test("Denied Metadata API with unavailable Tooling fallback is not silently accepted",async()=>{
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async()=>{throw Error("Tooling metadata property unavailable");},
    readFieldSetMetadata:async()=>{throw Error("INSUFFICIENT_ACCESS_OR_READONLY");},
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection)
    .getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,false);
  assert.match(result.reason??"",/INSUFFICIENT_ACCESS_OR_READONLY/);
});

test("Custom Metadata provider handles canonical Salesforce field casing in Apex queries",async()=>{
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",connectedAt:"connection-1"},
    queryAll:async(soql:string,api:string)=>{
      assert.equal(api,"data");assert.match(soql,/FROM Field_Mapping__mdt/i);
      return [{DeveloperName:"Mapping",Type__c:"Draft",Source_Field__c:"Name",Active__c:true}];
    },
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection).getCustomMetadataRecords(
    "Field_Mapping__mdt",["type__c","Source_Field__c","Active__c"]);
  assert.equal(result.complete,true,JSON.stringify(result));
  assert.equal(result.value?.[0].type__c,"Draft");
});

test("CMDT provider issues validated server-side typed WHERE filters and accepts an empty result",async()=>{
  const calls:string[]=[];
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",connectedAt:"connection-1"},
    queryAll:async(soql:string,api:string)=>{
      assert.equal(api,"data");calls.push(soql);return [];
    },
  } as unknown as SalesforceOrgConnection;
  const provider=new SalesforceApexMetadataProvider(connection);
  const result=await provider.getCustomMetadataRecords("Example__mdt",["Source_Field__c"],[
    {field:"EDI_Code__c",value:"945"},{field:"Active__c",value:true},
    {field:"Sequence__c",value:2},{field:"Label__c",value:"O'Brien\\Folder"},
    {field:"Text__c",value:"true"},
  ]);
  assert.equal(result.complete,true);assert.deepEqual(result.value,[]);
  assert.equal(calls.length,1);
  assert.ok(calls[0].includes("FROM Example__mdt WHERE EDI_Code__c = '945' AND Active__c = true AND Sequence__c = 2"));
  assert.ok(calls[0].includes("Label__c = 'O\\'Brien\\\\Folder'"));
  assert.ok(calls[0].includes("Text__c = 'true'"));
  const invalid=await provider.getCustomMetadataRecords("Example__mdt",["Source_Field__c"],[
    {field:"Active__c OR Name",value:true},
  ]);
  assert.equal(invalid.complete,false);assert.equal(calls.length,1);
});


test("Field Set SOAP failure falls back to Tooling while preserving exact identity and order",async()=>{
  const calls:string[]=[];
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",connectedAt:"connection-1"},
    readFieldSetMetadata:async()=>{calls.push("soap");throw Error("Metadata access unavailable");},
    queryAll:async(soql:string)=>{
      if(soql.includes("SELECT Id, DeveloperName")){
        calls.push("inventory");
        return [{Id:"0IX000000000001AAA",DeveloperName:"Export_Fields",EntityDefinition:{QualifiedApiName:"Account"}}];
      }
      calls.push("detail");return [{Metadata:{displayedFields:[{field:"Id"},{field:"Owner.Name"}]}}];
    },
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection).getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,true);
  assert.deepEqual(result.value,["Id","Owner.Name"]);
  assert.deepEqual(calls,["soap","inventory","detail"]);
});

test("Invalid Field Set SOAP members cannot be accepted when fallback also fails",async()=>{
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",connectedAt:"connection-1"},
    readFieldSetMetadata:async()=>["Name","Bad field"],
    queryAll:async()=>{throw Error("INVALID_FIELD");},
  } as unknown as SalesforceOrgConnection;
  const result=await new SalesforceApexMetadataProvider(connection).getFieldSetFields("Account","Export_Fields");
  assert.equal(result.complete,false);
  assert.match(result.reason??"",/members are invalid/);
  assert.match(result.reason??"",/INVALID_FIELD/);
});
