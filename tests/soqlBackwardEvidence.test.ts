import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {discoverApexInvocations,dynamicDatabaseQuerySelector} from "../src/core/apex/ApexInvocationModel.js";
import {backtrackSoqlPermissionShapes} from "../src/analyzer/soqlBackwardEvidence.js";
import {extractSoqlExpressionFields} from "../src/analyzer/soqlExpressionInventory.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {textValue,type ApexValue} from "../src/core/apex/ApexValueEvaluator.js";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {recognizeSchemaHelper} from "../src/core/apex/ApexSchemaHelperModel.js";
import {memberEffectModel} from "../src/core/apex/ApexMemberEffectModel.js";
import {ApexMetadataCapture,ApexMetadataReplay} from "../src/core/metadata/ApexMetadataSnapshot.js";
import type {ApexMetadataProvider,ApexSchemaField} from "../src/core/metadata/ApexMetadataProvider.js";
function evidence(files:Array<{filePath:string;source:string}>,resolve?: (name:string,args:ApexValue[])=>ApexValue|undefined){
  const root=files[0],site=discoverApexInvocations(root.source,dynamicDatabaseQuerySelector)[0];
  return backtrackSoqlPermissionShapes(root.source,root.filePath,site,new ApexRepositoryMethodIndex(files),resolve);
}
const fields=(queries:string[])=>new Set(queries.flatMap(q=>extractSoqlExpressionFields(q).fields.map(f=>f.context+":"+f.fieldPath)));
test("backtrack through two caller levels to an escaped runtime predicate and conditional filters",()=>{
  const files=[
    {filePath:"QueryService.cls",source:"public class QueryService { public static void run(String predicate){String q='SELECT Id FROM Account WHERE '+predicate;Database.query(q);} }"},
    {filePath:"Bridge.cls",source:"public class Bridge { public static void forward(String predicate){QueryService.run(predicate);} }"},
    {filePath:"Entry.cls",source:"public class Entry { public static void load(String term,Boolean flag){String p='Name LIKE \\'%'+String.escapeSingleQuotes(term)+'%\\'';if(flag){p+=' AND Industry != null';}else{p+=' AND AnnualRevenue > 0';}Bridge.forward(p);} }"}
  ];
  const result=evidence(files);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Name","WHERE:Industry","WHERE:AnnualRevenue"]),JSON.stringify(result));
  assert.ok(result.callerEdges>=2);
  const scan=extractDynamicSoqlQueries(files[0].source,files[0].filePath,undefined,new ApexRepositoryMethodIndex(files));
  assert.ok(scan.queries.some(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE"&&q.query.includes("AnnualRevenue")),JSON.stringify(scan));
  assert.equal(scan.unresolved.length,1);
});
test("backtrack List/Set through caller variables, a finite loop and both conditional additions",()=>{
  const files=[
    {filePath:"QueryService.cls",source:"public class QueryService { public static void run(List<String> fields){String q='SELECT '+String.join(fields,',')+' FROM Account';Database.query(q);} }"},
    {filePath:"Entry.cls",source:"public class Entry { public static void load(Boolean flag){Set<String> cols=new Set<String>{'Id'};for(String f:new List<String>{'Name','Phone'}){cols.add(f);}if(flag){cols.add('Industry');}else{cols.add('AnnualRevenue');}QueryService.run(new List<String>(cols));} }"}
  ];
  const result=evidence(files);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone","SELECT:Industry","SELECT:AnnualRevenue"]),JSON.stringify(result));
});
test("correlated explicit callers keep object and field list together",()=>{
  const files=[
    {filePath:"Service.cls",source:"public class Service {public static void run(String obj,List<String> cols){String q='SELECT '+String.join(cols,',')+' FROM '+obj;Database.query(q);}}"},
    {filePath:"Entry.cls",source:"public class Entry {public static void load(Boolean flag){List<String> a=new List<String>{'Name'};if(flag){a.add('Industry');}Service.run('Account',a);List<String> c=new List<String>{'Email'};if(flag){c.add('Title');}Service.run('Contact',c);}}"}
  ];
  const result=evidence(files);
  const account=result.queries.find(q=>q.includes("FROM Account"))!,contact=result.queries.find(q=>q.includes("FROM Contact"))!;
  assert.ok(account&&contact,JSON.stringify(result));
  assert.doesNotMatch(account,/Email|Title/);
  assert.doesNotMatch(contact,/Name|Industry/);
});
test("unknown UI, arbitrary unescaped text, mutation and cycles remain unresolved",()=>{
  for(const source of [
    "public class UI {public static void run(String fields){String q='SELECT '+fields+' FROM Account';Database.query(q);}}",
    "public class UI {public static void run(String obj){String q='SELECT Id FROM '+obj;Database.query(q);}}",
    "public class UI {public static void run(String value){String q='SELECT Id FROM Account WHERE Name = \\''+value+'\\'';Database.query(q);}}",
    "public class UI {public static void run(String value){String q='SELECT '+String.escapeSingleQuotes(value)+' FROM Account';Database.query(q);}}",
    "public class UI {public static void run(List<String> input){List<String> f=new List<String>{'Id'};for(String item:input){f.add(item);}String q='SELECT '+String.join(f,',')+' FROM Account';Database.query(q);}}",
    "public class UI {public static void run(){List<String> f=new List<String>{'Id'};Other.mutate(f);String q='SELECT '+String.join(f,',')+' FROM Account';Database.query(q);}}"
  ])assert.deepEqual(evidence([{filePath:"UI.cls",source}]).queries,[],source);
});
test("metadata getInstance candidates preserve correlated object and field pairs",()=>{
  const source="public class Reports {public static void run(String reportName){Config__mdt cfg=Config__mdt.getInstance(reportName);String q='SELECT '+cfg.Column__c+' FROM '+cfg.Object__c;Database.query(q);}}";
  const result=evidence([{filePath:"Reports.cls",source}],(name,args)=>{
    if(name!=="Apex.metadataRows")return undefined;
    assert.match((args[0] as {values:string[]}).values[0],/FROM Config__mdt/);
    return {kind:"records",items:[
      [["DeveloperName",textValue("A")],["Column__c",textValue("Industry")],["Object__c",textValue("Account")]],
      [["DeveloperName",textValue("B")],["Column__c",textValue("Email")],["Object__c",textValue("Contact")]]
    ]};
  });
  assert.deepEqual(new Set(result.queries),new Set(["SELECT Industry FROM Account","SELECT Email FROM Contact"]),JSON.stringify(result));
  assert.equal(result.metadataRows,2);
});

test("local escaped runtime predicates and later unconditional String assignment",()=>{
  const source="public class UI {public static void run(String term,Boolean f){String q;q='SELECT Id FROM Account';if(f){q+=' WHERE Name LIKE \\'%'+String.escapeSingleQuotes(term)+'%\\'';}else{q+=' WHERE Industry != null';}Database.query(q);}}";
  assert.deepEqual(fields(evidence([{filePath:"UI.cls",source}]).queries),new Set(["SELECT:Id","WHERE:Name","WHERE:Industry"]));
});
test("label-backed conditional String field fragments propagate across callers",()=>{
  const files=[
    {filePath:"Service.cls",source:"public class Service {public static void run(String cols){Database.query('SELECT '+cols+' FROM Account');}}"},
    {filePath:"Entry.cls",source:"public class Entry {public static void run(Boolean f){List<String> input=Label.Columns.split(',');String cols='Id';for(String c:input){System.debug(c);}if(f){cols+=',Name';}else{cols+=',Industry';}Service.run(cols);}}"}
  ];
  const result=evidence(files,(name,args)=>name==="System.Label"?textValue("Id,Name"):undefined);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Industry"]),JSON.stringify(result));
});
test("metadata fields can flow through a collection without treating member reads as alias mutation",()=>{
  const source="public class Reports {public static void run(String key){Config__mdt cfg=Config__mdt.getInstance(key);List<String> fields=new List<String>();fields.add(cfg.Vertical__c);fields.add(cfg.Horizontal__c);String q='SELECT '+String.join(fields,',')+' FROM '+cfg.Object__c;Database.query(q);}}";
  const result=evidence([{filePath:"Reports.cls",source}],(name,args)=>name==="Apex.metadataRows"?{kind:"records",items:[
    [["DeveloperName",textValue("A")],["Vertical__c",textValue("Name")],["Horizontal__c",textValue("Industry")],["Object__c",textValue("Account")]],
    [["DeveloperName",textValue("B")],["Vertical__c",textValue("Email")],["Horizontal__c",textValue("Title")],["Object__c",textValue("Contact")]]
  ]}:undefined);
  assert.deepEqual(new Set(result.queries),new Set(["SELECT Name,Industry FROM Account","SELECT Email,Title FROM Contact"]),JSON.stringify(result));
});
test("literal switch helper preserves all object-specific query returns",()=>{
  const source="public class Cleanup {public static void run(Integer step){String q=build(step);Database.getQueryLocator(q);}private static String build(Integer step){switch on step {when 1 {return 'SELECT Name FROM Account';} when 2 {return 'SELECT Email FROM Contact';} when else {return null;}}}}";
  const scan=extractDynamicSoqlQueries(source,"Cleanup.cls");
  assert.deepEqual(new Set(scan.queries.map(q=>q.object)),new Set(["Account","Contact"]),JSON.stringify(scan));
  assert.equal(scan.queries.filter(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE").length,2);
  assert.equal(scan.unresolved.length,1);
  const unknown=source.replace("return null;","return Other.load();");
  assert.equal(extractDynamicSoqlQueries(unknown,"Cleanup.cls").queries.length,0);
});


const runtimeFieldsFixture="public class UI {private static final List<String> BASE_FIELDS=new List<String>{'Id','Name','NotAField__c'}; @AuraEnabled public static void run(List<Id> recordIds,List<String> additionalFields){if(recordIds==null||recordIds.isEmpty()){return;}Map<String,Schema.SObjectField> fieldMap=Account.SObjectType.getDescribe().fields.getMap();Set<String> requested=new Set<String>(BASE_FIELDS);if(additionalFields!=null){for(String f:additionalFields){if(String.isNotBlank(f)){requested.add(f.trim());}}}List<String> safeFields=new List<String>();for(String f:requested){if(fieldMap.containsKey(f.toLowerCase())){safeFields.add(f);}}String q='SELECT '+String.join(safeFields,', ')+' FROM Account WHERE Id IN :recordIds';Database.query(q);}}";
const describeAccount=(name:string,args:ApexValue[]):ApexValue|undefined=>name==="Schema.describeFields"&&args[0]?.kind==="text"&&args[0].values[0]==="Account"?{kind:"collection",items:["Id","Name","Industry","Phone"],unique:true}:undefined;
test("known fields survive additive runtime input and schema filtering, with only known fields assessed",()=>{
  const files=[{filePath:"UI.cls",source:runtimeFieldsFixture}];
  const result=evidence(files,describeAccount);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","WHERE:Id"]),JSON.stringify(result));
  assert.deepEqual(result.runtimeFieldQueries,result.queries);
  const scan=extractDynamicSoqlQueries(files[0].source,files[0].filePath,describeAccount,new ApexRepositoryMethodIndex(files),true);
  assert.ok(scan.queries.some(q=>q.runtimeFieldCoverage&&q.coverage==="PROVEN_PARTIAL_STRUCTURE"),JSON.stringify(scan));
  assert.equal(scan.unresolved.length,1);
  assert.equal(scan.unresolved[0].runtimeFieldCoverage,true);
});
test("runtime additions require an authoritative same-object schema guard and add-only loop",()=>{
  for(const source of [
    runtimeFieldsFixture.replace("if(fieldMap.containsKey(f.toLowerCase())){safeFields.add(f);}","safeFields.add(f);"),
    runtimeFieldsFixture.replace("requested.add(f.trim());","requested.clear();requested.add(f.trim());"),
    runtimeFieldsFixture.replace("safeFields.add(f);","safeFields.add(f+'x');"),
    runtimeFieldsFixture.replace(" FROM Account WHERE"," FROM Contact WHERE"),
    runtimeFieldsFixture.replace("String q='SELECT '+String.join(safeFields,', ')+' FROM Account WHERE Id IN :recordIds'","String q='SELECT Id FROM Account WHERE '+String.join(safeFields,', ')"),
    runtimeFieldsFixture.replace("requested.add(f.trim());","Other.mutate(requested);requested.add(f.trim());")
  ])assert.equal(evidence([{filePath:"UI.cls",source}],describeAccount).runtimeFieldQueries,undefined,source);
  assert.deepEqual(evidence([{filePath:"UI.cls",source:runtimeFieldsFixture}]).queries,[]);
});


test("backward Field Set helper reuses scan-scoped metadata resolution",async()=>{
  const source="public class Report {public static void run(){String obj='Account';String fs='ReportFields';List<String> paths=Utils.getFieldListFromFieldSet(obj,fs);Set<String> cols=new Set<String>{'Id'};for(String f:paths){cols.add(f);}Database.query('SELECT '+String.join(cols,', ')+' FROM Account WITH USER_MODE');}}";
  const filePath="Report.cls",index=new ApexRepositoryMethodIndex([{source,filePath}]);
  let reads=0;
  const metadata={
    scopeKey:"test-backward-fieldset",
    getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getFieldSetFields:async(object:string,name:string)=>{
      reads++;assert.equal(object,"Account");assert.equal(name,"ReportFields");
      return {complete:true as const,source:"LIVE_ORG" as const,value:["Name","Industry"]};
    },
  };
  const engine=new ApexAnalysisEngine(index,metadata);
  const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0];
  const resolve=()=>engine.analyze(filePath,context=>backtrackSoqlPermissionShapes(source,filePath,site,index,context.resolveExternal));
  const result=await resolve();
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Industry"]),JSON.stringify(result));
  assert.equal(reads,1);
  await resolve();assert.equal(reads,1);
});
test("runtime-selected metadata helper stays unresolved when bounded filtered candidate metadata is unavailable",async()=>{
  const source="public class Report {public static void run(String reportName){Report_Config__mdt cfg=getConfig(reportName);List<String> paths=Utils.getFieldListFromFieldSet(cfg.Object_API_Name__c,cfg.Field_Set_Name__c);Database.query('SELECT '+String.join(paths,',')+' FROM '+cfg.Object_API_Name__c);}private static Report_Config__mdt getConfig(String developerName){if(String.isBlank(developerName)){return null;}List<Report_Config__mdt> cfgs=[SELECT DeveloperName,Object_API_Name__c,Field_Set_Name__c FROM Report_Config__mdt WHERE DeveloperName=:developerName AND Active__c=true LIMIT 1];return cfgs.isEmpty()?null:cfgs[0];}}";
  const filePath="Report.cls",index=new ApexRepositoryMethodIndex([{source,filePath}]);
  let reads=0,fieldSetReads=0;
  const metadata={
    scopeKey:"test-runtime-config",
    getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomMetadataRecords:async(type:string,selected:readonly string[],filters?:readonly {field:string;value:string|number|boolean}[])=>{
      reads++;assert.equal(type,"Report_Config__mdt");
      assert.ok(selected.includes("DeveloperName"));
      assert.deepEqual(filters,[{field:"Active__c",value:true}]);
      return {complete:false as const,source:"LIVE_ORG" as const};
    },
    getFieldSetFields:async()=>{fieldSetReads++;return {complete:false as const,source:"LIVE_ORG" as const};},
  };
  const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0];
  const events:string[]=[];
  const result=await new ApexAnalysisEngine(index,metadata).analyze(filePath,context=>
    backtrackSoqlPermissionShapes(source,filePath,site,index,context.resolveExternal,e=>events.push(e.code)));
  assert.deepEqual(result.queries,[]);
  assert.ok(events.includes("SHARED_HELPER_ARGUMENT_UNPROVEN"));
  assert.ok(events.includes("METADATA_SELECTOR_ROWS_UNAVAILABLE"));
  assert.equal(reads,1);
  assert.equal(fieldSetReads,0);
});


test("AUE helper effects supply the final SELECT fields to backward permission analysis",()=>{
  const source="public class Builder {public static void run(){Set<String> cols=new Set<String>{'Id','Industry'};List<String> paths=new List<String>{'Name','Phone'};for(String path:paths){String result=addColumn(cols,path);}removeUnused(cols);Database.query('SELECT '+String.join(cols,',')+' FROM Account WITH USER_MODE');}private static String addColumn(Set<String> cols,String path){cols.add(path);return path;}private static void removeUnused(Set<String> cols){cols.remove('Industry');}}";
  const result=evidence([{filePath:"Builder.cls",source}]);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone"]),JSON.stringify(result));
  assert.ok(result.queries.every(q=>q.includes("WITH USER_MODE")));
  const scan=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.deepEqual(fields(scan.queries.map(q=>q.query)),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone"]));
  const unsafe=source.replace("removeUnused(cols);","Other.mutate(cols);removeUnused(cols);");
  assert.deepEqual(evidence([{filePath:"Builder.cls",source:unsafe}]).queries,[]);
});
test("destructive helper effect is not replayed over unspecified Set iteration order",()=>{
  const source="public class Builder {public static void run(){Set<String> cols=new Set<String>{'Id'};Set<String> paths=new Set<String>{'Name','Phone'};for(String path:paths){replaceColumn(cols,path);}Database.query('SELECT '+String.join(cols,',')+' FROM Account');}private static void replaceColumn(Set<String> cols,String path){cols.clear();cols.add(path);}}";
  assert.deepEqual(evidence([{filePath:"Builder.cls",source}]).queries,[]);
});

test("complete Field Set lists pass a compound null/empty guard and feed downstream SOQL",async()=>{
  const source="public class Report {public static void run(){List<String> paths=Utils.getFieldListFromFieldSet('Account','ReportFields');if(paths==null||paths.isEmpty()){System.debug(paths);return;}Set<String> cols=new Set<String>{'Id'};for(String f:paths){cols.add(f);}Database.query('SELECT '+String.join(cols,',')+' FROM Account WITH USER_MODE');}}";
  const filePath="Report.cls",index=new ApexRepositoryMethodIndex([{source,filePath}]);
  const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0];
  for(const members of [["Name","Industry"],[],undefined]){
    const events:string[]=[];
    const metadata={
      scopeKey:"collection-guard-fixture",
      getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
      getFieldSetFields:async()=>members===undefined?{complete:false as const,source:"LIVE_ORG" as const}:
        {complete:true as const,source:"LIVE_ORG" as const,value:members}
    };
    const result=await new ApexAnalysisEngine(index,metadata).analyze(filePath,ctx=>
      backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push(e.code)));
    if(members?.length){
      assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Industry"]),JSON.stringify(result));
      assert.ok(events.includes("COLLECTION_GUARD_RESOLVED"));
      assert.ok(events.includes("LOOP_ITERABLE_RESOLVED"));
    }else{
      assert.deepEqual(result.queries,[]);
      if(members)assert.ok(events.includes("COLLECTION_GUARD_PATH_TERMINATES"));
    }
  }
});


test("backward replay uses nested local scalar helper results and identifies unproven helper source",()=>{
  const filePath="Builder.cls";
  const source="public class Builder {public static void run(){Set<String> cols=new Set<String>{'Id'};List<String> paths=new List<String>{' Name ',' Phone '};for(String path:paths){String result=addColumn('Account',path,cols);}Database.query('SELECT '+String.join(cols,',')+' FROM Account WITH USER_MODE');}private static String addColumn(String objectName,String path,Set<String> cols){String name=normalize(path);cols.add(name);return name;}private static String normalize(String path){return path.trim();}}";
  const analyze=(source:string)=>{
    const index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0],events:string[]=[];
    const result=backtrackSoqlPermissionShapes(source,filePath,site,index,undefined,e=>events.push(e.code));
    return {result,events};
  };
  const good=analyze(source);
  assert.deepEqual(fields(good.result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone"]),JSON.stringify(good.result));
  assert.ok(good.events.includes("SHARED_HELPER_EFFECT_RESOLVED"));
  const bad=analyze(source.replace("normalize(path);cols.add","Other.normalize(path);cols.add"));
  assert.deepEqual(bad.result.queries,[]);
  assert.ok(bad.events.includes("HELPER_EFFECT_SOURCE_UNSUPPORTED"));
  assert.ok(bad.events.includes("SHARED_HELPER_EFFECT_UNPROVEN"));
});


test("backward helper replay admits scalar-field DTO returns but rejects collection-bearing returns",()=>{
  const filePath="Builder.cls";
  const source="public class Builder {public class Column {public String name;public Boolean editable;public Column(String name){this.name=name;this.editable=false;}}public static void run(){Set<String> cols=new Set<String>{'Id'};List<String> paths=new List<String>{'Name','Phone'};for(String path:paths){Column result=addColumn('Account',path,cols);}Database.query('SELECT '+String.join(cols,',')+' FROM Account WITH USER_MODE');}private static Column addColumn(String objectName,String path,Set<String> cols){cols.add(path);Column col=new Column(path);return col;}}";
  const analyze=(source:string)=>{
    const index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0],events:string[]=[];
    const result=backtrackSoqlPermissionShapes(source,filePath,site,index,undefined,e=>events.push(e.code));
    return {result,events};
  };
  const safe=analyze(source);
  assert.deepEqual(fields(safe.result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone"]),JSON.stringify(safe.result));
  assert.ok(safe.events.includes("SHARED_HELPER_EFFECT_RESOLVED"));
  const unsafe=analyze(source.replace("public Boolean editable;","public Boolean editable;public Set<String> selected;"));
  assert.deepEqual(unsafe.result.queries,[]);
  assert.ok(unsafe.events.includes("HELPER_EFFECT_RETURN_ALIAS_UNPROVEN"));
});


test("active loop helper replay reads unchanged outer scalar locals and keeps iteration bindings",()=>{
  const filePath="Builder.cls";
  const source="public class Builder {public static void run(){String obj='Account';Set<String> cols=new Set<String>{'Id'};List<String> paths=new List<String>{'Name','Phone'};for(String path:paths){String result=append(obj,path,cols);}Database.query('SELECT '+String.join(cols,',')+' FROM Account WITH USER_MODE');}private static String append(String obj,String path,Set<String> cols){if(obj=='Account'){cols.add(path);}return path;}}";
  const analyze=(source:string)=>{
    const index=new ApexRepositoryMethodIndex([{filePath,source}]);
    const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0],events:string[]=[];
    const result=backtrackSoqlPermissionShapes(source,filePath,site,index,undefined,e=>events.push(e.code));
    return {result,events};
  };
  const good=analyze(source);
  assert.deepEqual(fields(good.result.queries),new Set(["SELECT:Id","SELECT:Name","SELECT:Phone"]),JSON.stringify(good.result));
  assert.ok(good.events.includes("LOOP_OUTER_SCALAR_READ_PROVEN"));
  assert.ok(good.events.includes("SHARED_HELPER_EFFECT_RESOLVED"));
  for(const changed of [
    source.replace("append(obj,path,cols);","append(obj,path,cols);obj='Contact';"),
    source.replace("append(obj,path,cols);","append(obj,path,cols);obj+='Other';"),
    source.replace("String result=append","if(path=='Name'){obj='Contact';}String result=append"),
    source.replace("String result=append","String spare, obj;String result=append")
  ]){
    const bad=analyze(changed);
    assert.deepEqual(bad.result.queries,[],changed);
    assert.ok(!bad.events.includes("LOOP_OUTER_SCALAR_READ_PROVEN"),changed);
  }
});
test("outer scalar loop reads retain correlated metadata and Field Set candidates",async()=>{
  const filePath="Report.cls";
  const source="public class Report {public static void run(String reportName){Config__mdt cfg=Config__mdt.getInstance(reportName);String obj=cfg.Object__c;List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}Set<String> cols=new Set<String>{'Id'};for(String path:paths){String result=append(obj,path,cols);}Database.query('SELECT '+String.join(cols,',')+' FROM '+obj+' WITH USER_MODE');}private static String append(String obj,String path,Set<String> cols){if(obj=='Account'||obj=='Contact'){cols.add(path);}return path;}}";
  const index=new ApexRepositoryMethodIndex([{filePath,source}]);
  const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0],events:string[]=[];
  const metadata={
    scopeKey:"outer-scalar-loop-fixture",
    getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomMetadataRecords:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:[
      {DeveloperName:"A",Object__c:"Account",Field_Set__c:"AccountFields"},
      {DeveloperName:"B",Object__c:"Contact",Field_Set__c:"ContactFields"}
    ]}),
    getFieldSetFields:async(object:string,fieldSet:string)=>({complete:true as const,source:"LIVE_ORG" as const,value:
      object==="Account"&&fieldSet==="AccountFields"?["Industry"]:
      object==="Contact"&&fieldSet==="ContactFields"?["Email"]:[]})
  };
  const result=await new ApexAnalysisEngine(index,metadata).analyze(filePath,ctx=>
    backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push(e.code)));
  const account=result.queries.filter(q=>q.includes("FROM Account")),contact=result.queries.filter(q=>q.includes("FROM Contact"));
  assert.deepEqual(fields(account),new Set(["SELECT:Id","SELECT:Industry"]),JSON.stringify({result,events}));
  assert.deepEqual(fields(contact),new Set(["SELECT:Id","SELECT:Email"]),JSON.stringify({result,events}));
  assert.ok(events.includes("LOOP_OUTER_SCALAR_READ_PROVEN"));
  assert.equal(result.bounded,false);
});


test("metadata-driven helper effects recover real SELECT field identities through Describe and FORMAT",async()=>{
  const filePath="ReportFixture.cls";
  const source=[
    "public class ReportFixture {",
    " public class Column {public String name;public String label;public String type;}",
    " public static void run(String reportName){",
    "  Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}",
    "  String obj=cfg.Object__c;if(Schema.getGlobalDescribe().get(obj)==null){return;}",
    "  List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}",
    "  Set<String> selected=new Set<String>{'Id'};for(String path:paths){Column col=append(obj,path,selected);}",
    "  String base='SELECT '+String.join(new List<String>(selected),',')+' FROM '+obj;",
    "  Database.query(base+' WITH USER_MODE ORDER BY Id ASC');",
    "  Database.query(base+' WITH USER_MODE ORDER BY Id DESC');",
    " }",
    " private static Config__mdt getConfig(String name){List<Config__mdt> rows=[SELECT DeveloperName,Object__c,Field_Set__c FROM Config__mdt WHERE DeveloperName=:name AND Active__c=true LIMIT 1];return rows.isEmpty()?null:rows[0];}",
    " private static Column append(String objectName,String path,Set<String> selected){",
    "  Schema.DescribeSObjectResult objectDescribe=Schema.getGlobalDescribe().get(objectName).getDescribe();",
    "  Map<String,Schema.SObjectField> fmap=objectDescribe.fields.getMap();",
    "  Column col=new Column();col.name=path;",
    "  if(fmap.containsKey(path)){",
    "   Schema.DescribeFieldResult d=fmap.get(path).getDescribe();",
    "   col.label=d.getLabel();col.type=d.getType().name();",
    "   if(d.getType()==Schema.DisplayType.DATETIME){selected.add('FORMAT('+path+')');}",
    "   else{selected.add(path);}",
    "   if(d.getType()==Schema.DisplayType.REFERENCE){List<Schema.SObjectType> targets=d.getReferenceTo();Schema.SObjectType target=targets[0];String related=target.getDescribe().getName();if(related=='Account'){String rel=d.getRelationshipName();selected.add(rel+'.Name');}}",
    "  }",
    "  return col;",
    " }",
    "}"
  ].join("\n");
  const configs=[{object:"Account",fields:["CreatedDate","Industry","Name","Phone","ParentId"]},{object:"Contact",fields:["CreatedDate","Email","FirstName","LastName","Phone","Title","AccountId"]},{object:"Case",fields:["CreatedDate","Subject","Status","Priority","Origin","Type","Reason","Description","CaseNumber","SuppliedEmail","SuppliedName","AccountId"]}];
  const metadata={
    scopeKey:"schema-effect-recovery-fixture",
    getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getObjectSchema:async(object:string)=>({complete:true as const,source:"LIVE_ORG" as const,value:{name:object,fields:[
      {name:"Id",type:"id"},
      ...(configs.find(c=>c.object===object)?.fields??[]).map(name=>({name,type:name==="CreatedDate"?"datetime":name.endsWith("Id")?"reference":"string",...(name.endsWith("Id")?{referenceTo:["Account"],relationshipName:name.slice(0,-2)}:{})}))
    ]}}),
    getCustomMetadataRecords:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:configs.map(c=>({DeveloperName:c.object,Object__c:c.object,Field_Set__c:c.object+"Fields",Active__c:true}))}),
    getFieldSetFields:async(object:string)=>({complete:true as const,source:"LIVE_ORG" as const,value:configs.find(c=>c.object===object)?.fields??[]})
  };
  const index=new ApexRepositoryMethodIndex([{filePath,source}]),engine=new ApexAnalysisEngine(index,metadata);
  for(const site of discoverApexInvocations(source,dynamicDatabaseQuerySelector)){
    const events:string[]=[];
    const result=await engine.analyze(filePath,ctx=>backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push(e.code)));
    assert.equal(result.queries.length,3,JSON.stringify({result,events}));
    assert.ok(events.includes("SHARED_HELPER_EFFECT_RESOLVED"));
    assert.equal(result.bounded,false);
    for(const config of configs){
      const actual=result.queries.filter(q=>q.includes(" FROM "+config.object+" "));
      const rel=config.object==="Account"?"Parent.Name":"Account.Name";
      assert.deepEqual(fields(actual),new Set(["SELECT:Id",...config.fields.map(f=>"SELECT:"+f),"SELECT:"+rel,"ORDER_BY:Id"]),JSON.stringify({result,events}));
      assert.ok(actual[0].includes("FORMAT(CreatedDate)"));
    }
  }
});

test("Schema effect proof does not mask arbitrary application calls or unresolved mutation",()=>{
  const filePath="Builder.cls";
  const source="public class Builder {public static void run(){Set<String> cols=new Set<String>{'Id'};append('Account',cols);Database.query('SELECT '+String.join(cols,',')+' FROM Account');}private static void append(String obj,Set<String> cols){Schema.DescribeSObjectResult d=Schema.getGlobalDescribe().get(Other.name(obj)).getDescribe();cols.add(d.getName());}}";
  const events:string[]=[],index=new ApexRepositoryMethodIndex([{filePath,source}]),site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0];
  const result=backtrackSoqlPermissionShapes(source,filePath,site,index,undefined,e=>events.push(e.code));
  assert.deepEqual(result.queries,[]);
  assert.ok(events.includes("HELPER_EFFECT_SOURCE_UNSUPPORTED"));
});


// Source-representative fixture with actual nested helper control shapes.
test("nested Describe path helpers recover direct, formatted and relationship SELECT fields",async()=>{
  const filePath="ColumnBuilder.cls";
  const source="public class ColumnBuilder {\n public class Column {\n   public String apiPath;public String fieldName;public String label;public String type;\n   public Boolean navigable;public String displayPath;public String idPath;\n   public Column(){this.navigable=false;}\n }\n public static void run(String reportName){\n   Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}\n   String obj=cfg.Object__c;if(Schema.getGlobalDescribe().get(obj)==null){return;}\n   List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}\n   Set<String> selected=new Set<String>{'Id'};\n   for(String path:paths){Column col=make(obj,path,selected);}\n   String q='SELECT '+String.join(new List<String>(selected),', ')+' FROM '+obj;\n   Database.queryWithBinds(q+' ORDER BY Id ASC',new Map<String,Object>(),AccessLevel.USER_MODE);\n   Database.queryWithBinds(q+' ORDER BY Id DESC',new Map<String,Object>(),AccessLevel.USER_MODE);\n }\n private static Config__mdt getConfig(String name){\n   if(String.isBlank(name)){return null;}\n   List<Config__mdt> rows=[SELECT DeveloperName,Object__c,Field_Set__c FROM Config__mdt WHERE DeveloperName=:name AND Active__c=true LIMIT 1];\n   return rows.isEmpty()?null:rows[0];\n }\n private static Column make(String objectName,String path,Set<String> selected){\n   Column col=new Column();col.apiPath=path;col.fieldName=path.replace('.', '_');selected.add(path);\n   Schema.DescribeFieldResult d=fieldDescribe(objectName,path);\n   col.label=d!=null?d.getLabel():path;col.type=d!=null?typeHint(d.getType()):'text';\n   Schema.DisplayType fieldType=d!=null?d.getType():null;\n   if(fieldType==Schema.DisplayType.DATETIME||fieldType==Schema.DisplayType.DATE||fieldType==Schema.DisplayType.TIME){\n     selected.remove(path);selected.add('FORMAT('+path+')');\n   }\n   if(d!=null&&d.getType()==Schema.DisplayType.REFERENCE){\n     col.navigable=true;col.idPath=path;String rel=d.getRelationshipName();\n     if(String.isNotBlank(rel)&&!d.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult rd=d.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(rd);\n       if(nf!=null){col.displayPath=rel+'.'+nf;col.type='reference';selected.add(col.displayPath);}\n     }\n   }else if(path.contains('.')){\n     String prefix=path.substringBeforeLast('.');String leaf=path.substringAfterLast('.');\n     Schema.DescribeFieldResult ld=relationshipDescribe(objectName,prefix);\n     if(ld!=null&&!ld.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult td=ld.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(td);\n       if(nf!=null&&leaf.equalsIgnoreCase(nf)){col.navigable=true;col.idPath=prefix+'.Id';selected.add(col.idPath);}\n     }\n   }else if(d!=null&&d.isNameField()){col.navigable=true;col.idPath='Id';}\n   return col;\n }\n private static String nameApi(Schema.DescribeSObjectResult obj){\n   for(Schema.SObjectField sf:obj.fields.getMap().values()){\n     Schema.DescribeFieldResult d=sf.getDescribe();if(d.isNameField()){return d.getName();}\n   }return null;\n }\n private static Schema.DescribeFieldResult relationshipDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');Schema.DescribeFieldResult result;\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];Schema.DescribeFieldResult match=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();if(segment.equalsIgnoreCase(d.getRelationshipName())){match=d;break;}\n     }\n     if(match==null){return null;}result=match;\n     if(i<parts.size()-1){if(match.getReferenceTo().isEmpty()){return null;}cur=match.getReferenceTo()[0];}\n   }return result;\n }\n private static Schema.DescribeFieldResult fieldDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];\n     if(i==parts.size()-1){Schema.SObjectField f=fields.get(segment.toLowerCase());return f==null?null:f.getDescribe();}\n     Schema.SObjectType next=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();\n       if(segment.equalsIgnoreCase(d.getRelationshipName())){if(!d.getReferenceTo().isEmpty()){next=d.getReferenceTo()[0];}break;}\n     }\n     if(next==null){return null;}cur=next;\n   }return null;\n }\n private static String typeHint(Schema.DisplayType dt){\n   switch on dt {when CURRENCY {return 'currency';}when DATE,DATETIME,TIME {return 'date';}when REFERENCE {return 'reference';}when else {return 'text';}}\n }\n}";

  const rows=[{DeveloperName:"A",Object__c:"Account",Field_Set__c:"AFields",Active__c:true},{DeveloperName:"B",Object__c:"Contact",Field_Set__c:"BFields",Active__c:true}];
  const fieldsFor=(obj:string)=>obj==="Account"?["Id","Name","CreatedDate","ParentId","Parent.Name"]:["Id","LastName","CreatedDate","AccountId","Account.Name"];
  const snapshot=(object:string)=>({name:object,fields:fieldsFor(object).filter(f=>!f.includes(".")).map(name=>({
    name,type:name==="CreatedDate"?"datetime":name==="Id"?"id":name.endsWith("Id")?"reference":"string",
    nameField:name==="Name"||name==="LastName",relationshipName:name!=="Id"&&name.endsWith("Id")?name.slice(0,-2):null,
    referenceTo:name!=="Id"&&name.endsWith("Id")?["Account"]:[]
  }))});
  const metadata={scopeKey:"source-shape",getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getObjectSchema:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:snapshot(object)}),
    getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG" as const,value:rows}),
    getFieldSetFields:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:fieldsFor(object).slice(1)})};
  const index=new ApexRepositoryMethodIndex([{filePath,source}]);
  const engine=new ApexAnalysisEngine(index,metadata);
  for(const site of discoverApexInvocations(source,dynamicDatabaseQuerySelector)){
    const events:Array<{code:string;line:number}>=[];
    const result=await engine.analyze(filePath,ctx=>backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push({code:e.code,line:e.line})));
    assert.equal(result.queries.length,2,JSON.stringify({result,events}));
    assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:Id","SELECT:Name","SELECT:CreatedDate","SELECT:ParentId","SELECT:Parent.Name","SELECT:Parent.Id","ORDER_BY:Id"]));
    assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Id","SELECT:LastName","SELECT:CreatedDate","SELECT:AccountId","SELECT:Account.Name","SELECT:Account.Id","ORDER_BY:Id"]));
    assert.ok(result.queries.every(q=>q.includes("FORMAT(CreatedDate)")));
    assert.equal(result.bounded,false);
  }
});


// Includes the actual post-helper control shapes, while leaving runtime filter input unknown.
test("source-backed report pipeline retains independently proven SELECT fields with unresolved WHERE",async()=>{
 const filePath="ColumnBuilder.cls";
 const source="public class ColumnBuilder {\n public class Column {\n   public String apiPath;public String fieldName;public String label;public String type;\n   public Boolean navigable;public String displayPath;public String idPath;\n   public Column(){this.navigable=false;}\n }\n public static void run(String reportName,String filtersJson){\n   Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}\n   String obj=cfg.Object__c;if(Schema.getGlobalDescribe().get(obj)==null){return;}\n   List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}\n   Set<String> selected=new Set<String>{'Id'};\n   for(String path:paths){Column col=make(obj,path,selected);}\n   if(String.isNotBlank(cfg.Vertical__c)){selected.add(cfg.Vertical__c);}\n   List<String> groups=parseList(cfg.Groups__c,5);\n   for(Integer gi=0;gi<groups.size();gi++){\n     String gf=groups[gi];selected.add(gf);\n     Schema.DescribeFieldResult gd=fieldDescribe(obj,gf);\n     Column group=new Column();group.fieldName='group'+gi;group.label=gd!=null?gd.getLabel():gf;\n   }\n   Map<String,Object> binds=new Map<String,Object>();\n   List<String> clauses=new List<String>();\n   Set<String> allowed=new Set<String>();\n   for(String f:parseList(cfg.Filters__c,5)){allowed.add(f);}\n   applyFilters(obj,allowed,filtersJson,clauses,binds);\n   String filterWhere=clauses.isEmpty()?'':String.join(clauses,' AND ');\n   String orderBy='Id ASC';\n   if(String.isNotBlank(cfg.Sort__c)){orderBy=cfg.Sort__c.trim()+', Id ASC';}\n   String q='SELECT '+String.join(new List<String>(selected),', ')+' FROM '+String.escapeSingleQuotes(obj)+(String.isNotBlank(filterWhere)?(' WHERE '+filterWhere):'');\n   Database.queryWithBinds(q+' ORDER BY '+orderBy+' LIMIT :pageLimit OFFSET :pageOffset',binds,AccessLevel.USER_MODE);\n   Database.queryWithBinds(q+' ORDER BY '+reverse(orderBy)+' LIMIT :pageLimit OFFSET :pageOffset',binds,AccessLevel.USER_MODE);\n }\n private static Config__mdt getConfig(String name){\n   if(String.isBlank(name)){return null;}\n   List<Config__mdt> rows=[SELECT DeveloperName,Object__c,Field_Set__c,Vertical__c,Groups__c,Filters__c,Sort__c FROM Config__mdt WHERE DeveloperName=:name AND Active__c=true LIMIT 1];\n   return rows.isEmpty()?null:rows[0];\n }\n private static List<String> parseList(String raw,Integer maxItems){\n   List<String> out=new List<String>();\n   if(String.isBlank(raw)){return out;}\n   for(String part:raw.split(';')){String trimmed=part.trim();if(String.isNotBlank(trimmed)&&out.size()<maxItems){out.add(trimmed);}}\n   return out;\n }\n private static String reverse(String orderBy){\n   List<String> reversed=new List<String>();\n   for(String term:orderBy.split(',')){\n     List<String> p=term.trim().split('\\\\s+');String fld=p[0];\n     String dir=(p.size()>1&&p[1].equalsIgnoreCase('DESC'))?'ASC':'DESC';\n     reversed.add(fld+' '+dir);\n   }return String.join(reversed,', ');\n }\n private static void applyFilters(String obj,Set<String> allowed,String filtersJson,List<String> clauses,Map<String,Object> binds){\n   if(String.isBlank(filtersJson)){return;}\n   // Runtime values are not synthesized by this SELECT-only proof.\n   clauses.add(filtersJson);\n }\n private static Column make(String objectName,String path,Set<String> selected){\n   Column col=new Column();col.apiPath=path;col.fieldName=path.replace('.', '_');selected.add(path);\n   Schema.DescribeFieldResult d=fieldDescribe(objectName,path);\n   col.label=d!=null?d.getLabel():path;col.type=d!=null?typeHint(d.getType()):'text';\n   Schema.DisplayType fieldType=d!=null?d.getType():null;\n   if(fieldType==Schema.DisplayType.DATETIME||fieldType==Schema.DisplayType.DATE||fieldType==Schema.DisplayType.TIME){\n     selected.remove(path);selected.add('FORMAT('+path+')');\n   }\n   if(d!=null&&d.getType()==Schema.DisplayType.REFERENCE){\n     col.navigable=true;col.idPath=path;String rel=d.getRelationshipName();\n     if(String.isNotBlank(rel)&&!d.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult rd=d.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(rd);\n       if(nf!=null){col.displayPath=rel+'.'+nf;col.type='reference';selected.add(col.displayPath);}\n     }\n   }else if(path.contains('.')){\n     String prefix=path.substringBeforeLast('.');String leaf=path.substringAfterLast('.');\n     Schema.DescribeFieldResult ld=relationshipDescribe(objectName,prefix);\n     if(ld!=null&&!ld.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult td=ld.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(td);\n       if(nf!=null&&leaf.equalsIgnoreCase(nf)){col.navigable=true;col.idPath=prefix+'.Id';selected.add(col.idPath);}\n     }\n   }else if(d!=null&&d.isNameField()){col.navigable=true;col.idPath='Id';}\n   return col;\n }\n private static String nameApi(Schema.DescribeSObjectResult obj){\n   for(Schema.SObjectField sf:obj.fields.getMap().values()){\n     Schema.DescribeFieldResult d=sf.getDescribe();if(d.isNameField()){return d.getName();}\n   }return null;\n }\n private static Schema.DescribeFieldResult relationshipDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');Schema.DescribeFieldResult result;\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];Schema.DescribeFieldResult match=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();if(segment.equalsIgnoreCase(d.getRelationshipName())){match=d;break;}\n     }\n     if(match==null){return null;}result=match;\n     if(i<parts.size()-1){if(match.getReferenceTo().isEmpty()){return null;}cur=match.getReferenceTo()[0];}\n   }return result;\n }\n private static Schema.DescribeFieldResult fieldDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];\n     if(i==parts.size()-1){Schema.SObjectField f=fields.get(segment.toLowerCase());return f==null?null:f.getDescribe();}\n     Schema.SObjectType next=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();\n       if(segment.equalsIgnoreCase(d.getRelationshipName())){if(!d.getReferenceTo().isEmpty()){next=d.getReferenceTo()[0];}break;}\n     }\n     if(next==null){return null;}cur=next;\n   }return null;\n }\n private static String typeHint(Schema.DisplayType dt){\n   switch on dt {when CURRENCY {return 'currency';}when DATE,DATETIME,TIME {return 'date';}when REFERENCE {return 'reference';}when else {return 'text';}}\n }\n}";

 const rows=[
   {DeveloperName:"A",Object__c:"Account",Field_Set__c:"AFields",Vertical__c:"Industry",Groups__c:"Phone;Type",Filters__c:"Name",Sort__c:"Name DESC",Active__c:true},
   {DeveloperName:"B",Object__c:"Contact",Field_Set__c:"BFields",Vertical__c:"Email",Groups__c:"Title",Filters__c:"LastName",Sort__c:"LastName ASC",Active__c:true}
 ];
 const paths=(obj:string)=>obj==="Account"?["Name","CreatedDate","ParentId","Parent.Name"]:["LastName","CreatedDate","AccountId","Account.Name"];
 const snapshot=(object:string)=>({name:object,fields:[...new Set(["Id",...paths(object).filter(f=>!f.includes(".")),...(object==="Account"?["Industry","Phone","Type"]:["Email","Title"])])].map(name=>({
   name,type:name==="CreatedDate"?"datetime":name==="Id"?"id":name.endsWith("Id")?"reference":"string",
   nameField:name==="Name"||name==="LastName",relationshipName:name!=="Id"&&name.endsWith("Id")?name.slice(0,-2):null,
   referenceTo:name!=="Id"&&name.endsWith("Id")?["Account"]:[]
 }))});
 const metadata={scopeKey:"source-full-shape",getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
   getObjectSchema:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:snapshot(object)}),
   getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG" as const,value:rows}),
   getFieldSetFields:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:paths(object)})};
 const index=new ApexRepositoryMethodIndex([{filePath,source}]),engine=new ApexAnalysisEngine(index,metadata);
 for(const site of discoverApexInvocations(source,dynamicDatabaseQuerySelector)){
   const events:Array<{code:string;line:number}>=[];
   const result=await engine.analyze(filePath,ctx=>backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push({code:e.code,line:e.line})));
   assert.equal(result.partialSelectQueries?.length,2,JSON.stringify({result,events}));
   assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:Id","SELECT:Name","SELECT:CreatedDate","SELECT:ParentId","SELECT:Parent.Name","SELECT:Parent.Id","SELECT:Industry","SELECT:Phone","SELECT:Type","ORDER_BY:Name","ORDER_BY:Id"]));
   assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Id","SELECT:LastName","SELECT:CreatedDate","SELECT:AccountId","SELECT:Account.Name","SELECT:Account.Id","SELECT:Email","SELECT:Title","ORDER_BY:LastName","ORDER_BY:Id"]));
   assert.ok(events.some(e=>e.code==="INDEXED_LOOP_ITERABLE_RESOLVED"));
   assert.ok(events.some(e=>e.code==="EXACT_SCALAR_ASSIGNMENT_RESOLVED"));
   assert.equal(result.bounded,false);
 }
 const scan=await engine.analyze(filePath,ctx=>extractDynamicSoqlQueries(source,filePath,ctx.resolveExternal,index));
 assert.ok(scan.queries.some(q=>q.permissionEvidence==="AGGREGATED_STRUCTURE"&&q.coverage==="PROVEN_PARTIAL_STRUCTURE"&&q.selectPrefixOnly===true),JSON.stringify(scan));
 assert.ok(scan.unresolved.length>=2);
});
test("unknown optional WHERE cannot establish arbitrary FROM or implicit mode",()=>{
 for(const source of [
   "public class Q {public static void run(String w){String q='SELECT Id FROM Account'+(String.isNotBlank(w)?(' WHERE '+w):'')+' ORDER BY Id';Database.query(q);}}",
   "public class Q {public static void run(String w){String q='SELECT Id FROM Account'+(String.isNotBlank(w)?('X'+w):'')+' ORDER BY Id';Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}"
 ]){
   const result=evidence([{filePath:"Q.cls",source}]);
   assert.equal(result.partialSelectQueries,undefined);
 }
});


// Preserve the controller's real lexical reuse of fld in disjoint blocks.
const scopedDescribeFixture="public class ScopeFixture {\n private static Schema.DescribeFieldResult describeFieldPath(String objectApiName, String fieldPath) {\n   Schema.SObjectType currentType = Schema.getGlobalDescribe().get(objectApiName);\n   if (currentType == null) { return null; }\n   List<String> parts = fieldPath.split('\\\\.');\n   for (Integer i = 0; i < parts.size(); i++) {\n     Map<String, Schema.SObjectField> fieldMap = currentType.getDescribe().fields.getMap();\n     String segment = parts[i];\n     if (i == parts.size() - 1) {\n       Schema.SObjectField fld = fieldMap.get(segment.toLowerCase());\n       return fld == null ? null : fld.getDescribe();\n     }\n     Schema.SObjectType nextType = null;\n     for (Schema.SObjectField fld : fieldMap.values()) {\n       Schema.DescribeFieldResult fd = fld.getDescribe();\n       if (segment.equalsIgnoreCase(fd.getRelationshipName())) {\n         if (!fd.getReferenceTo().isEmpty()) { nextType = fd.getReferenceTo()[0]; }\n         break;\n       }\n     }\n     if (nextType == null) { return null; }\n     currentType = nextType;\n   }\n   return null;\n }\n}";

function recognizedDescribe(source:string){
  const method=indexApexMethods(source).find(m=>m.name==="describeFieldPath");
  assert.ok(method,"fixture method must be indexed");
  return recognizeSchemaHelper(source,method)?.kind;
}
test("Schema helper recognition admits case-insensitive name reuse in separate lexical blocks",()=>{
  assert.equal(recognizedDescribe(scopedDescribeFixture),"fieldPath");
  const distinct=scopedDescribeFixture.replace("Schema.SObjectField fld =","Schema.SObjectField leaf =").replace("return fld == null ? null : fld.getDescribe();","return leaf == null ? null : leaf.getDescribe();");
  assert.equal(recognizedDescribe(distinct),"fieldPath");
  const caseVariant=scopedDescribeFixture.replace("Schema.SObjectField fld :","Schema.SObjectField FLD :").replace("fd = fld.getDescribe()","fd = fLd.getDescribe()");
  assert.equal(recognizedDescribe(caseVariant),"fieldPath");
});
test("Schema helper recognition still rejects overlapping names and incorrect lexical references",()=>{
  for(const source of [
    scopedDescribeFixture.replace("Schema.SObjectField fld =","Schema.SObjectField segment =").replace("return fld == null ? null : fld.getDescribe();","return segment == null ? null : segment.getDescribe();"),
    scopedDescribeFixture.replace("Schema.SObjectField fld :","Schema.SObjectField i :").replace("fd = fld.getDescribe()","fd = i.getDescribe()"),
    scopedDescribeFixture.replace("Schema.DescribeFieldResult fd = fld.getDescribe()","Schema.DescribeFieldResult fld = fld.getDescribe()").replaceAll("fd.get","fld.get"),
    scopedDescribeFixture.replace("Schema.SObjectField fld :","Schema.SObjectField other :"),
    scopedDescribeFixture.replace("String fieldPath)","String objectApiName)").replace("fieldPath.split","objectApiName.split"),
    scopedDescribeFixture.replace("currentType = nextType;","currentType = fld;"),
    scopedDescribeFixture.replace("break;","continue;")
  ]){
    assert.equal(recognizedDescribe(source),undefined,source);
  }
});


// A third configuration exercises the source-proven helper against a bounded
// polymorphic reference, including a field after the uncertain iteration.
const alternativeReportSource="public class ColumnBuilder {\n public class Column {\n   public String apiPath;public String fieldName;public String label;public String type;\n   public Boolean navigable;public String displayPath;public String idPath;\n   public Column(){this.navigable=false;}\n }\n public static void run(String reportName,String filtersJson){\n   Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}\n   String obj=cfg.Object__c;if(Schema.getGlobalDescribe().get(obj)==null){return;}\n   List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}\n   Set<String> selected=new Set<String>{'Id'};\n   for(String path:paths){Column col=make(obj,path,selected);}\n   if(String.isNotBlank(cfg.Vertical__c)){selected.add(cfg.Vertical__c);}\n   List<String> groups=parseList(cfg.Groups__c,5);\n   for(Integer gi=0;gi<groups.size();gi++){\n     String gf=groups[gi];selected.add(gf);\n     Schema.DescribeFieldResult gd=fieldDescribe(obj,gf);\n     Column group=new Column();group.fieldName='group'+gi;group.label=gd!=null?gd.getLabel():gf;\n   }\n   Map<String,Object> binds=new Map<String,Object>();\n   List<String> clauses=new List<String>();\n   Set<String> allowed=new Set<String>();\n   for(String f:parseList(cfg.Filters__c,5)){allowed.add(f);}\n   applyFilters(obj,allowed,filtersJson,clauses,binds);\n   String filterWhere=clauses.isEmpty()?'':String.join(clauses,' AND ');\n   String orderBy='Id ASC';\n   if(String.isNotBlank(cfg.Sort__c)){orderBy=cfg.Sort__c.trim()+', Id ASC';}\n   String q='SELECT '+String.join(new List<String>(selected),', ')+' FROM '+String.escapeSingleQuotes(obj)+(String.isNotBlank(filterWhere)?(' WHERE '+filterWhere):'');\n   Database.queryWithBinds(q+' ORDER BY '+orderBy+' LIMIT :pageLimit OFFSET :pageOffset',binds,AccessLevel.USER_MODE);\n   Database.queryWithBinds(q+' ORDER BY '+reverse(orderBy)+' LIMIT :pageLimit OFFSET :pageOffset',binds,AccessLevel.USER_MODE);\n }\n private static Config__mdt getConfig(String name){\n   if(String.isBlank(name)){return null;}\n   List<Config__mdt> rows=[SELECT DeveloperName,Object__c,Field_Set__c,Vertical__c,Groups__c,Filters__c,Sort__c FROM Config__mdt WHERE DeveloperName=:name AND Active__c=true LIMIT 1];\n   return rows.isEmpty()?null:rows[0];\n }\n private static List<String> parseList(String raw,Integer maxItems){\n   List<String> out=new List<String>();\n   if(String.isBlank(raw)){return out;}\n   for(String part:raw.split(';')){String trimmed=part.trim();if(String.isNotBlank(trimmed)&&out.size()<maxItems){out.add(trimmed);}}\n   return out;\n }\n private static String reverse(String orderBy){\n   List<String> reversed=new List<String>();\n   for(String term:orderBy.split(',')){\n     List<String> p=term.trim().split('\\\\s+');String fld=p[0];\n     String dir=(p.size()>1&&p[1].equalsIgnoreCase('DESC'))?'ASC':'DESC';\n     reversed.add(fld+' '+dir);\n   }return String.join(reversed,', ');\n }\n private static void applyFilters(String obj,Set<String> allowed,String filtersJson,List<String> clauses,Map<String,Object> binds){\n   if(String.isBlank(filtersJson)){return;}\n   // Runtime values are not synthesized by this SELECT-only proof.\n   clauses.add(filtersJson);\n }\n private static Column make(String objectName,String path,Set<String> selected){\n   Column col=new Column();col.apiPath=path;col.fieldName=path.replace('.', '_');selected.add(path);\n   Schema.DescribeFieldResult d=fieldDescribe(objectName,path);\n   col.label=d!=null?d.getLabel():path;col.type=d!=null?typeHint(d.getType()):'text';\n   Schema.DisplayType fieldType=d!=null?d.getType():null;\n   if(fieldType==Schema.DisplayType.DATETIME||fieldType==Schema.DisplayType.DATE||fieldType==Schema.DisplayType.TIME){\n     selected.remove(path);selected.add('FORMAT('+path+')');\n   }\n   if(d!=null&&d.getType()==Schema.DisplayType.REFERENCE){\n     col.navigable=true;col.idPath=path;String rel=d.getRelationshipName();\n     if(String.isNotBlank(rel)&&!d.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult rd=d.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(rd);\n       if(nf!=null){col.displayPath=rel+'.'+nf;col.type='reference';selected.add(col.displayPath);}\n     }\n   }else if(path.contains('.')){\n     String prefix=path.substringBeforeLast('.');String leaf=path.substringAfterLast('.');\n     Schema.DescribeFieldResult ld=relationshipDescribe(objectName,prefix);\n     if(ld!=null&&!ld.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult td=ld.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(td);\n       if(nf!=null&&leaf.equalsIgnoreCase(nf)){col.navigable=true;col.idPath=prefix+'.Id';selected.add(col.idPath);}\n     }\n   }else if(d!=null&&d.isNameField()){col.navigable=true;col.idPath='Id';}\n   return col;\n }\n private static String nameApi(Schema.DescribeSObjectResult obj){\n   for(Schema.SObjectField sf:obj.fields.getMap().values()){\n     Schema.DescribeFieldResult d=sf.getDescribe();if(d.isNameField()){return d.getName();}\n   }return null;\n }\n private static Schema.DescribeFieldResult relationshipDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');Schema.DescribeFieldResult result;\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];Schema.DescribeFieldResult match=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();if(segment.equalsIgnoreCase(d.getRelationshipName())){match=d;break;}\n     }\n     if(match==null){return null;}result=match;\n     if(i<parts.size()-1){if(match.getReferenceTo().isEmpty()){return null;}cur=match.getReferenceTo()[0];}\n   }return result;\n }\n private static Schema.DescribeFieldResult fieldDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];\n     if(i==parts.size()-1){Schema.SObjectField f=fields.get(segment.toLowerCase());return f==null?null:f.getDescribe();}\n     Schema.SObjectType next=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();\n       if(segment.equalsIgnoreCase(d.getRelationshipName())){if(!d.getReferenceTo().isEmpty()){next=d.getReferenceTo()[0];}break;}\n     }\n     if(next==null){return null;}cur=next;\n   }return null;\n }\n private static String typeHint(Schema.DisplayType dt){\n   switch on dt {when CURRENCY {return 'currency';}when DATE,DATETIME,TIME {return 'date';}when REFERENCE {return 'reference';}when else {return 'text';}}\n }\n}";

test("three metadata configurations recover SELECT fields with reference target consensus or common evidence",async()=>{
 const filePath="ColumnBuilder.cls",source=alternativeReportSource;
 const rootFields:Record<string,string[]>={
   Account:["Name","CreatedDate","ParentId","Parent.Name","Phone"],
   Contact:["LastName","CreatedDate","AccountId","Account.Name","Email","Title","Phone"],
   Case:["Subject","CreatedDate","OwnerId","Status","Priority","Origin","Type","Reason","Description","CaseNumber","SuppliedEmail","SuppliedName"]
 };
 const rows=Object.keys(rootFields).map(object=>({DeveloperName:object,Object__c:object,Field_Set__c:object+"Fields",Vertical__c:"",Groups__c:"",Filters__c:"",Sort__c:"",Active__c:true}));
 for(const scenario of ["consensus","different","missing"] as const){
   const snapshot=(object:string)=>{
     const fields=object==="User"?["Id","Name"]:object==="Group"?["Id",scenario==="different"?"DeveloperName":"Name"]:["Id",...rootFields[object].filter(f=>!f.includes("."))];
     return {name:object,fields:fields.map(name=>({
       name,type:name==="CreatedDate"?"datetime":name==="Id"?"id":name.endsWith("Id")?"reference":"string",
       nameField:!(scenario==="missing"&&object==="Group"&&name==="Name")?(name==="Name"||name==="LastName"||name==="CaseNumber"||name==="DeveloperName"):undefined,
       relationshipName:name!=="Id"&&name.endsWith("Id")?name.slice(0,-2):null,
       referenceTo:name==="OwnerId"?["User","Group"]:name!=="Id"&&name.endsWith("Id")?["Account"]:[]
     }))};
   };
   const metadata={scopeKey:"schema-alternative-"+scenario,getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
     getObjectSchema:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:snapshot(object)}),
     getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG" as const,value:rows}),
     getFieldSetFields:async(object:string)=>({complete:true,source:"LIVE_ORG" as const,value:rootFields[object]??[]})};
   const index=new ApexRepositoryMethodIndex([{filePath,source}]),engine=new ApexAnalysisEngine(index,metadata);
   for(const site of discoverApexInvocations(source,dynamicDatabaseQuerySelector)){
     const events:Array<{code:string;schemaPath?:string}>=[];
     const result=await engine.analyze(filePath,ctx=>backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push(e)));
     const detail=JSON.stringify({scenario,result,events});
     assert.equal(result.partialSelectQueries?.length,3,detail);
     assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:Id","SELECT:Name","SELECT:CreatedDate","SELECT:ParentId","SELECT:Parent.Name","SELECT:Parent.Id","SELECT:Phone","ORDER_BY:Id"]),detail);
     const expected=["SELECT:Id",...rootFields.Case.map(f=>"SELECT:"+f),...(scenario==="consensus"?["SELECT:Owner.Name"]:[]),"ORDER_BY:Id"];
     assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Case"))),new Set(expected),detail);
     assert.equal(result.bounded,false,detail);
     assert.ok(events.some(e=>e.code===(scenario==="consensus"?"HELPER_SCHEMA_EFFECT_CONSENSUS":"HELPER_SCHEMA_EFFECT_PARTIAL")),detail);
     assert.ok(events.some(e=>e.code==="HELPER_EFFECT_RESULT_UNPROVEN"&&e.schemaPath==="Case.OwnerId"),detail);
   }
   const scan=await engine.analyze(filePath,ctx=>extractDynamicSoqlQueries(source,filePath,ctx.resolveExternal,index));
   const recovered=scan.queries.filter(q=>q.selectPrefixOnly===true&&q.query.includes("FROM Case"));
   assert.equal(recovered.length,2,JSON.stringify(scan));
   assert.ok(scan.unresolved.length>=2);
 }
});
test("lower-bound Set effects reject reads, escapes and unknown structural mutations",()=>{
 for(const body of [
   "if(cols.contains('Name')){cols.add('Phone');}",
   "Set<String> alias=cols;alias.add('Name');",
   "cols.removeAll(new Set<String>{'Name'});",
   "cols.add('Name');cols= new Set<String>();"
 ]){
   const source="public class Proof {private static void change(String value,Set<String> cols){"+body+"}}";
   const method=indexApexMethods(source)[0];
   const model=memberEffectModel(source,[method]);
   assert.equal(model.writeOnlyStringSet(method,1),false,body);
 }
});


// Sanitized regression of the captured 5/7/12 field-set shape. No customer
// source or raw snapshot is committed. Preserve automatic DTO properties,
// a non-Name designated field, date formatting, grouping and a later
// dotted reference whose target Describe was not captured.
test("offline replay of mixed DTO properties retains 17 proven SELECT references with absent target Describe",async()=>{
 const source=alternativeReportSource.replace(
   "public String apiPath;public String fieldName;public String label;public String type;\n   public Boolean navigable;",
   "@AuraEnabled public String apiPath { get; set; }\n   @AuraEnabled public String fieldName { get; set; }\n   @AuraEnabled public String label { get; set; }\n   @AuraEnabled public String type { get; set; }\n   @AuraEnabled public Boolean navigable { get; set; }");
 assert.notEqual(source,alternativeReportSource);
 const filePath="ColumnBuilder.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
 const field=(name:string,type="string",nameField=false,relationshipName:string|null=null,referenceTo:string[]=[]):ApexSchemaField=>({name,type,nameField,relationshipName,referenceTo});
 const id=field("Id","id"),name=field("Name","string",true);
 const schemas:Record<string,ApexSchemaField[]>={
   Bin__c:[id,name,field("Stock__c","reference",false,"Stock__r",["Stock__c"]),field("Received__c","date"),field("Batch__c"),field("Expiry__c","date"),field("ExpiryDays__c","double")],
   Stock__c:[id,name,...["OnHand__c","Sent__c","Available__c","Reserved__c","Future__c"].map(n=>field(n,"double"))],
   Allocation__c:[id,name,field("Line__c","reference",false,"Line__r",["Line__c"]),field("Bin__c","reference",false,"Bin__r",["Bin__c"]),field("Header__c","reference",false,"Header__r",["Header__c"]),field("Reserved__c","double")],
   Line__c:[id,name,field("Header__c","reference",false,"Header__r",["Header__c"]),field("Code__c"),field("LineNumber__c","double"),field("Reserved__c","double"),field("AllocationStatus__c"),field("Requested__c","double"),field("Gross__c","currency"),field("Net__c","currency"),field("Shelf__c","double"),field("AllocationType__c","picklist")],
   Header__c:[id,field("DocumentNumber__c","string",true),field("BillCode__c"),field("PO__c"),field("Status__c","picklist"),field("CreatedDate","datetime"),field("ShipDate__c","date"),field("DueDate__c","datetime"),field("CreatedById","reference",false,"CreatedBy",["User"])]
 };
 const rootFields:Record<string,string[]>={
   Bin__c:["Stock__r.OnHand__c","Stock__r.Sent__c","Stock__r.Available__c","Stock__r.Reserved__c","Stock__r.Future__c"],
   Allocation__c:["Line__r.Shelf__c","Line__r.Requested__c","Bin__r.Batch__c","Bin__r.Expiry__c","Bin__r.ExpiryDays__c","Reserved__c","Line__r.AllocationType__c"],
   Line__c:["Header__r.BillCode__c","Header__r.DocumentNumber__c","Header__r.PO__c","Code__c","Header__r.Status__c","Header__r.CreatedDate","Header__r.ShipDate__c","Header__r.DueDate__c","LineNumber__c","Reserved__c","AllocationStatus__c","Header__r.CreatedById"]
 };
 const rows=Object.keys(rootFields).map(object=>({DeveloperName:object,Object__c:object,Field_Set__c:object+"Fields",
   Vertical__c:object==="Bin__c"?"Received__c":null,Groups__c:object==="Line__c"?"Header__r.DocumentNumber__c;Requested__c;Gross__c;Net__c":object==="Allocation__c"?"Header__r.DocumentNumber__c":null,
   Filters__c:null,Sort__c:object==="Line__c"?"Header__c, Header__r.CreatedDate ASC":"Id ASC",Active__c:true}));
 const provider:ApexMetadataProvider={scopeKey:"sanitized-captured-shape",getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
   getObjectSchema:async object=>schemas[object]?{complete:true,source:"LIVE_ORG",value:{name:object,fields:schemas[object]}}:{complete:false,source:"LIVE_ORG"},
   getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG",value:rows}),
   getFieldSetFields:async object=>({complete:true,source:"LIVE_ORG",value:rootFields[object]??[]})};
 const capture=new ApexMetadataCapture(provider);
 const run=async(metadata:ApexMetadataProvider)=>{
   const engine=new ApexAnalysisEngine(index,metadata);
   for(const site of discoverApexInvocations(source,dynamicDatabaseQuerySelector)){
     const events:Array<{code:string;schemaPath?:string}>=[];
     const result=await engine.analyze(filePath,ctx=>backtrackSoqlPermissionShapes(source,filePath,site,index,ctx.resolveExternal,e=>events.push(e)));
     const detail=JSON.stringify({result,events});
     assert.equal(result.partialSelectQueries?.length,3,detail);
     const selected=result.queries.filter(q=>q.includes("FROM Line__c"));
     assert.deepEqual(fields(selected),new Set(["SELECT:Id",...rootFields.Line__c.map(f=>"SELECT:"+f),"SELECT:Header__r.Id","SELECT:Requested__c","SELECT:Gross__c","SELECT:Net__c","ORDER_BY:Header__c","ORDER_BY:Header__r.CreatedDate","ORDER_BY:Id"]),detail);
     assert.ok(selected.some(q=>q.includes("FORMAT(Header__r.CreatedDate)")&&q.includes("FORMAT(Header__r.ShipDate__c)")&&q.includes("FORMAT(Header__r.DueDate__c)")),detail);
     assert.equal(fields(result.queries.filter(q=>q.includes("FROM Bin__c"))).size,8,detail);
     assert.equal(fields(result.queries.filter(q=>q.includes("FROM Allocation__c"))).size,10,detail);
     assert.ok(events.some(e=>e.code==="HELPER_SET_UNKNOWN_ADDITION"&&e.schemaPath==="Line__c.Header__r.CreatedById"),detail);
     assert.equal(result.bounded,false,detail);
   }
   const scan=await engine.analyze(filePath,ctx=>extractDynamicSoqlQueries(source,filePath,ctx.resolveExternal,index));
   assert.equal(scan.queries.filter(q=>q.selectPrefixOnly&&q.query.includes("FROM Line__c")).length,2,JSON.stringify(scan));
   assert.ok(scan.unresolved.length>=2);
 };
 await run(capture.provider);
 const snapshot=capture.snapshot();
 assert.ok(snapshot.entries.some(e=>e.request.kind==="schema"&&e.request.name==="User"));
 snapshot.entries=snapshot.entries.filter(e=>!(e.request.kind==="schema"&&e.request.name==="User"));
 const replay=new ApexMetadataReplay(snapshot);
 await run(replay.provider);
 assert.equal(replay.stats.missing,1);
 assert.deepEqual(replay.missingRequests,[{kind:"schema",name:"User"}]);
});


test("literal sort fields survive an unknown WHERE; a raw sort hole remains unverified",()=>{
 const source="public class Q {public static void run(String w){String q='SELECT Id FROM Account'+(String.isNotBlank(w)?(' WHERE '+w):'')+' ORDER BY Name DESC, Id ASC';Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}";
 const result=evidence([{filePath:"Q.cls",source}]);
 assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","ORDER_BY:Name","ORDER_BY:Id"]));
 assert.equal(result.partialSelectQueries?.length,1);
 const scan=extractDynamicSoqlQueries(source,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source}]));
 assert.equal(scan.unresolved.length,1);
 assert.ok(scan.queries.every(q=>q.selectPrefixOnly));
 const conflict=source.replace("Name DESC, Id ASC","Name WITH SYSTEM_MODE");
 const unsafe=evidence([{filePath:"Q.cls",source:conflict}]);
 assert.ok(![...fields(unsafe.queries)].some(f=>f.startsWith("ORDER_BY:")));
});


test("COUNT root survives one unknown conditional WHERE from a private caller but retains review",()=>{
 const source="public class CountRunner { public class Result {public Integer total;} public static void run(String filter){Result result=new Result();String obj='Account';result.total=count(obj,filter);} private static Integer count(String obj,String filter){String q='SELECT COUNT() FROM '+String.escapeSingleQuotes(obj);if(String.isNotBlank(filter)){q+=' WHERE '+filter;}return Database.countQueryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);} }";
 const index=new ApexRepositoryMethodIndex([{filePath:"CountRunner.cls",source}]);
 const site=discoverApexInvocations(source,dynamicDatabaseQuerySelector)[0];
 const result=backtrackSoqlPermissionShapes(source,"CountRunner.cls",site,index);
 assert.deepEqual(result.queries,["SELECT COUNT() FROM Account"],JSON.stringify(result));
 assert.deepEqual(result.partialSelectQueries,result.queries);
 const scan=extractDynamicSoqlQueries(source,"CountRunner.cls",undefined,index);
 assert.equal(scan.unresolved.length,1);
 assert.equal(scan.queries.length,1,JSON.stringify(scan));
 assert.ok(scan.queries.some(q=>q.object==="Account"&&q.coverage==="KNOWN_CALLER_CONTEXT"&&q.fields.length===0),JSON.stringify(scan));
});


test("metadata candidate caller roots propagate into COUNT without synthetic fields or full-coverage claims",async()=>{
 const source="public class CountRunner { public class Result {public Integer total;} public static void run(String reportName,String filter){Result result=new Result();Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}String obj=cfg.Object__c;result.total=count(obj,filter);} private static Config__mdt getConfig(String key){if(String.isBlank(key)){return null;}List<Config__mdt> rows=[SELECT DeveloperName,Object__c FROM Config__mdt WHERE DeveloperName=:key AND Active__c=true LIMIT 1];return rows.isEmpty()?null:rows[0];} private static Integer count(String obj,String filter){String q='SELECT COUNT() FROM '+String.escapeSingleQuotes(obj);if(String.isNotBlank(filter)){q+=' WHERE '+filter;}return Database.countQueryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);} }";
 const filePath="CountRunner.cls",index=new ApexRepositoryMethodIndex([{filePath,source}]);
 const metadata:ApexMetadataProvider={scopeKey:"count-metadata-rows",getObjectFieldNames:async()=>({complete:false,source:"LIVE_ORG"}),
   getCustomMetadataRecords:async()=>({complete:true,source:"LIVE_ORG",value:["Account","Contact","Case"].map(object=>({DeveloperName:object,Object__c:object,Active__c:true}))})};
 const engine=new ApexAnalysisEngine(index,metadata);
 const scan=await engine.analyze(filePath,ctx=>extractDynamicSoqlQueries(source,filePath,ctx.resolveExternal,index));
 assert.deepEqual(new Set(scan.queries.map(q=>q.object)),new Set(["Account","Contact","Case"]),JSON.stringify(scan));
 assert.ok(scan.queries.every(q=>q.fields.length===0&&q.selectPrefixOnly&&q.dynamicAccessLevel==="USER_MODE"),JSON.stringify(scan));
 assert.equal(scan.unresolved.length,1);
 assert.equal(scan.unresolved[0].aggregatedPermissionInventories,3);
 assert.match(scan.unresolved[0].reportReason??"",/Runtime WHERE and effective enforcement remain unverified/);
});


test("phase 4: guarded predicate list preserves clause context and ignores bound data",()=>{
  const source="public class FilterFixture {public static void run(String term,Id owner,Boolean active){List<String> clauses=new List<String>{'Name LIKE :term'};if(active){clauses.add('OwnerId = :owner');}else{clauses.add('Parent.Name != null');}String filter=clauses.isEmpty()?'':String.join(clauses,' AND ');String q='SELECT Id FROM Account'+(String.isNotBlank(filter)?(' WHERE '+filter):'');Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}";
  const result=evidence([{filePath:"FilterFixture.cls",source}]);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Name","WHERE:OwnerId","WHERE:Parent.Name"]),JSON.stringify(result));
  const scan=extractDynamicSoqlQueries(source,"FilterFixture.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"FilterFixture.cls",source}]));
  // The forward engine can already enumerate both branches here. Do not
  // force a fallback or downgrade its more precise complete coverage.
  assert.deepEqual(fields(scan.queries.map(q=>q.query)),new Set(["SELECT:Id","WHERE:Name","WHERE:OwnerId","WHERE:Parent.Name"]),JSON.stringify(scan));
  assert.ok(scan.queries.every(q=>q.dynamicAccessLevel==="USER_MODE"));
  assert.equal(scan.unresolved.length,0);
});
test("phase 4: predicates from correlated metadata records remain associated with their root",()=>{
  const source="public class FilterFixture {public static void run(String name){Config__mdt cfg=Config__mdt.getInstance(name);List<String> clauses=new List<String>();clauses.add(cfg.Filter__c+' = :input');String filter=String.join(clauses,' AND ');String q='SELECT Id FROM '+cfg.Object__c+(String.isNotBlank(filter)?(' WHERE '+filter):'');Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}";
  const result=evidence([{filePath:"FilterFixture.cls",source}],(name)=>name==="Apex.metadataRows"?{kind:"records",items:[
    [["DeveloperName",textValue("A")],["Object__c",textValue("Account")],["Filter__c",textValue("Industry")]],
    [["DeveloperName",textValue("B")],["Object__c",textValue("Contact")],["Filter__c",textValue("Email")]]
  ]}:undefined);
  assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:Id","WHERE:Industry"]),JSON.stringify(result));
  assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Id","WHERE:Email"]),JSON.stringify(result));
});
test("phase 4: unknown additional WHERE does not erase known permission references",()=>{
  const source="public class FilterFixture {public static void run(String raw,Boolean flag,Boolean extra){String q='SELECT Id FROM Account WHERE Name != null';if(flag){q+=' AND Industry != null';}if(extra){q+=' AND '+raw;}Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}";
  const result=evidence([{filePath:"FilterFixture.cls",source}]);
  assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Name","WHERE:Industry"]),JSON.stringify(result));
  assert.deepEqual(result.partialSelectQueries,result.queries);
  const scan=extractDynamicSoqlQueries(source,"FilterFixture.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"FilterFixture.cls",source}]));
  assert.ok(scan.queries.some(q=>q.selectPrefixOnly&&q.permissionEvidence==="AGGREGATED_STRUCTURE"),JSON.stringify(scan));
  assert.equal(scan.unresolved.length,1);
  assert.match(scan.unresolved[0].reportReason??"",/WHERE.*unverified/i);
  const implicit=source.replace("Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE)","Database.query(q)");
  assert.equal(evidence([{filePath:"FilterFixture.cls",source:implicit}]).partialSelectQueries,undefined);
});
test("phase 4: arbitrary predicate inputs and non-predicate collection members are not proven",()=>{
  for(const fragment of ["raw","'Name != null ORDER BY Name'","'Name != null WITH SYSTEM_MODE'","'Name != null LIMIT 1'","'Name != null AND'"]){
    const source="public class FilterFixture {public static void run(String raw){List<String> clauses=new List<String>{"+fragment+"};String filter=String.join(clauses,' AND ');Database.query('SELECT Id FROM Account WHERE '+filter);}}";
    assert.deepEqual(evidence([{filePath:"FilterFixture.cls",source}]).queries,[],source);
  }
});


const configuredPredicateFixture="public class ConfigFixture {"+
 "private class Spec { public String path; public List<String> searches; public Boolean mandatory; }"+
 "public class Input { public String key; public String value; }"+
 "private static List<Spec> parse(String cfg){List<Spec> out=new List<Spec>();if(String.isBlank(cfg)){return out;}for(String seg:cfg.split(';')){String s=seg.trim();if(String.isBlank(s)||out.size()>=2){continue;}Spec item=new Spec();item.searches=new List<String>();item.mandatory=false;if(s.startsWith('*')){item.mandatory=true;s=s.substring(1).trim();}if(s.contains(':')){item.path=s.substringBefore(':').trim();for(String extra:s.substringAfter(':').split(',')){if(String.isNotBlank(extra.trim())){item.searches.add(extra.trim());}}}else{item.path=s;}if(String.isNotBlank(item.path)){out.add(item);}}return out;}"+
 "private static void addUser(String obj,Set<String> allowed,String payload,List<String> clauses,Map<String,Object> binds){if(String.isBlank(payload)){return;}List<Input> items=(List<Input>)JSON.deserialize(payload,List<Input>.class);if(items==null||items.isEmpty()){return;}Integer idx=0;for(Input item:items){if(item==null||String.isBlank(item.key)||!allowed.contains(item.key)){continue;}Schema.DescribeFieldResult d=describeFieldPath(obj,item.key);if(d==null){continue;}write(item.key,kind(d),d,item,idx,clauses,binds);idx++;}}"+
 "private static void addDefaults(String obj,String cfg,Set<String> overrides,List<String> clauses,Map<String,Object> binds){if(String.isBlank(cfg)){return;}Integer idx=100;for(String segment:cfg.split(';')){String s=segment.trim();if(String.isBlank(s)){continue;}if(raw(s)){clauses.add('('+s+')');continue;}if(!s.contains('=')){continue;}String f=s.substringBefore('=').trim();if(overrides.contains(f)){continue;}Schema.DescribeFieldResult d=describeFieldPath(obj,f);if(d==null){continue;}Input item=new Input();item.value=defaultValue(s.substringAfter('=').trim());write(f,kind(d),d,item,idx,clauses,binds);idx++;}}"+
 "private static Boolean raw(String s){String u=' '+s.toUpperCase()+' ';return s.contains('(')||s.contains('<')||s.contains('>')||s.contains('!=')||u.contains(' IN ')||u.contains(' LIKE ')||u.contains(' NOT ')||u.contains(' AND ')||u.contains(' OR ');}"+
 "private static String kind(Schema.DescribeFieldResult d){return 'text';}private static String defaultValue(String s){return s;}"+
 "private static void write(String f,String k,Schema.DescribeFieldResult d,Input item,Integer idx,List<String> clauses,Map<String,Object> binds){if(String.isBlank(item.value)){return;}String b='b'+idx;clauses.add(f+' = :'+b);binds.put(b,item.value);}"+
 scopedDescribeFixture.slice(scopedDescribeFixture.indexOf("{")+1,scopedDescribeFixture.lastIndexOf("}"))+
 "public static void run(String payload,Set<String> overrides){String obj='Account';List<String> clauses=new List<String>();Map<String,Object> binds=new Map<String,Object>();Set<String> allowed=new Set<String>();for(Spec item:parse('*Name:Email,Phone;Industry;Description')){allowed.add(item.path);}addUser(obj,allowed,payload,clauses,binds);addDefaults(obj,'Type=customer;AnnualRevenue > 0',overrides,clauses,binds);String predicate=clauses.isEmpty()?'':String.join(clauses,' AND ');String q='SELECT Id FROM '+obj+(String.isNotBlank(predicate)?(' WHERE '+predicate):'');Database.queryWithBinds(q,binds,AccessLevel.USER_MODE);}}";
function configuredSchema(name:string,args:ApexValue[]):ApexValue|undefined{
 if(name!=="Schema.fieldMap"||args[0]?.kind!=="text"||args[0].values[0]!=="Account")return undefined;
 return {kind:"map",keyType:"schemaField",entries:["Id","Name","Industry","Type","AnnualRevenue","Phone","Description"].map(field=>[field.toLowerCase(),{kind:"schema",schemaType:"fieldToken",objectApiName:"Account",field:{name:field,type:"string",relationshipName:null,referenceTo:[]}}])};
}
test("phase 4.1: finite DTO projection and default predicates exclude lookup search fields and over-cap fields",()=>{
 const result=evidence([{filePath:"ConfigFixture.cls",source:configuredPredicateFixture}],configuredSchema);
 assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Name","WHERE:Industry","WHERE:Type","WHERE:AnnualRevenue"]),JSON.stringify(result));
});
test("phase 4.1: source contracts reject unguarded fields, accumulator escape, arbitrary bind names and root mismatch",()=>{
 for(const source of [
   configuredPredicateFixture.replace("||!allowed.contains(item.key)",""),
   configuredPredicateFixture.replace("clauses.add(f+' = :'+b);","Other.mutate(clauses);clauses.add(f+' = :'+b);"),
   configuredPredicateFixture.replace("String b='b'+idx;","String b=item.value;"),
   configuredPredicateFixture.replace("'SELECT Id FROM '+obj","'SELECT Id FROM Contact'"),
   configuredPredicateFixture.replace("allowed.add(item.path);","allowed.add('Other__c');"),
   configuredPredicateFixture.replace("clauses.add(f+' = :'+b);","clauses.add('Other__c = :'+b);")
 ])assert.equal(evidence([{filePath:"ConfigFixture.cls",source}],configuredSchema).queries.length,0,source);
});
test("phase 4.1: COUNT uses the same proven WHERE field inventory",()=>{
 const source=configuredPredicateFixture.replace("String q='SELECT Id FROM '+obj+(String.isNotBlank(predicate)?(' WHERE '+predicate):'');Database.queryWithBinds(q,binds,AccessLevel.USER_MODE);","String q='SELECT COUNT() FROM '+obj;if(String.isNotBlank(predicate)){q+=' WHERE '+predicate;}Database.countQueryWithBinds(q,binds,AccessLevel.USER_MODE);");
 const result=evidence([{filePath:"ConfigFixture.cls",source}],configuredSchema);
 assert.deepEqual(fields(result.queries),new Set(["WHERE:Name","WHERE:Industry","WHERE:Type","WHERE:AnnualRevenue"]),JSON.stringify(result));
});


test("phase 4.1: metadata row-specific user and default field domains stay correlated",()=>{
 const source=configuredPredicateFixture
  .replace("run(String payload,Set<String> overrides){String obj='Account';","run(String report,String payload,Set<String> overrides){Config__mdt cfg=Config__mdt.getInstance(report);String obj=cfg.Object__c;")
  .replace("parse('*Name:Email,Phone;Industry;Description')","parse(cfg.User__c)")
  .replace("'Type=customer;AnnualRevenue > 0',overrides","cfg.Default__c,overrides");
 const result=evidence([{filePath:"ConfigFixture.cls",source}],(name,args)=>{
   if(name==="Apex.metadataRows")return {kind:"records",items:[
    [["DeveloperName",textValue("A")],["Object__c",textValue("Account")],["User__c",textValue("*Name:Phone;Industry")],["Default__c",textValue("Type=customer")]],
    [["DeveloperName",textValue("B")],["Object__c",textValue("Contact")],["User__c",textValue("Email")],["Default__c",textValue("Title != null")]]
   ]};
   if(name==="Schema.fieldMap"&&args[0]?.kind==="text"&&args[0].values[0]==="Contact")
    return {kind:"map",keyType:"schemaField",entries:["Id","Email","Title"].map(field=>[field.toLowerCase(),{kind:"schema",schemaType:"fieldToken",objectApiName:"Contact",field:{name:field,type:"string",relationshipName:null,referenceTo:[]}}])};
   return configuredSchema(name,args);
 });
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:Id","WHERE:Name","WHERE:Industry","WHERE:Type"]),JSON.stringify(result));
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Id","WHERE:Email","WHERE:Title"]),JSON.stringify(result));
});


test("phase 4.1: scoped bind names are valid in separate switch branches but not outside their declaration",()=>{
 const source=configuredPredicateFixture.replace("String b='b'+idx;clauses.add(f+' = :'+b);binds.put(b,item.value);",
   "switch on k {when 'text' {String b='b'+idx+'a';clauses.add(f+' LIKE :'+b);binds.put(b,item.value);}when else {String b='b'+idx+'b';clauses.add(f+' = :'+b);binds.put(b,item.value);}}");
 assert.deepEqual(fields(evidence([{filePath:"ConfigFixture.cls",source}],configuredSchema).queries),
   new Set(["SELECT:Id","WHERE:Name","WHERE:Industry","WHERE:Type","WHERE:AnnualRevenue"]));
 const escaped=configuredPredicateFixture.replace("String b='b'+idx;clauses.add(f+' = :'+b);","if(k=='text'){String b='b'+idx;}clauses.add(f+' = :'+b);");
 assert.equal(evidence([{filePath:"ConfigFixture.cls",source:escaped}],configuredSchema).queries.length,0);
});


test("phase 4.1: shadowed platform identifier is not treated as a JSON deserializer",()=>{
 const source=configuredPredicateFixture.replace("String payload,List<String> clauses","String JSON,List<String> clauses")
  .replace("String.isBlank(payload)){return;}List<Input>","String.isBlank(JSON)){return;}List<Input>")
  .replace("JSON.deserialize(payload,List<Input>.class)","JSON.deserialize(JSON,List<Input>.class)");
 assert.equal(evidence([{filePath:"ConfigFixture.cls",source}],configuredSchema).queries.length,0);
});


const configuredAggregateFixture="public class AggregateFixture {"+
 scopedDescribeFixture.slice(scopedDescribeFixture.indexOf("{")+1,scopedDescribeFixture.lastIndexOf("}"))+
 "private static String kind(Schema.DisplayType d){return 'number';}"+
 "public static void run(String key){Config__mdt row=Config__mdt.getInstance(key);String obj=row.Object__c;String ordering='Id';if(String.isNotBlank(row.Order__c)){ordering=row.Order__c.trim()+', Id';}"+
 "if(String.isNotBlank(row.Summary__c)){summary(obj,row.Summary__c,row.Predicate__c);}}"+
 "private static void summary(String obj,String config,String predicate){List<String> selected=new List<String>();Integer idx=0;"+
 "for(String def:config.split(',')){if(String.isBlank(def)) continue;String main;String alternative=null;if(def.contains('##')){main=def.substringBefore('##').trim();alternative=def.substringAfter('##').trim();}else{main=def.trim();}"+
 "List<String> parts=main.split(':');if(parts.isEmpty()) continue;String field=parts[0].trim();String fn=parts.size()>1?parts[1].trim().toUpperCase():'SUM';String label=parts.size()>2?parts[2].trim():null;if(String.isBlank(field)){continue;}"+
 "Set<String> allowed=new Set<String>{'SUM','AVG','MIN','MAX','COUNT'};if(!allowed.contains(fn)){continue;}Schema.DescribeFieldResult d=describeFieldPath(obj,field);String fieldLabel=d!=null?d.getLabel():field;String alias=null;"+
 "if(d!=null){alias='agg'+idx;String expr=(fn=='COUNT')?'COUNT(Id)':(fn+'('+field+')');selected.add(expr+' '+alias);}"+
 "Map<String,Object> display=new Map<String,Object>{'label'=>String.isNotBlank(label)?label:fieldLabel,'type'=>d!=null?kind(d.getType()):'number'};if(alias!=null){display.put('alias',alias);}if(String.isNotBlank(alternative)){display.put('fallback',alternative);}idx++;}"+
 "if(!selected.isEmpty()){String q='SELECT '+String.join(selected,', ')+' FROM '+String.escapeSingleQuotes(obj);if(String.isNotBlank(predicate)){q+=' WHERE '+predicate;}Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);}}}";
function aggregateSchema(name:string,args:ApexValue[]):ApexValue|undefined{
 if(name==="Apex.metadataRows")return {kind:"records",items:[
  [["DeveloperName",textValue("A")],["Object__c",textValue("Account")],["Order__c",textValue("Name")],["Summary__c",textValue("AnnualRevenue:AVG:Label,Phone:COUNT,Industry:MAX,Missing__c:SUM,Name:BAD")],["Predicate__c",textValue("Type != null")]],
  [["DeveloperName",textValue("B")],["Object__c",textValue("Contact")],["Order__c",textValue("Email")],["Summary__c",textValue("Email:MIN,Title:COUNT")],["Predicate__c",textValue("Title != null")]]
 ]};
 if(name==="Schema.fieldMap"&&args[0]?.kind==="text"&&args[0].values[0]==="Contact")
  return {kind:"map",keyType:"schemaField",entries:["Id","Email","Title"].map(field=>[field.toLowerCase(),{kind:"schema",schemaType:"fieldToken",objectApiName:"Contact",field:{name:field,type:"string",relationshipName:null,referenceTo:[]}}])};
 return configuredSchema(name,args);
}
test("phase 5: aggregate configuration across metadata rows, COUNT(Id), aliases, WHERE and read-only trim",()=>{
 const result=evidence([{filePath:"AggregateFixture.cls",source:configuredAggregateFixture}],aggregateSchema);
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:AnnualRevenue","SELECT:Industry","SELECT:Id","WHERE:Type"]),JSON.stringify(result));
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Email","SELECT:Id","WHERE:Title"]),JSON.stringify(result));
});
test("phase 5: reject unproven configured aggregates and metadata mutations",()=>{
 for(const source of [
   configuredAggregateFixture.replace("ordering=row.Order__c.trim()+', Id';","row.Summary__c='Name:SUM';"),
   configuredAggregateFixture.replace("selected.add(expr+' '+alias);","selected.add(alternative);"),
   configuredAggregateFixture.replace("idx++;}","Other.mutate(selected);idx++;}"),
   configuredAggregateFixture.replace("if(!allowed.contains(fn)){continue;}",""),
   configuredAggregateFixture.replace("if(d!=null){alias=","if(true){alias="),
   configuredAggregateFixture.replace("String.escapeSingleQuotes(obj)","'Case'")
 ])assert.equal(evidence([{filePath:"AggregateFixture.cls",source}],aggregateSchema).queries.length,0,source);
});
test("phase 5: literal aggregate SELECT lists preserve fields but not aliases",()=>{
 const source="public class AggregateFixture {public static void run(){List<String> f=new List<String>{'SUM(AnnualRevenue) total','COUNT_DISTINCT(Industry) uniqueCount'};String q='SELECT '+String.join(f,', ')+' FROM Account WHERE Type != null';Database.query(q);}}";
 assert.deepEqual(fields(evidence([{filePath:"AggregateFixture.cls",source}]).queries),new Set(["SELECT:AnnualRevenue","SELECT:Industry","WHERE:Type"]));
});


test("phase 5: reuse configured predicate evidence through a guarded summary call and preserve actual field inventory",()=>{
 const summary=configuredAggregateFixture.slice(configuredAggregateFixture.indexOf("private static void summary"),-1);
 const base=configuredPredicateFixture
  .replace("public static void run(String payload,Set<String> overrides){String obj='Account';","public static void run(String key,String payload,Set<String> overrides){Config__mdt row=Config__mdt.getInstance(key);String obj=row.Object__c;")
  .replace("parse('*Name:Email,Phone;Industry;Description')","parse(row.User__c)")
  .replace("'Type=customer;AnnualRevenue > 0',overrides","row.Default__c,overrides")
  .replace("String q='SELECT Id FROM '+obj+(String.isNotBlank(predicate)?(' WHERE '+predicate):'');Database.queryWithBinds(q,binds,AccessLevel.USER_MODE);",
   "String ordering='Id';if(String.isNotBlank(row.Order__c)){ordering=row.Order__c.trim()+', Id';}if(String.isNotBlank(row.Summary__c)){try{summary(obj,row.Summary__c,predicate);}catch(Exception ex){System.debug(ex);}}");
 const source=base.slice(0,-1)+"private static String kindForDisplay(Schema.DisplayType d){return 'number';}"+summary.replace("kind(d.getType())","kindForDisplay(d.getType())")+"}";
 const resolve=(name:string,args:ApexValue[]):ApexValue|undefined=>{
   if(name==="Apex.metadataRows")return {kind:"records",items:[
     [["DeveloperName",textValue("A")],["Object__c",textValue("Account")],["Order__c",textValue("Name")],["User__c",textValue("*Name:Phone;Industry")],["Default__c",textValue("Type=customer")],["Summary__c",textValue("AnnualRevenue:SUM,Phone:COUNT")]],
     [["DeveloperName",textValue("B")],["Object__c",textValue("Contact")],["Order__c",textValue("Email")],["User__c",textValue("Email")],["Default__c",textValue("Title != null")],["Summary__c",textValue("Email:MIN")]]
   ]};
   return aggregateSchema(name,args);
 };
 const result=evidence([{filePath:"ConfigFixture.cls",source}],resolve);
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Account"))),new Set(["SELECT:AnnualRevenue","SELECT:Id","WHERE:Name","WHERE:Industry","WHERE:Type"]),JSON.stringify(result));
 assert.deepEqual(fields(result.queries.filter(q=>q.includes("FROM Contact"))),new Set(["SELECT:Email","WHERE:Email","WHERE:Title"]),JSON.stringify(result));
 const scan=extractDynamicSoqlQueries(source,"ConfigFixture.cls",resolve,new ApexRepositoryMethodIndex([{filePath:"ConfigFixture.cls",source}]));
 assert.ok(scan.queries.some(q=>q.dynamicAccessLevel==="USER_MODE"&&q.query.includes("AnnualRevenue")&&q.query.includes("WHERE")),JSON.stringify(scan));
});


const configuredFallbackFixture="public class FallbackFixture {"+
 scopedDescribeFixture.slice(scopedDescribeFixture.indexOf("{")+1,scopedDescribeFixture.lastIndexOf("}"))+
 "private class SummaryValue{public String label;public String type;public Object value;}"+
 "private static String kind(Schema.DisplayType d){return 'number';}"+
 "public static void run(String key,Map<String,String> values){Config__mdt row=Config__mdt.getInstance(key);String obj=row.Object__c;String ordering='Id';if(String.isNotBlank(row.Order__c)){ordering=row.Order__c.trim()+', Id';}if(String.isNotBlank(row.Summary__c)){try{summary(obj,row.Summary__c,values);}catch(Exception ex){System.debug(ex);}}}"+
 "private static void summary(String obj,String config,Map<String,String> values){List<String> selected=new List<String>();List<Map<String,Object>> metas=new List<Map<String,Object>>();Integer idx=0;"+
 "for(String def:config.split(',')){if(String.isBlank(def)) continue;String main;String alternative=null;if(def.contains('##')){main=def.substringBefore('##').trim();alternative=def.substringAfter('##').trim();}else{main=def.trim();}"+
 "List<String> parts=main.split(':');if(parts.isEmpty()) continue;String field=parts[0].trim();String fn=parts.size()>1?parts[1].trim().toUpperCase():'SUM';String label=parts.size()>2?parts[2].trim():null;if(String.isBlank(field)){continue;}"+
 "Set<String> allowed=new Set<String>{'SUM','AVG','MIN','MAX','COUNT'};if(!allowed.contains(fn)){continue;}Schema.DescribeFieldResult d=describeFieldPath(obj,field);String fieldLabel=d!=null?d.getLabel():field;String alias=null;"+
 "if(d!=null){alias='agg'+idx;String expr=(fn=='COUNT')?'COUNT(Id)':(fn+'('+field+')');selected.add(expr+' '+alias);}"+
 "Map<String,Object> meta=new Map<String,Object>{'label'=>String.isNotBlank(label)?label:(fn+' of '+fieldLabel),'type'=>(fn=='COUNT')?'number':(d!=null?kind(d.getType()):'number')};if(alias!=null){meta.put('alias',alias);}if(String.isNotBlank(alternative)){meta.put('fallbackQuery',alternative);}metas.add(meta);idx++;}"+
 "AggregateResult agg=null;if(!selected.isEmpty()){String q='SELECT '+String.join(selected,', ')+' FROM '+String.escapeSingleQuotes(obj);List<AggregateResult> r=Database.queryWithBinds(q,new Map<String,Object>(),AccessLevel.USER_MODE);agg=r.isEmpty()?null:r[0];}"+
 "for(Map<String,Object> item:metas){SummaryValue card=new SummaryValue();card.label=(String)item.get('label');card.type=(String)item.get('type');String alias=(String)item.get('alias');Object val=null;if(alias!=null&&agg!=null){val=agg.get(alias);}String template=(String)item.get('fallbackQuery');if(val==null&&String.isNotBlank(template)){Map<String,Object> binds=new Map<String,Object>();String query=template;Integer counter=0;"+
 "Pattern compiled=Pattern.compile('\\\\{([^}]+)\\\\}');Matcher matcher=compiled.matcher(template);Boolean canRun=true;Set<String> placeholders=new Set<String>();while(matcher.find()){placeholders.add(matcher.group(0));}"+
 "for(String placeholder:placeholders){String key=placeholder.substring(1,placeholder.length()-1);if(values.containsKey(key)){String bind='fb'+counter++;query=query.replace(placeholder,':'+bind);binds.put(bind,values.get(key));}else{canRun=false;break;}}"+
 "if(canRun&&!binds.isEmpty()){try{List<AggregateResult> results=Database.queryWithBinds(query,binds,AccessLevel.SYSTEM_MODE);if(results!=null&&!results.isEmpty()){val=results[0].get('expr0');}}catch(Exception ex){System.debug(ex);}}}card.value=val;}}}";
const fallbackMetadata=(config:string,other="")=>(name:string,args:ApexValue[]):ApexValue|undefined=>{
 if(name==="Apex.metadataRows")return {kind:"records",items:[
  [["DeveloperName",textValue("A")],["Object__c",textValue("Account")],["Order__c",textValue("Name")],["Summary__c",textValue(config)]],
  [["DeveloperName",textValue("B")],["Object__c",textValue("Contact")],["Order__c",textValue("Email")],["Summary__c",textValue(other)]]
 ]};
 return aggregateSchema(name,args);
};
function fallbackEvidence(source:string,resolve:(name:string,args:ApexValue[])=>ApexValue|undefined){
 const filePath="FallbackFixture.cls",sites=discoverApexInvocations(source,dynamicDatabaseQuerySelector);
 const site=sites.at(-1)!;
 return backtrackSoqlPermissionShapes(source,filePath,site,new ApexRepositoryMethodIndex([{filePath,source}]),resolve);
}
const fallbackConfig="Display Label##SELECT MAX(AnnualRevenue) FROM Account WHERE Type = {Input.Type} AND Name = {Input.Name},Name:COUNT:Display##SELECT MAX(NumberOfEmployees) FROM Account WHERE Type = {Input.Type},Missing__c:MAX##SELECT MIN(Amount) FROM Opportunity WHERE AccountId = {Input.Id},Skipped:BAD##SELECT MAX(Other__c) FROM Account WHERE Name = {Input.Name}";
test("phase 6: finite fallback templates traverse metadata and nested maps independently of primary Schema guard",()=>{
 const result=fallbackEvidence(configuredFallbackFixture,fallbackMetadata(fallbackConfig,"Other Label##SELECT MAX(Score__c) FROM Contact WHERE Email = {External.Email}"));
 assert.deepEqual(fields(result.queries.filter(q=>/FROM Account\b/.test(q))),new Set(["SELECT:AnnualRevenue","SELECT:NumberOfEmployees","WHERE:Type","WHERE:Name"]),JSON.stringify(result));
 assert.deepEqual(fields(result.queries.filter(q=>/FROM Opportunity\b/.test(q))),new Set(["SELECT:Amount","WHERE:AccountId"]),JSON.stringify(result));
 assert.deepEqual(fields(result.queries.filter(q=>/FROM Contact\b/.test(q))),new Set(["SELECT:Score__c","WHERE:Email"]),JSON.stringify(result));
 assert.equal(result.queries.length,4);
});
test("phase 6: scanner consolidates fallback templates by target root and retains SYSTEM_MODE and partial review",()=>{
 const source=configuredFallbackFixture,filePath="FallbackFixture.cls";
 const scan=extractDynamicSoqlQueries(source,filePath,fallbackMetadata(fallbackConfig),new ApexRepositoryMethodIndex([{filePath,source}]));
 const found=scan.queries.filter(q=>q.dynamicAccessLevel==="SYSTEM_MODE");
 assert.equal(found.length,2,JSON.stringify(scan));
 assert.ok(found.every(q=>q.coverage==="PROVEN_PARTIAL_STRUCTURE"&&q.permissionEvidence==="AGGREGATED_STRUCTURE"&&!q.withUserMode));
 assert.deepEqual(fields(found.filter(q=>q.object==="Account").map(q=>q.query)),new Set(["SELECT:AnnualRevenue","SELECT:NumberOfEmployees","WHERE:Type","WHERE:Name"]));
 assert.ok(scan.unresolved.some(u=>u.aggregatedPermissionInventories===2));
});
test("phase 6: reject unsafe query writes, aliases and unproven placeholder transformations",()=>{
 for(const source of [
  configuredFallbackFixture.replace("query=query.replace(placeholder,':'+bind);","query=query.replace(placeholder,values.get(key));"),
  configuredFallbackFixture.replace("metas.add(meta);","Other.mutate(meta);metas.add(meta);"),
  configuredFallbackFixture.replace("AggregateResult agg=null;","Other.mutate(metas);AggregateResult agg=null;"),
  configuredFallbackFixture.replace("matcher.group(0)","matcher.group(1)"),
  configuredFallbackFixture.replace("query=query.replace(placeholder,':'+bind);","query=query.replace(placeholder,':'+bind);query+=' ORDER BY '+key;"),
  configuredFallbackFixture.replace("Database.queryWithBinds(query,binds,AccessLevel.SYSTEM_MODE)","Database.queryWithBinds(query,new Map<String,Object>(),AccessLevel.SYSTEM_MODE)")
 ])assert.equal(fallbackEvidence(source,fallbackMetadata(fallbackConfig)).queries.length,0,source);
});
test("phase 6: reject structural/quoted holes, preserve safe sibling templates and skip empty/no-bind definitions",()=>{
 const bad=[
  "SELECT {Input.Name} FROM Account WHERE Name = {Input.Name}",
  "SELECT MAX(AnnualRevenue) FROM {Input.Root} WHERE Name = {Input.Name}",
  "SELECT MAX(AnnualRevenue) FROM Account WHERE {Input.Field} = {Input.Name}",
  "SELECT MAX(AnnualRevenue) FROM Account WHERE Name = '{Input.Name}'",
  "SELECT MAX(AnnualRevenue) FROM Account WHERE Name = {Input.Name}suffix",
  "SELECT MAX(AnnualRevenue) FROM Account WHERE Name = :old AND Type = {Input.Type}",
  "SELECT MAX(AnnualRevenue) FROM Account WHERE Name != null"
 ];
 for(const template of bad)assert.equal(fallbackEvidence(configuredFallbackFixture,fallbackMetadata("Label##"+template)).queries.length,0,template);
 const result=fallbackEvidence(configuredFallbackFixture,fallbackMetadata("Label##"+bad[0]+",Safe##SELECT MAX(AnnualRevenue) FROM Account WHERE Name = {Input.Name}"));
 assert.deepEqual(fields(result.queries),new Set(["SELECT:AnnualRevenue","WHERE:Name"]),JSON.stringify(result));
});
test("phase 6: explicit USER_MODE conflict is not silently treated as SYSTEM_MODE",()=>{
 const source=configuredFallbackFixture,filePath="FallbackFixture.cls";
 const scan=extractDynamicSoqlQueries(source,filePath,fallbackMetadata("Label##SELECT MAX(AnnualRevenue) FROM Account WHERE Name = {Input.Name} WITH USER_MODE"),new ApexRepositoryMethodIndex([{filePath,source}]));
 assert.equal(scan.queries.filter(q=>q.dynamicAccessLevel==="SYSTEM_MODE").length,0,JSON.stringify(scan));
});


test("B: empty predicate accumulator retains required and optional bind predicates with leading space",()=>{
 const files=[{filePath:"Service.cls",source:"public class Service {public static void run(String p,Map<String,Object> binds){String q='SELECT Id FROM Account WHERE'+p+' ORDER BY Name LIMIT :lim OFFSET :off';Database.queryWithBinds(q,binds,AccessLevel.USER_MODE);}}"},
 {filePath:"Caller.cls",source:"public class Caller {public static void run(Boolean flag,Id customer){Map<String,Object> b=new Map<String,Object>();String p='';p+=' RecordType.Name =: recordTypeName';if(flag){p+=' AND Industry = :industry';}if(customer!=null){p+=' AND ParentId = :customer';}Service.run(p,b);}}"}];
 const result=evidence(files);
 assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:RecordType.Name","WHERE:Industry","WHERE:ParentId","ORDER_BY:Name"]),JSON.stringify(result));
});
test("B: source-declared DTO scalar member slots preserve intended fields but not runtime enforcement",()=>{
 const files=[{filePath:"Service.cls",source:"public class Service {public static void run(String p){String q='SELECT Id FROM Account '+p;Database.query(q);}}"},
 {filePath:"Entry.cls",source:"public class Entry {public class Input{@InvocableVariable public String name;}public class Output{@InvocableVariable public Id parent;}public static void run(List<Input> input,Output output){Service.run('WHERE Name = \\''+input[0].name+'\\' AND ParentId = \\''+output.parent+'\\' AND Type != null');}}"}];
 const result=evidence(files);
 assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Name","WHERE:ParentId","WHERE:Type"]),JSON.stringify(result));
 assert.deepEqual(result.intendedValueQueries,result.queries);
 const scan=extractDynamicSoqlQueries(files[0].source,files[0].filePath,undefined,new ApexRepositoryMethodIndex(files));
 assert.ok(scan.queries.some(q=>q.selectPrefixOnly&&q.coverage==="PROVEN_PARTIAL_STRUCTURE"),JSON.stringify(scan));
 for(const source of [
  files[1].source.replace("WHERE Name = \\'","WHERE ").replace("+'\\' AND ParentId", "+' = null AND ParentId"),
  files[1].source.replace("public String name;","public Object name;")
 ])assert.equal(evidence([files[0],{...files[1],source}]).queries.length,0);
});
test("B: typed Id list and date value slots preserve child SELECT and ORDER BY independently",()=>{
 const files=[{filePath:"Service.cls",source:"public class Service {public static void run(String p){String q='SELECT Id,(SELECT Id,Email FROM Contacts ORDER BY LastName) FROM Account '+p;Database.query(q);}}"},
 {filePath:"Entry.cls",source:"public class Entry {public static void run(Set<Id> ids){String formatted='\\''+String.join(ids,'\\',\\'')+'\\'';String p='WHERE Id IN ('+formatted+') AND CreatedDate <= '+DateTime.now().format('yyyy-MM-dd')+' ORDER BY Name';Service.run(p);}}"}];
 const result=evidence(files);
 assert.equal(result.nestedQueries?.length,1,JSON.stringify(result));
 assert.deepEqual(fields(result.queries),new Set(["SELECT:Id","WHERE:Id","WHERE:CreatedDate","ORDER_BY:Name"]));
 const scan=extractDynamicSoqlQueries(files[0].source,files[0].filePath,undefined,new ApexRepositoryMethodIndex(files));
 const q=scan.queries.find(q=>q.coverage==="PROVEN_PARTIAL_STRUCTURE");
 assert.ok(q,JSON.stringify(scan));
 assert.deepEqual(q.subqueries?.[0]?.fields,["Id","Email"]);
 assert.match(q.subqueries?.[0]?.query??"",/ORDER BY LastName/);
 assert.equal(evidence([files[0],{...files[1],source:files[1].source.replace("Set<Id>","Set<String>")}]).queries.length,0);
});
