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

test("Custom Label metadata uses Tooling API and rejects locale-dependent values",async()=>{
  let translationValue="Name,Phone";
  const {connection,calls}=connectionWithLabels(
    ()=>[{Id:id,Name:"My_Columns",Value:"Id,Name",NamespacePrefix:null}],
    ()=>[{Value:translationValue}]);
  const provider=new SalesforceApexMetadataProvider(connection);
  const uncertain=await provider.getCustomLabelValue("My_Columns");
  assert.equal(uncertain.complete,false);
  assert.match(uncertain.reason??"",/locale-dependent/i);
  translationValue="Id,Name";
  const verified=await provider.getCustomLabelValue("My_Columns");
  assert.equal(verified.complete,true);
  assert.equal(verified.value,"Id,Name");
  assert.equal(calls.length,4,"Values must be refreshed on each analysis.");
  assert.ok(calls.every(call=>call.startsWith("tooling|SELECT ")));
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

test("Stage 3 final: Metadata API Field Set fallback is read-only and scoped to the exact object",async()=>{
  const calls:Array<{object:string;name:string}>=[];
  const connection={
    status:{organizationId:"00Dmock",userId:"005mock",instanceUrl:"https://example.my.salesforce.com",
      connectedAt:"connection-1"},
    queryAll:async()=>{throw Error("Tooling FieldSet metadata not available");},
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
});

test("Stage 3 final: denied Metadata API fallback is not silently accepted",async()=>{
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
