import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexDataFlowEngine} from "../src/core/apex/ApexDataFlowEngine.js";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {memberEffectModel} from "../src/core/apex/ApexMemberEffectModel.js";
import {textValue,unknown,runtimeParameter,addApexValues} from "../src/core/apex/ApexValueEvaluator.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {provePartialSoql} from "../src/analyzer/soqlPartialStructure.js";

test("explicit scalar member reset and private helper append are propagated across calls",()=>{
  const source="public class Builder {private static String q='SELECT Id';public static void run(){q='SELECT Id';List<String> fields=new List<String>{'Name','Phone'};appendFields(fields);Database.query(q+' FROM Account');}private static void appendFields(List<String> fields){for(String f:fields){q+=','+f;}}}";
  const report=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(report.unresolved.length,0,JSON.stringify(report.unresolved));
  assert.deepEqual(report.queries.map(q=>q.query),["SELECT Id,Name,Phone FROM Account"]);
  const open=extractDynamicSoqlQueries(source.replace("q='SELECT Id';List","List"),"Builder.cls");
  assert.equal(open.queries.length,0);
  assert.equal(open.unresolved.length,1);
});

test("direct helper reference mutation updates caller alias but parameter reassignment does not",()=>{
  const source="public class Builder {public static void run(){List<String> fields=new List<String>{'Id'};List<String> alias=fields;List<String> spare=new List<String>{'Phone'};append(fields,spare);Database.query('SELECT '+String.join(alias,',')+' FROM Account');}private static void append(List<String> cols,List<String> spare){cols.add('Name');cols=spare;cols.add('Email');}}";
  const report=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(report.unresolved.length,0,JSON.stringify(report.unresolved));
  assert.deepEqual(report.queries.map(q=>q.query),["SELECT Id,Name FROM Account"]);
});

test("divergent early returns and unknown external callbacks never leave a stale member value",()=>{
  const source="public class Builder {private static String q='SELECT Id';public static void run(Boolean flag){q='SELECT Id';change(flag);Database.query(q+' FROM Account');}private static void change(Boolean flag){if(flag){q+=',Name';return;}q+=',Phone';}}";
  assert.equal(extractDynamicSoqlQueries(source,"Builder.cls").queries.length,0);
  const external=source.replace("change(flag);","Other.maybeMutate();");
  assert.equal(extractDynamicSoqlQueries(external,"Builder.cls").queries.length,0);
});

test("direct Aura entry is a separate sample and never initializes arbitrary methods",()=>{
  const source="public class Builder {private static String q='SELECT Id';@AuraEnabled public static void run(Id recordId){appendField('Name');Inspector.inspect(q,recordId);}private static void appendField(String name){q+=','+name;}}";
  const methods=indexApexMethods(source);
  const method=methods.find(m=>m.name==="run")!;
  const model=memberEffectModel(source,methods);
  assert.ok(model.freshEntry(method));
  const offset=source.indexOf("Inspector.inspect");
  const engine=new ApexDataFlowEngine(source);
  const ordinary=engine.evaluateArgumentsAt(method,offset,["q","recordId"]);
  assert.equal(ordinary[0][0].kind,"unknown");
  const fresh=engine.evaluateArgumentsAt(method,offset,["q","recordId"],undefined,true);
  assert.deepEqual(fresh[0][0],textValue("SELECT Id,Name"));
  assert.equal(fresh[0][1].kind,"unknown");
  const other=source.replace("@AuraEnabled ","");
  const otherMethods=indexApexMethods(other);
  assert.equal(memberEffectModel(other,otherMethods).freshEntry(otherMethods.find(m=>m.name==="run")!),undefined);
  const block=source.replace("private static String q='SELECT Id';","private static String q='SELECT Id';static {q='SELECT Phone';}");
  const blockMethods=indexApexMethods(block);
  assert.equal(memberEffectModel(block,blockMethods).freshEntry(blockMethods.find(m=>m.name==="run")!),undefined);
});

test("Field Set iterator and inert UI DTO preserve a sampled cross-class SELECT accumulator",async()=>{
  const caller=[
    "public class Builder {",
    " private static String q='SELECT Id';",
    " public class Column { public String name {get;set;} public Boolean editable {get;set;} public Column(String name){this.name=name;this.editable=false;} }",
    " @AuraEnabled public static Object run(Id recordId){",
    "  List<Schema.FieldSetMember> members=Schema.SObjectType.Account.fieldSets.getMap().get('Columns').getFields();",
    "  List<Object> ui=build(members);",
    "  return QueryService.fetch(q,recordId);",
    " }",
    " private static List<Object> build(List<Schema.FieldSetMember> members){",
    "  List<Object> ui=new List<Object>();",
    "  Set<String> editable=new Set<String>(Label.Editable.split(','));",
    "  for(Schema.FieldSetMember member:members){",
    "   String name=member.getFieldPath(); q+=','+name;",
    "   String label=member.getLabel(); String dataType=member.getType().name();",
    "   Column col=new Column(label); if(editable.contains(name)){col.editable=true;}",
    "   String serialized=JSON.serialize(col).removeEnd('}')+'}';",
    "   Object obj=JSON.deserializeUntyped(serialized);ui.add(obj);",
    "  }return ui;",
    " }",
    "}",
  ].join("\n");
  const service="public class QueryService { public static List<SObject> fetch(String query,Id recordId){query=String.escapeSingleQuotes(query)+' FROM Account WHERE Id = :recordId WITH SECURITY_ENFORCED';return Database.query(query);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Builder.cls",source:caller},{filePath:"QueryService.cls",source:service}]);
  const provider={
    scopeKey:"fixture",getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomMetadataRecords:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomLabelValue:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:"Name"}),
    getFieldSetFields:async()=>({complete:true as const,source:"LIVE_ORG" as const,value:["Name","Phone"]}),
  };
  const methods=index.indexedMethods("Builder.cls",caller)!;
  assert.ok(memberEffectModel(caller,methods).replaySafe(methods.find(m=>m.name==="build")!), "DTO helper must pass bounded source effect proof");
  const report=await new ApexAnalysisEngine(index,provider).analyze("QueryService.cls",ctx=>extractDynamicSoqlQueries(service,"QueryService.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(report.unresolved.length,1,JSON.stringify(report));
  assert.ok(report.queries.some(q=>q.query==="SELECT Id,Name,Phone FROM Account WHERE Id = :recordId WITH SECURITY_ENFORCED"&&q.coverage==="KNOWN_CALLER_CONTEXT"),JSON.stringify(report));
  assert.match(report.unresolved[0].reason,/fresh framework entry/);
});

test("numeric runtime slots are separate structural evidence; String, object and field holes stay unknown",()=>{
  const integer=runtimeParameter("n","Integer","runtime n");
  const prefix=addApexValues(textValue("SELECT Id,Name FROM Account LIMIT "),integer);
  assert.deepEqual(provePartialSoql(prefix),{text:"SELECT Id,Name FROM Account LIMIT 1",holes:1});
  assert.equal(prefix.kind,"unknown");
  assert.equal(provePartialSoql(addApexValues(textValue("SELECT Id FROM "),runtimeParameter("obj","String","runtime object"))),undefined);
  assert.equal(provePartialSoql(addApexValues(textValue("SELECT "),integer)),undefined);
  assert.equal(provePartialSoql(addApexValues(textValue("SELECT Id FROM Account WHERE Name = '"),integer)),undefined);
  const source="public class Builder {public static void run(Integer n){Database.query('SELECT Id,Name FROM Account LIMIT '+n);}}";
  const result=extractDynamicSoqlQueries(source,"Builder.cls");
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].partialStructureVariants,1);
  assert.equal(result.queries[0]?.coverage,"PROVEN_PARTIAL_STRUCTURE");
  assert.equal(result.queries[0]?.query,"SELECT Id,Name FROM Account LIMIT 1");
  const unknownMode=source.replace("'+n);","'+n,accessLevel);");
  assert.equal(extractDynamicSoqlQueries(unknownMode,"Builder.cls").queries.length,0);
});

test("partial private caller can submit proven numeric-slot inventory without closing the site",()=>{
  const source="public class Builder {public static void run(Integer n){helper('Account',n);}private static void helper(String obj,Integer n){Database.query('SELECT Name FROM '+obj+' LIMIT '+n);}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"Builder.cls",source}]);
  const report=extractDynamicSoqlQueries(source,"Builder.cls",undefined,index);
  assert.equal(report.unresolved.length,1);
  assert.ok(report.queries.some(q=>q.coverage==="PROVEN_PARTIAL_STRUCTURE"&&q.object==="Account"),JSON.stringify(report));
});
