import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexAnalysisEngine,analyzeApexInvocations} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {evaluateApexExpression,textValue,unknown,listValue} from "../src/core/apex/ApexValueEvaluator.js";
import {planCustomMetadataRequest,resolveCustomMetadataRows} from "../src/core/apex/ApexCustomMetadataQueries.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import type {ApexMetadataProvider,CustomMetadataFilter} from "../src/core/metadata/ApexMetadataProvider.js";

test("shared engine supplies generic non-SOQL invocation arguments and one scan-scoped metadata read",async()=>{
  const code=[
    "public class Consumer {",
    " public static void run(){",
    "  String field=System.Label.Configured_Field;",
    "  CustomInspector.inspect(field,'Account',7);",
    " }",
    "}",
  ].join("\n");
  const index=new ApexRepositoryMethodIndex([{filePath:"Consumer.cls",source:code}]);
  let reads=0;
  const metadata:ApexMetadataProvider={
    scopeKey:"mock-org",
    getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
    getCustomMetadataRecords:async()=>({complete:false,source:"LIVE_ORG"}),
    getCustomLabelValue:async()=>{reads++;return {complete:true,source:"LIVE_ORG",value:"Name"};},
  };
  const session=new ApexAnalysisEngine(index,metadata);
  const select=(name:string)=>name==="CustomInspector.inspect"?{method:name,argumentIndices:[0,1,2]}:undefined;
  const results=await Promise.all([session.analyzeInvocations(code,"Consumer.cls",select),
    session.analyzeInvocations(code,"Consumer.cls",select)]);
  for(const result of results){
    assert.equal(result.sites.length,1);
    assert.equal(result.failures.size,0);
    assert.deepEqual(result.captures.get(result.sites[0].offset)?.[0].arguments,
      [textValue("Name"),textValue("Account"),{kind:"number",value:7}]);
  }
  assert.equal(reads,1);
});

test("server-selected null filter column stays in inventory for a proven empty-string bind",()=>{
  const request=planCustomMetadataRequest("[SELECT Source_Field__c FROM Example__mdt WHERE Code__c = :code]",[textValue("")]);
  assert.ok(!("kind" in request));
  const row={Source_Field__c:"Name",Code__c:null};
  const result=resolveCustomMetadataRows(request,{complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:[row]});
  assert.deepEqual(result,{kind:"records",items:[[["Source_Field__c",textValue("Name")]]]});
  assert.deepEqual(resolveCustomMetadataRows(request,{complete:true,source:"LIVE_ORG",value:[row]}),{kind:"records",items:[]});
  const missing=resolveCustomMetadataRows(request,{complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:[{Source_Field__c:"Name"}]});
  assert.equal(missing.kind,"unknown");
});

test("List and Set membership are exact, case-sensitive and unknown inputs stay unknown",()=>{
  const values=new Map([["fields",listValue(["Id","Name"],true)],["listFields",listValue(["Id","Name"])],["runtime",unknown("runtime")]]);
  for(const collection of ["fields","listFields"]){
    assert.deepEqual(evaluateApexExpression(collection+".contains('Name')",{values}),{kind:"text",values:["true"],scalarType:"boolean"});
    assert.deepEqual(evaluateApexExpression(collection+".contains('name')",{values}),{kind:"text",values:["false"],scalarType:"boolean"});
    assert.equal(evaluateApexExpression(collection+".contains(runtime)",{values}).kind,"unknown");
  }
  assert.deepEqual(evaluateApexExpression("!fields.contains('Id') && true ? 'Phone' : 'Name'",{values}),textValue("Name"));
  assert.deepEqual(evaluateApexExpression("false ? 'One' : true ? 'Two' : 'Three'",{values}),textValue("Two"));
});

test("known false ternary skips malformed query, known true still reports malformed query",()=>{
  const wrap=(body:string)=>"public class Consumer { public static void run(){ "+body+" } }";
  const skipped=extractDynamicSoqlQueries(wrap("Map<String,String> fields=new Map<String,String>(); List<Account> records=!fields.isEmpty()?Database.query('SELECT , FROM Account'):new List<Account>();"),"Consumer.cls");
  assert.equal(skipped.queries.length,0);assert.equal(skipped.unresolved.length,0);
  const executed=extractDynamicSoqlQueries(wrap("Map<String,String> fields=new Map<String,String>{'Name'=>'Name'}; List<Account> records=!fields.isEmpty()?Database.query('SELECT , FROM Account'):new List<Account>();"),"Consumer.cls");
  assert.equal(executed.queries.length,0);assert.equal(executed.unresolved.length,1);
  assert.match(executed.unresolved[0].reason,/reconstructed SOQL could not be parsed/);
});
test("unknown ternary guard retains both feasible invocations; adjacent arguments not skipped",()=>{
  const code="public class Consumer { public static void run(Boolean flag){ CustomInspector.inspect(flag?CustomInspector.pick('A'):CustomInspector.pick('B'),CustomInspector.pick('C')); } }";
  const flow=analyzeApexInvocations(code,"Consumer.cls",name=>name==="CustomInspector.pick"?{method:name,argumentIndices:[0]}:undefined);
  assert.equal(flow.sites.length,3);
  assert.equal(flow.unreachable.size,0);
  assert.deepEqual(flow.sites.map(s=>flow.captures.get(s.offset)?.[0].arguments?.[0]),["A","B","C"].map(textValue));
  const known=code.replace("Boolean flag","").replace("flag?","true?");
  const knownFlow=analyzeApexInvocations(known,"Consumer.cls",name=>name==="CustomInspector.pick"?{method:name,argumentIndices:[0]}:undefined);
  assert.equal(knownFlow.unreachable.size,1);
  assert.deepEqual(knownFlow.sites.filter(s=>!knownFlow.unreachable.has(s.offset)).map(s=>knownFlow.captures.get(s.offset)?.[0].arguments?.[0]),["A","C"].map(textValue));
});

test("explicit throw eliminates the normal path without an invented return",()=>{
  const code="public class Consumer { public static void run(Boolean flag){ String q='SELECT Id FROM Account'; if(flag){ q='SELECT , FROM Account'; throw new CustomException(); } Database.query(q); } }";
  const result=extractDynamicSoqlQueries(code,"Consumer.cls");
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query),["SELECT Id FROM Account"]);
});

// Structural reproductions of the uploaded mapping inventories. Synthetic
// object/field names only: no customer Apex or live metadata in the repo.
const helper=[
  "public class MappingService {",
  " public static Example__mdt[] rows(String code,String kind){",
  "  return [SELECT Source_Field__c, Source_Object__c, Target_Field__c, Target_Object__c FROM Example__mdt WHERE Code__c=:code AND Kind__c=:kind AND Active__c=true];",
  " }",
  "}",
].join("\n");
type Row=Record<string,unknown>;
const row=(code:string|null,kind:string,object:string,field:string,target:string):Row=>({
  Code__c:code,Kind__c:kind,Active__c:true,Source_Object__c:object,Target_Object__c:"Target__c",Source_Field__c:field,Target_Field__c:target,
});
function rows(code:string|null,kind:string,object:string,count:number):Row[]{
  return Array.from({length:count},(_,i)=>row(code,kind,object,"Mapped_"+(i+1)+"__c","Target_"+(i+1)+"__c"));
}
function mappingProvider(inventory:Row[]):ApexMetadataProvider{
  return {
    scopeKey:"fixture-org",
    getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
    getCustomMetadataRecords:async(_object:string,_fields:readonly string[],filters?:readonly CustomMetadataFilter[])=>{
      const matching=inventory.filter(record=>filters?.every(f=>record[f.field]===f.value||(f.value===""&&record[f.field]===null)));
      return {complete:true,source:"LIVE_ORG",filterEvidence:"SERVER_FILTERED",value:matching};
    },
  };
}
async function analyzeFixture(code:string,inventory:Row[]){
  const index=new ApexRepositoryMethodIndex([{filePath:"MappingService.cls",source:helper},{filePath:"Consumer.cls",source:code}]);
  return new ApexAnalysisEngine(index,mappingProvider(inventory)).analyze("Consumer.cls",ctx=>
    extractDynamicSoqlQueries(code,"Consumer.cls",ctx.resolveExternal,ctx.repositoryIndex));
}
function verifyFields(result:Awaited<ReturnType<typeof analyzeFixture>>,expected:Record<string,string[]>){
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.equal(result.queries.length,Object.keys(expected).length);
  for(const query of result.queries){
    const select=/^SELECT\s+([\s\S]+?)\s+FROM\s+/i.exec(query.query)?.[1];
    assert.ok(select);
    assert.deepEqual(select.split(",").map(x=>x.trim()).sort(),expected[query.object].sort());
  }
}
const fields=(count:number)=>Array.from({length:count},(_,i)=>"Mapped_"+(i+1)+"__c");

test("76-row blank-code helper snapshot reconstructs all three queries including trailing-space skeleton",async()=>{
  const groups=[["Account",43],["Contact",16],["Case",17]] as const;
  const inventory=groups.flatMap(([object,count])=>rows(null,"Credit",object,count));
  const code=[
    "public class Consumer {",
    " public static void run(){",
    "  List<Example__mdt> records=MappingService.rows('','Credit');",
    "  String a=build(records,'Account','SELECT Id,Name,');",
    "  String b=build(records,'Contact','SELECT Id,Name,');",
    "  String c=build(records,'Case','SELECT Id,Name, ');",
    "  Database.query(a); Database.query(b); Database.query(c);",
    " }",
    " private static String build(List<Example__mdt> records,String objectName,String q){",
    "  Map<String,String> mapping=new Map<String,String>();",
    "  for(Example__mdt m:records){",
    "   if(m.Source_Object__c==objectName && m.Target_Object__c=='Target__c'){",
    "    mapping.put(m.Source_Field__c,m.Target_Field__c); q+=m.Source_Field__c+',';",
    "   }",
    "  }",
    "  return q.removeEnd(',')+' FROM '+objectName;",
    " }",
    "}",
  ].join("\n");
  const result=await analyzeFixture(code,inventory);
  verifyFields(result,{Account:["Id","Name",...fields(43)],Contact:["Id","Name",...fields(16)],Case:["Id","Name",...fields(17)]});
});

test("60-row blank-code mapping and conditional database calls preserve all fields",async()=>{
  const inventory=[...rows(null,"Invoice","Account",30),...rows(null,"Invoice","Contact",30)];
  const code=[
    "public class Consumer {",
    " public static void run(){",
    "  String a='SELECT Id,Name, '; String b='SELECT ';",
    "  Map<String,String> am=new Map<String,String>(); Map<String,String> bm=new Map<String,String>();",
    "  for(Example__mdt m:MappingService.rows('','Invoice')){",
    "   if(m.Source_Object__c=='Account'){am.put(m.Source_Field__c,m.Target_Field__c); a+=m.Source_Field__c+',';}",
    "   if(m.Source_Object__c=='Contact'){bm.put(m.Source_Field__c,m.Target_Field__c); b+=m.Source_Field__c+',';}",
    "  }",
    "  List<Account> av=!am.isEmpty()?Database.query(a.removeEnd(',')+',Phone FROM Account'):new List<Account>();",
    "  List<Contact> bv=!bm.isEmpty()?Database.query(b.removeEnd(',')+',Email FROM Contact'):new List<Contact>();",
    " }",
    "}",
  ].join("\n");
  const result=await analyzeFixture(code,inventory);
  verifyFields(result,{Account:["Id","Name","Phone",...fields(30)],Contact:["Email",...fields(30)]});
});
test("36-row mapping with 13 source mappings and 12 unique fields stays within normal execution budget",async()=>{
  const inventory=[...rows("945","Shipment","Account",9),...rows("945","Shipment","Contact",12),
    row("945","Shipment","Contact","Mapped_1__c","Different_Target__c"),...rows("945","Shipment","Case",14)];
  const code=[
    "public class Consumer {",
    " public static void run(Boolean fail){",
    "  try{",
    "   if(fail){throw new CustomException();}",
    "   String a='SELECT Id,'; String b='SELECT '; String c='SELECT ';",
    "   Set<String> seen=new Set<String>();",
    "   Map<String,String> am=new Map<String,String>(); Map<String,String> bm=new Map<String,String>(); Map<String,String> cm=new Map<String,String>();",
    "   for(Example__mdt m:MappingService.rows('945','Shipment')){",
    "    if(m.Source_Object__c=='Account'){am.put(m.Source_Field__c,m.Target_Field__c);a+=m.Source_Field__c+',';}",
    "    if(m.Source_Object__c=='Contact'){bm.put(m.Source_Field__c,m.Target_Field__c);if(!seen.contains(m.Source_Field__c)){seen.add(m.Source_Field__c);b+=m.Source_Field__c+',';}}",
    "    if(m.Source_Object__c=='Case'){cm.put(m.Source_Field__c,m.Target_Field__c);c+=m.Source_Field__c+',';}",
    "   }",
    "   if(!am.isEmpty()){Database.query(a.removeEnd(',')+' FROM Account');}",
    "   if(!bm.isEmpty()){Database.query(b.removeEnd(',')+' FROM Contact');}",
    "   if(!cm.isEmpty()){Database.query(c.removeEnd(',')+' FROM Case');}",
    "  }catch(Exception e){System.debug(e);}",
    " }",
    "}",
  ].join("\n");
  const result=await analyzeFixture(code,inventory);
  verifyFields(result,{Account:["Id",...fields(9)],Contact:fields(12),Case:fields(14)});
});
