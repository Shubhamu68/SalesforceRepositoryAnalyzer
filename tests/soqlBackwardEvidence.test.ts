import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {discoverApexInvocations,dynamicDatabaseQuerySelector} from "../src/core/apex/ApexInvocationModel.js";
import {backtrackSoqlPermissionShapes} from "../src/analyzer/soqlBackwardEvidence.js";
import {extractSoqlExpressionFields} from "../src/analyzer/soqlExpressionInventory.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {textValue,type ApexValue} from "../src/core/apex/ApexValueEvaluator.js";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
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
  const source="public class ColumnBuilder {\n public class Column {\n   public String apiPath;public String fieldName;public String label;public String type;\n   public Boolean navigable;public String displayPath;public String idPath;\n   public Column(){this.navigable=false;}\n }\n public static void run(String reportName){\n   Config__mdt cfg=getConfig(reportName);if(cfg==null){return;}\n   String obj=cfg.Object__c;if(Schema.getGlobalDescribe().get(obj)==null){return;}\n   List<String> paths=Utils.getFieldListFromFieldSet(obj,cfg.Field_Set__c);if(paths==null||paths.isEmpty()){return;}\n   Set<String> selected=new Set<String>{'Id'};\n   for(String path:paths){Column col=make(obj,path,selected);}\n   String q='SELECT '+String.join(new List<String>(selected),', ')+' FROM '+obj;\n   Database.queryWithBinds(q+' ORDER BY Id ASC',new Map<String,Object>(),AccessLevel.USER_MODE);\n   Database.queryWithBinds(q+' ORDER BY Id DESC',new Map<String,Object>(),AccessLevel.USER_MODE);\n }\n private static Config__mdt getConfig(String name){\n   if(String.isBlank(name)){return null;}\n   List<Config__mdt> rows=[SELECT DeveloperName,Object__c,Field_Set__c FROM Config__mdt WHERE DeveloperName=:name AND Active__c=true LIMIT 1];\n   return rows.isEmpty()?null:rows[0];\n }\n private static Column make(String objectName,String path,Set<String> selected){\n   Column col=new Column();col.apiPath=path;col.fieldName=path.replace('.', '_');selected.add(path);\n   Schema.DescribeFieldResult d=fieldDescribe(objectName,path);\n   col.label=d!=null?d.getLabel():path;col.type=d!=null?typeHint(d.getType()):'text';\n   Schema.DisplayType fieldType=d!=null?d.getType():null;\n   if(fieldType==Schema.DisplayType.DATETIME||fieldType==Schema.DisplayType.DATE||fieldType==Schema.DisplayType.TIME){\n     selected.remove(path);selected.add('FORMAT('+path+')');\n   }\n   if(d!=null&&d.getType()==Schema.DisplayType.REFERENCE){\n     col.navigable=true;col.idPath=path;String rel=d.getRelationshipName();\n     if(String.isNotBlank(rel)&&!d.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult rd=d.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(rd);\n       if(nf!=null){col.displayPath=rel+'.'+nf;col.type='reference';selected.add(col.displayPath);}\n     }\n   }else if(path.contains('.')){\n     String prefix=path.substringBeforeLast('.');String leaf=path.substringAfterLast('.');\n     Schema.DescribeFieldResult ld=relationshipDescribe(objectName,prefix);\n     if(ld!=null&&!ld.getReferenceTo().isEmpty()){\n       Schema.DescribeSObjectResult td=ld.getReferenceTo()[0].getDescribe();\n       String nf=nameApi(td);\n       if(nf!=null&&leaf.equalsIgnoreCase(nf)){col.navigable=true;col.idPath=prefix+'.Id';selected.add(col.idPath);}\n     }\n   }else if(d!=null&&d.isNameField()){col.navigable=true;col.idPath='Id';}\n   return col;\n }\n private static String nameApi(Schema.DescribeSObjectResult obj){\n   for(Schema.SObjectField sf:obj.fields.getMap().values()){\n     Schema.DescribeFieldResult d=sf.getDescribe();if(d.isNameField()){return d.getName();}\n   }return null;\n }\n private static Schema.DescribeFieldResult relationshipDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');Schema.DescribeFieldResult result;\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];Schema.DescribeFieldResult match=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();if(segment.equalsIgnoreCase(d.getRelationshipName())){match=d;break;}\n     }\n     if(match==null){return null;}result=match;\n     if(i<parts.size()-1){if(match.getReferenceTo().isEmpty()){return null;}cur=match.getReferenceTo()[0];}\n   }return result;\n }\n private static Schema.DescribeFieldResult fieldDescribe(String obj,String path){\n   Schema.SObjectType cur=Schema.getGlobalDescribe().get(obj);if(cur==null){return null;}\n   List<String> parts=path.split('\\\\.');\n   for(Integer i=0;i<parts.size();i++){\n     Map<String,Schema.SObjectField> fields=cur.getDescribe().fields.getMap();String segment=parts[i];\n     if(i==parts.size()-1){Schema.SObjectField leaf=fields.get(segment.toLowerCase());return leaf==null?null:leaf.getDescribe();}\n     Schema.SObjectType next=null;\n     for(Schema.SObjectField f:fields.values()){\n       Schema.DescribeFieldResult d=f.getDescribe();\n       if(segment.equalsIgnoreCase(d.getRelationshipName())){if(!d.getReferenceTo().isEmpty()){next=d.getReferenceTo()[0];}break;}\n     }\n     if(next==null){return null;}cur=next;\n   }return null;\n }\n private static String typeHint(Schema.DisplayType dt){\n   switch on dt {when CURRENCY {return 'currency';}when DATE,DATETIME,TIME {return 'date';}when REFERENCE {return 'reference';}when else {return 'text';}}\n }\n}";

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
