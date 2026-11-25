import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexAnalysisEngine,analyzeApexInvocations} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {evaluateApexExpression,textValue,unknown,listValue,booleanValue,type ApexValue} from "../src/core/apex/ApexValueEvaluator.js";
import {resolveSchemaSnapshot,resolveSchemaFieldMap} from "../src/core/apex/ApexSchemaModel.js";
import {traceApexDependencies} from "../src/core/apex/ApexBackwardDependencyEngine.js";
import type {ApexObjectSchema} from "../src/core/metadata/ApexMetadataProvider.js";
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


const schemaFixture:Record<string,ApexObjectSchema>={
  contact:{name:"Contact",fields:[
    {name:"Id",type:"id",nameField:false},
    {name:"Birthdate",type:"date",nameField:false,referenceTo:[],relationshipName:null},
    {name:"AccountId",type:"reference",nameField:false,relationshipName:"Account",referenceTo:["Account"]},
    {name:"OwnerId",type:"reference",nameField:false,relationshipName:"Owner",referenceTo:["User","Group"]},
    {name:"Name",type:"string",nameField:true},
    {name:"Incomplete__c"}
  ]},
  account:{name:"Account",fields:[{name:"Name",type:"string",nameField:true},{name:"Id",type:"id",nameField:false},
    {name:"ParentId",type:"reference",relationshipName:"Parent",referenceTo:["Account"],nameField:false}]}
};
const schemaResolver=(method:string,args:ApexValue[])=>{
  if((method!=="Schema.objectSchema"&&method!=="Schema.fieldMap")||args.some(a=>a.kind!=="text"||a.values.length!==1))return undefined;
  const [object,field]=args.map(a=>a.kind==="text"?a.values[0]:"");
  const result={complete:true,source:"LIVE_ORG" as const,value:schemaFixture[object.toLowerCase()]};
  return method==="Schema.fieldMap"?resolveSchemaFieldMap(result,object):resolveSchemaSnapshot(result,object,field);
};
test("typed Schema field reads preserve enum equality, relationship names, singleton reference tokens and name fields",()=>{
  const context={values:new Map<string,ApexValue>(),resolveCall:schemaResolver};
  for(const expression of [
    "Contact.Birthdate.getDescribe().getType() == Schema.DisplayType.DATE",
    "Schema.SObjectType.Contact.fields.Birthdate.getDescribe().getType() == Schema.DisplayType.DATE",
    "Contact.Name.getDescribe().isNameField()",
    "Schema.getGlobalDescribe().get('Contact').getDescribe().fields.getMap().get('Name').getDescribe().isNameField()"
  ])assert.deepEqual(evaluateApexExpression(expression,context),booleanValue(true),expression);
  assert.deepEqual(evaluateApexExpression("Contact.AccountId.getDescribe().getRelationshipName()",context),textValue("Account"));
  assert.deepEqual(evaluateApexExpression("Contact.AccountId.getDescribe().getReferenceTo()[0].getDescribe().getName()",context),textValue("Account"));
  assert.deepEqual(evaluateApexExpression("Contact.Birthdate.getDescribe().getType() == Schema.DisplayType.DATETIME",context),booleanValue(false));
  assert.equal(evaluateApexExpression("Contact.Birthdate.getDescribe().getType() == 'DATE'",context).kind,"unknown");
});
test("unavailable and polymorphic Schema metadata never invents facts or permissions",()=>{
  const context={values:new Map<string,ApexValue>(),resolveCall:schemaResolver};
  for(const expression of [
    "Contact.Incomplete__c.getDescribe().isNameField()",
    "Contact.Incomplete__c.getDescribe().getType()",
    "Contact.OwnerId.getDescribe().getReferenceTo()[0].getDescribe().getName()",
    "Contact.Missing__c.getDescribe().getType()",
    "Contact.Name.getDescribe().isAccessible()",
    "Contact.Name.getDescribe().getType() == 'STRING'"
  ])assert.equal(evaluateApexExpression(expression,context).kind,"unknown",expression);
  assert.deepEqual(evaluateApexExpression("Contact.Birthdate.getDescribe().getRelationshipName()",context),{kind:"null"});
  assert.equal(evaluateApexExpression("Contact.Name.getDescribe().getType()",{...context,values:new Map([["Contact",unknown("runtime object")]])}).kind,"unknown");
});
test("AUE shares a case-insensitive Schema snapshot across independent non-SOQL forward and backward consumers",async()=>{
  const source="public class Inspector {public static void run(){Schema.DescribeFieldResult field=Contact.AccountId.getDescribe();String rel=field.getRelationshipName();Schema.DisplayType typ=field.getType();Inspector.consume(rel,typ==Schema.DisplayType.REFERENCE);} }";
  const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
  let reads=0;
  const metadata:ApexMetadataProvider={scopeKey:"fixture-schema",getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
    getCustomMetadataRecords:async()=>({complete:false,source:"LIVE_ORG"}),
    getObjectSchema:async object=>{reads++;return {complete:true,source:"LIVE_ORG",value:schemaFixture[object.toLowerCase()]};}};
  const session=new ApexAnalysisEngine(index,metadata);
  const result=await session.analyzeInvocations(source,filePath,name=>name==="Inspector.consume"?{method:name,argumentIndices:[0,1]}:undefined);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.[0].arguments,[textValue("Account"),booleanValue(true)]);
  const back=await session.analyze(filePath,ctx=>traceApexDependencies(source,filePath,{expression:"rel",offset:source.indexOf("Inspector.consume")},index,ctx.resolveExternal));
  assert.deepEqual(back.candidates.map(c=>c.value),[textValue("Account")],JSON.stringify(back));
  await session.analyze(filePath,ctx=>evaluateApexExpression("contact.Birthdate.getDescribe().getType()",{values:new Map(),resolveCall:ctx.resolveExternal}));
  assert.equal(reads,1);
});
test("known metadata can select the appropriate field transformation in generic AUE flow",()=>{
  const source="public class Inspector {public static void run(){Set<String> fields=new Set<String>{'Id'};Schema.DescribeFieldResult dfr=Contact.Birthdate.getDescribe();if(dfr.getType()==Schema.DisplayType.DATE){fields.add('FORMAT(Birthdate)');}else{fields.add('Birthdate');}Inspector.consume(String.join(fields,','));}}";
  const result=analyzeApexInvocations(source,"Inspector.cls",name=>name==="Inspector.consume"?{method:name,argumentIndices:[0]}:undefined,schemaResolver);
  assert.deepEqual(result.captures.get(result.sites[0].offset)?.map(c=>c.arguments?.[0]),[textValue("Id,FORMAT(Birthdate)")]);
});

test("Schema relationship traversal resolves typed local receivers and nested reference reads without guessing targets",()=>{
  const context={values:new Map<string,ApexValue>(),resolveCall:schemaResolver};
  const ref=evaluateApexExpression("Contact.AccountId.getDescribe().getReferenceTo()",context);
  const desc=evaluateApexExpression("Contact.AccountId.getDescribe().getReferenceTo()[0].getDescribe()",context);
  const local={...context,values:new Map<string,ApexValue>([["refs",ref],["desc",desc]]),
    argumentTypes:(parts:readonly string[])=>parts.map(p=>p==="refs"?"List<Schema.SObjectType>":p==="desc"?"Schema.DescribeSObjectResult":undefined)};
  for(const expression of [
    "refs[0].getDescribe().getName()",
    "refs.get(0).getDescribe().getName()",
    "desc.fields.getMap().get('ParentId').getDescribe().getReferenceTo()[0].getDescribe().getName()",
    "Contact.AccountId.getDescribe().getReferenceTo()[0].getDescribe().fields.getMap().get('ParentId').getDescribe().getReferenceTo()[0].getDescribe().getName()"
  ])assert.deepEqual(evaluateApexExpression(expression,local),textValue("Account"),expression);
  assert.equal(evaluateApexExpression("refs[1].getDescribe().getName()",local).kind,"unknown");
  assert.equal(evaluateApexExpression("Contact.OwnerId.getDescribe().getReferenceTo().get(0).getDescribe().getName()",local).kind,"unknown");
});
test("backward Schema traversal follows a local reference list and rejects a mutated list",()=>{
  for(const mutation of ["","refs.clear();"]){
    const source="public class Inspector {public static void run(){List<Schema.SObjectType> refs=Contact.AccountId.getDescribe().getReferenceTo();"+mutation+"Inspector.consume(refs[0].getDescribe().getName());}}";
    const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const back=traceApexDependencies(source,filePath,{expression:"refs[0].getDescribe().getName()",offset:source.indexOf("Inspector.consume")},index,schemaResolver);
    if(mutation)assert.ok(back.candidates.every(c=>c.value.kind==="unknown"),JSON.stringify(back));
    else assert.deepEqual(back.candidates.map(c=>c.value),[textValue("Account")],JSON.stringify(back));
  }
});

test("typed Describe maps retain field tokens and case-insensitive keys; ordinary Maps remain case-sensitive",()=>{
  const context={values:new Map<string,ApexValue>(),resolveCall:schemaResolver};
  const fields=evaluateApexExpression("Contact.SObjectType.getDescribe().fields.getMap()",context);
  assert.equal(fields.kind,"map");
  const local={...context,values:new Map<string,ApexValue>([["fields",fields]])};
  assert.deepEqual(evaluateApexExpression("fields.get('BIRTHDATE').getDescribe().getName()",local),textValue("Birthdate"));
  assert.deepEqual(evaluateApexExpression("fields.containsKey('ACCOUNTID')",local),booleanValue(true));
  assert.deepEqual(evaluateApexExpression("fields.get('Missing__c')",local),{kind:"null"});
  const regular=evaluateApexExpression("new Map<String,String>{'Name'=>'Name'}",context);
  assert.deepEqual(evaluateApexExpression("fields.containsKey('NAME')",{...context,values:new Map([["fields",regular]])}),booleanValue(false));
});
test("typed field maps use existing forward alias handling and isolate fresh Describe snapshots",()=>{
  const source="public class Inspector {public static void run(){Map<String,Schema.SObjectField> fields=Contact.SObjectType.getDescribe().fields.getMap();Map<String,Schema.SObjectField> alias=fields;Map<String,Schema.SObjectField> fresh=Contact.SObjectType.getDescribe().fields.getMap();alias.remove('birthdate');fields.put('custom',Schema.SObjectType.Contact.fields.AccountId);Inspector.consume(fields.containsKey('Birthdate'),fresh.containsKey('Birthdate'),alias.get('CUSTOM').getDescribe().getName());}}";
  const report=analyzeApexInvocations(source,"Inspector.cls",name=>name==="Inspector.consume"?{method:name,argumentIndices:[0,1,2]}:undefined,schemaResolver);
  assert.deepEqual(report.captures.get(report.sites[0].offset)?.[0]?.arguments,[booleanValue(false),booleanValue(true),textValue("AccountId")],JSON.stringify([...report.failures]));
});
test("backward typed map reads replay exact local mutations but reject alias escape",()=>{
  for(const middle of ["","fields.remove('birthdate');","Map<String,Schema.SObjectField> alias=fields;alias.clear();"]){
    const source="public class Inspector {public static void run(){Map<String,Schema.SObjectField> fields=Contact.SObjectType.getDescribe().fields.getMap();"+middle+"Inspector.consume(fields.containsKey('Birthdate'));}}";
    const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const back=traceApexDependencies(source,filePath,{expression:"fields.containsKey('Birthdate')",offset:source.indexOf("Inspector.consume")},index,schemaResolver);
    if(middle.includes("alias"))assert.ok(back.candidates.every(c=>c.value.kind==="unknown"),JSON.stringify(back));
    else assert.deepEqual(back.candidates.map(c=>c.value),[booleanValue(!middle)],JSON.stringify(back));
  }
});

test("source-proven metadata selector candidates preserve literal filters and row correlation",async()=>{
  const source=[
    "public class Inspector {",
    "public static void run(String reportName){",
    "Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}",
    "Inspector.consume(cfg.Object__c+'/'+cfg.Field_Set__c);}",
    "private static Config__mdt getConfig(String developerName){",
    "if(String.isBlank(developerName)){return null;}",
    "List<Config__mdt> cfgs=[SELECT DeveloperName,Object__c,Field_Set__c,Optional_Field__c FROM Config__mdt WHERE DeveloperName=:developerName AND Active__c=true LIMIT 1];",
    "return cfgs.isEmpty()?null:cfgs[0];}}"
  ].join("\n");
  const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
  const calls:CustomMetadataFilter[][]=[];
  const metadata:ApexMetadataProvider={
    scopeKey:"selector-candidate-fixture",getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
    getCustomMetadataRecords:async(type,fields,filters)=>{
      assert.equal(type,"Config__mdt");assert.ok(fields.includes("DeveloperName"));calls.push([...(filters??[])]);
      return {complete:true,source:"LIVE_ORG",value:[
        {DeveloperName:"A",Object__c:"Account",Field_Set__c:"AccountFields",Optional_Field__c:null,Active__c:true},
        {DeveloperName:"B",Object__c:"Contact",Field_Set__c:"ContactFields",Optional_Field__c:null,Active__c:true},
        {DeveloperName:"C",Object__c:"Lead",Field_Set__c:"InactiveFields",Optional_Field__c:null,Active__c:false}
      ]};
    }
  };
  const session=new ApexAnalysisEngine(index,metadata);
  const use={expression:"cfg.Object__c+'/'+cfg.Field_Set__c",offset:source.indexOf("Inspector.consume")};
  const result=await session.analyze(filePath,ctx=>traceApexDependencies(source,filePath,use,index,ctx.resolveExternal,{allowMetadataCandidateRows:true}));
  assert.deepEqual(result.candidates.map(c=>c.value).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [textValue("Account/AccountFields"),textValue("Contact/ContactFields")],JSON.stringify(result));
  assert.deepEqual(calls,[[{field:"Active__c",value:true}]]);
  const exactOnly=await session.analyze(filePath,ctx=>traceApexDependencies(source,filePath,use,index,ctx.resolveExternal));
  assert.ok(exactOnly.candidates.every(c=>c.value.kind==="unknown"),JSON.stringify(exactOnly));
});
test("metadata candidate helpers with unsupported effects or filters remain unknown",()=>{
  for(const extra of ["System.debug(developerName);","developerName='A';"]){
    const source="public class Inspector {public static void run(String name){Config__mdt cfg=getConfig(name);Inspector.consume(cfg.Object__c);}private static Config__mdt getConfig(String developerName){"+extra+"List<Config__mdt> cfgs=[SELECT Object__c FROM Config__mdt WHERE DeveloperName=:developerName LIMIT 1];return cfgs.isEmpty()?null:cfgs[0];}}";
    const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    let requests=0;
    const result=traceApexDependencies(source,filePath,{expression:"cfg.Object__c",offset:source.indexOf("Inspector.consume")},index,(name)=>{if(name==="Apex.metadataSelectorCandidates")requests++;return undefined;},{allowMetadataCandidateRows:true});
    assert.equal(requests,0);
    assert.ok(result.candidates.every(c=>c.value.kind==="unknown"),JSON.stringify(result));
  }
});

test("global Describe guard reads share typed Schema evidence in forward and backward analysis",()=>{
  const context={values:new Map<string,ApexValue>([["obj",textValue("Account")]]),resolveCall:schemaResolver};
  for(const [condition,expected] of [
    ["Schema.getGlobalDescribe().get(obj) == null",false],
    ["null != Schema.getGlobalDescribe().get(obj)",true],
    ["Schema.getGlobalDescribe().containsKey(obj)",true],
    ["!Schema.getGlobalDescribe().containsKey(obj)",false]
  ] as const)assert.deepEqual(evaluateApexExpression(condition,context),booleanValue(expected),condition);
  assert.equal(evaluateApexExpression("Schema.getGlobalDescribe().containsKey('Missing__c')",context).kind,"unknown");
  for(const condition of ["Schema.getGlobalDescribe().get(obj)==null","!Schema.getGlobalDescribe().containsKey(obj)"]){
    const source="public class Inspector {public static void run(){String obj='Account';if("+condition+"){System.debug(obj);return;}Inspector.consume(obj);}}";
    const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const events:string[]=[];
    const result=traceApexDependencies(source,filePath,{expression:"obj",offset:source.indexOf("Inspector.consume")},index,schemaResolver,{observe:e=>events.push(e.code)});
    assert.deepEqual(result.candidates.map(c=>c.value),[textValue("Account")],JSON.stringify(result));
    assert.ok(events.includes("SCHEMA_GUARD_RESOLVED"));
    const unavailable=traceApexDependencies(source,filePath,{expression:"obj",offset:source.indexOf("Inspector.consume")},index,()=>undefined);
    assert.ok(unavailable.candidates.every(c=>c.value.kind==="unknown"));
    const missing=traceApexDependencies(source,filePath,{expression:"obj",offset:source.indexOf("Inspector.consume")},index,(method)=>method==="Schema.objectSchema"?{kind:"null"}:undefined);
    assert.ok(missing.candidates.every(c=>c.value.kind==="unknown"));
  }
});
test("global Describe guard does not bypass a reachable mutation or shadowed Schema",()=>{
  for(const middle of ["if(Schema.getGlobalDescribe().containsKey(obj)){obj='Contact';}","String Schema='custom';if(Schema.getGlobalDescribe().get(obj)==null){return;}"]){
    const source="public class Inspector {public static void run(){String obj='Account';"+middle+"Inspector.consume(obj);}}";
    const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const result=traceApexDependencies(source,filePath,{expression:"obj",offset:source.indexOf("Inspector.consume")},index,schemaResolver);
    assert.ok(result.candidates.every(c=>c.value.kind==="unknown"||JSON.stringify(c.value)===JSON.stringify(textValue("Contact"))),JSON.stringify(result));
  }
});

test("shared collection guard adapter reuses null, size and ordered Boolean evaluation",async()=>{
  const {evaluateApexCollectionGuard}=await import("../src/core/apex/ApexCollectionOperations.js");
  const nonempty=listValue(["Name"]),empty=listValue([]),nil:ApexValue={kind:"null"};
  for(const [guard,value,expected] of [
    ["paths == null || paths.isEmpty()",nonempty,false],
    ["paths == null || paths.isEmpty()",empty,true],
    ["paths == null || paths.isEmpty()",nil,true],
    ["paths != null && !paths.isEmpty()",nil,false],
    ["paths != null && paths.size() > 0",nonempty,true],
    ["0 == paths.size()",empty,true],
    ["!(paths == null || paths.isEmpty())",nonempty,true]
  ] as const)assert.deepEqual(evaluateApexCollectionGuard(guard,"paths",value,true),booleanValue(expected),guard);
  assert.equal(evaluateApexCollectionGuard("paths.isEmpty() || paths == null","paths",nil,true)?.kind,"unknown");
  assert.equal(evaluateApexCollectionGuard("paths == null || paths.isEmpty()","paths",nonempty,false)?.kind,"unknown");
  assert.equal(evaluateApexCollectionGuard("paths.size() == 0 || Other.mutate(paths)","paths",empty,true),undefined);
});

test("shared Schema-aware argument replay handles typed field maps and formatted Set mutations",()=>{
  const source="public class Inspector {public static void run(){Map<String,Schema.SObjectField> fields=Contact.SObjectType.getDescribe().fields.getMap();Set<String> selected=new Set<String>{'Id'};for(String f:new List<String>{'Birthdate','Name'}){append(fields,f,selected);}Inspector.consume(String.join(new List<String>(selected),','));}private static void append(Map<String,Schema.SObjectField> fields,String f,Set<String> selected){Schema.DescribeFieldResult d=fields.get(f).getDescribe();if(d.getType()==Schema.DisplayType.DATE){selected.add('FORMAT('+f+')');}else{selected.add(f);}}}";
  const filePath="Inspector.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
  const result=traceApexDependencies(source,filePath,{expression:"String.join(new List<String>(selected),',')",offset:source.indexOf("Inspector.consume")},index,schemaResolver);
  assert.equal(result.candidates.length,1,JSON.stringify(result));
  const value=result.candidates[0].value;
  assert.equal(value.kind,"text",JSON.stringify(result));
  if(value.kind==="text")assert.deepEqual(new Set(value.values[0].split(",")),new Set(["Id","FORMAT(Birthdate)","Name"]));
});
test("name-field discovery through Schema map iteration uses a unique match, not iteration order",()=>{
  const source="public class Inspector {public static void run(){Map<String,Schema.SObjectField> fields=Contact.SObjectType.getDescribe().fields.getMap();for(Schema.SObjectField f:fields.values()){Schema.DescribeFieldResult d=f.getDescribe();if(d.isNameField()){Inspector.consume(d.getName());return;}}}}";
  // The selector helper's early-return loop is tested by a caller, not a
  // target invocation inside the loop (which has separate capture semantics).
  const helper="public class Inspector {public static void run(){Inspector.consume(findName());}private static String findName(){Map<String,Schema.SObjectField> fields=Account.SObjectType.getDescribe().fields.getMap();for(Schema.SObjectField f:fields.values()){Schema.DescribeFieldResult d=f.getDescribe();if(d.isNameField()){return d.getName();}}return null;}}";
  const report=analyzeApexInvocations(helper,"Inspector.cls",name=>name==="Inspector.consume"?{method:name,argumentIndices:[0]}:undefined,schemaResolver);
  assert.deepEqual(report.captures.get(report.sites[0].offset)?.map(c=>c.arguments?.[0]),[textValue("Name")],source);
});
