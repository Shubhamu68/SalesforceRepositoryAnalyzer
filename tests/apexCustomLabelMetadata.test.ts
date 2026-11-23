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
