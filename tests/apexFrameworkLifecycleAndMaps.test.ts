import {provePartialSoql} from "../src/analyzer/soqlPartialStructure.js";
import assert from "node:assert/strict";
import {test} from "node:test";
import {withApexPerformance} from "../src/core/apex/ApexPerformance.js";
import {ApexAnalysisEngine} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {outerApexClass,supportsApexAllocation} from "../src/core/apex/ApexClassModel.js";
import {evaluateApexExpression,textValue,runtimeParameter,addApexValues} from "../src/core/apex/ApexValueEvaluator.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";

const scan=async (files: {filePath:string;source:string}[],filePath:string)=>{
  const index=new ApexRepositoryMethodIndex(files);
  return new ApexAnalysisEngine(index).analyze(filePath,ctx=>extractDynamicSoqlQueries(files.find(f=>f.filePath===filePath)!.source,filePath,ctx.resolveExternal,ctx.repositoryIndex));
};
test("multiple framework interfaces are classified without assuming arbitrary inheritance",()=>{
  const model=outerApexClass("public with sharing class Work implements Database.Batchable<SObject>, Database.Stateful {}");
  assert.ok(model?.batch&&model.stateful);
  assert.ok(supportsApexAllocation(model));
  assert.equal(supportsApexAllocation(outerApexClass("public class Work extends Base implements Database.Batchable<SObject> {}")),false);
});
test("typed maps distinguish numeric and text lookup keys",()=>{
  const env=new Map();
  const map=evaluateApexExpression("new Map<Integer,String>{1=>'Id',2=>'Name'}",{values:env});
  assert.deepEqual(map,{kind:"map",keyType:"integer",entries:[["1",textValue("Id")],["2",textValue("Name")]]});
  env.set("m",map);
  assert.deepEqual(evaluateApexExpression("m.get(2)",{values:env}),textValue("Name"));
  assert.equal(evaluateApexExpression("m.get('2')",{values:env}).kind,"unknown");
});
test("actual submitted stateful receiver reflects pre-submission writes through a local alias",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>, Database.Stateful {public String query;public Work(){query='SELECT Id FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator(query);}public void execute(Database.BatchableContext bc,List<SObject> rows){}public void finish(Database.BatchableContext bc){}}";
  const caller="public class Submitter {public static void go(){Work item=new Work();Work alias=item;alias.query='SELECT Name FROM Account';Database.executeBatch(item,100);}}";
  const result=await scan([{filePath:"Work.cls",source:batch},{filePath:"Submitter.cls",source:caller}],"Work.cls");
  assert.equal(result.unresolved.length,1);
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="KNOWN_CALLER_CONTEXT"),JSON.stringify(result));
  assert.ok(!result.queries.some(q=>q.query==="SELECT Id FROM Account"),JSON.stringify(result));
});
test("constructor-only scenario is not labeled as an observed submission or complete query",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>{public String query;public Work(){query='SELECT Name FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator(query);}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.equal(result.unresolved.length,1);
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
});
test("factory map with nested source-backed objects preserves correlated key scenarios",async()=>{
  const config="public class Config {public class Item {public String objectName;public String lookup;public Item(String o,String f){objectName=o;lookup=f;}} public static Map<Integer,Item> make(){Map<Integer,Item> m=new Map<Integer,Item>{1=>new Item('Account','Name'),2=>new Item('Contact','Email')};m.put(3,new Item('Case',Test.isRunningTest()?'Subject':'Status'));return m;}}";
  const batch="public class Work implements Database.Batchable<SObject>,Database.Stateful{private Integer step;private Map<Integer,Config.Item> map;public Work(Integer step){this.step=step;this.map=Config.make();}public Database.QueryLocator start(Database.BatchableContext bc){if(!map.containsKey(step)){return Database.getQueryLocator('SELECT Id FROM Account');}Config.Item item=map.get(step);return Database.getQueryLocator('SELECT Id FROM '+item.objectName+' WHERE '+item.lookup+' = :term');}}";
  const result=await scan([{filePath:"Config.cls",source:config},{filePath:"Work.cls",source:batch}],"Work.cls");
  const queries=result.queries.filter(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT").map(q=>q.query);
  assert.ok(queries.includes("SELECT Id FROM Account WHERE Name = :term"),JSON.stringify(result));
  assert.ok(queries.includes("SELECT Id FROM Contact WHERE Email = :term"),JSON.stringify(result));
  assert.ok(queries.includes("SELECT Id FROM Case WHERE Subject = :term"),JSON.stringify(result));
  assert.ok(queries.includes("SELECT Id FROM Case WHERE Status = :term"),JSON.stringify(result));
  assert.ok(!queries.includes("SELECT Id FROM Contact WHERE Name = :term"));
  assert.equal(result.unresolved.length,1);
});
test("unproven intervening callback cannot leave a stale constructor-derived query",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>{public String query;public Work(){query='SELECT Name FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){Other.mutate(this);return Database.getQueryLocator(query);}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
});

test("bounded private instance initialization propagates fields into a submitted receiver",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>{private String query;public Work(){initialize();}private void initialize(){String field='Name';this.query='SELECT '+field+' FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator(query);}}";
  const caller="public class Submitter {public static void go(){Database.executeBatch(new Work(),100);}}";
  const result=await scan([{filePath:"Work.cls",source:batch},{filePath:"Submitter.cls",source:caller}],"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="KNOWN_CALLER_CONTEXT"),JSON.stringify(result));
});
test("exact Custom Metadata getInstance discovers fields through existing metadata provider",async()=>{
  const source="public class C { public static void run(){ Example__mdt settings=Example__mdt.getInstance('Default'); Database.query('SELECT '+settings.Field__c+' FROM Account'); }}";
  const index=new ApexRepositoryMethodIndex([{filePath:"C.cls",source}]);
  const reads:Array<{type:string;fields:readonly string[]}>=[]; 
  const provider={
    scopeKey:"fixture-mdt",
    getObjectFieldNames:async()=>({complete:false as const,source:"LIVE_ORG" as const}),
    getCustomMetadataRecords:async(type:string,fields:readonly string[])=>{
      reads.push({type,fields});
      return {complete:true as const,source:"LIVE_ORG" as const,value:[Object.fromEntries(fields.map(f=>[f,f==="DeveloperName"?"Default":"Name"]))]};
    },
  };
  const result=await new ApexAnalysisEngine(index,provider).analyze("C.cls",ctx=>extractDynamicSoqlQueries(source,"C.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.deepEqual(result.queries.map(q=>q.query),["SELECT Name FROM Account"],JSON.stringify(result));
  assert.ok(reads.some(r=>r.type==="Example__mdt"&&r.fields.includes("Field__c")));
  const unavailable=await scan([{filePath:"C.cls",source}],"C.cls");
  assert.equal(unavailable.queries.length,0);
});
test("quoted typed Id holes are safe only at exact literal boundaries",()=>{
  const id=runtimeParameter("id","Id","runtime");
  const make=(prefix:string,value:ReturnType<typeof runtimeParameter>,suffix:string)=>addApexValues(addApexValues(textValue(prefix),value),textValue(suffix));
  const proof=provePartialSoql(make("SELECT Id FROM Account WHERE Id = '",id,"'"));
  assert.deepEqual(proof,{text:"SELECT Id FROM Account WHERE Id = '000000000000000'",holes:1});
  assert.equal(provePartialSoql(make("SELECT Id FROM Account WHERE Id = '",runtimeParameter("id","String","runtime"),"'")),undefined);
  assert.equal(provePartialSoql(make("SELECT Id FROM Account WHERE Id = 'prefix",id,"'")),undefined);
  assert.equal(provePartialSoql(make("SELECT Id FROM Account WHERE Id = 'prefix\\'",id,"'")),undefined);
  assert.equal(provePartialSoql(make("SELECT Id FROM ",id,"")),undefined);
});
test("an unknown declared Id assignment retains type without claiming a business record value",()=>{
  const source="public class C {public static void run(){Id recordId=Other.lookup();Database.query('SELECT Id FROM Account WHERE Id = \\''+recordId+'\\'');}}";
  const result=extractDynamicSoqlQueries(source,"C.cls");
  assert.equal(result.unresolved.length,1);
  assert.equal(result.queries[0]?.coverage,"PROVEN_PARTIAL_STRUCTURE",JSON.stringify(result));
});

test("read-only private instance aliases preserve static configuration maps, but writes invalidate them",async()=>{
  const config="public class Config {public class Item {public String objectName;public String typeName;public Item(String o,String t){objectName=o;typeName=t;}}public static Map<Integer,Item> M=new Map<Integer,Item>{1=>new Item('Account','None'),2=>new Item('Contact','None')};}";
  const batch="public class Work implements Database.Batchable<SObject>,Database.Stateful{private Integer step;private Map<Integer,Config.Item> settings=Config.M;public Work(Integer step){this.step=step;}public Database.QueryLocator start(Database.BatchableContext bc){if(!settings.containsKey(step))return Database.getQueryLocator('SELECT Id FROM Case');Config.Item item=settings.get(step);String objectName=item.objectName;return Database.getQueryLocator('SELECT Id FROM '+objectName);}}";
  const files=[{filePath:"Config.cls",source:config},{filePath:"Work.cls",source:batch}];
  const result=await scan(files,"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Id FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.ok(result.queries.some(q=>q.query==="SELECT Id FROM Contact"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  const mutated=batch.replace("String objectName=item.objectName;","item.objectName='Lead';String objectName=item.objectName;");
  const unsafe=await scan([files[0],{filePath:"Work.cls",source:mutated}],"Work.cls");
  assert.ok(!unsafe.queries.some(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(unsafe));
});
test("constructor normal-path scenario with business Id remains conditional and never queries business data",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>,Database.Stateful {private Id creator;public Work(String name){try{User u=[SELECT Id FROM User WHERE Name=:name LIMIT 1];this.creator=u.Id;}catch(QueryException e){this.creator=null;}}public Database.QueryLocator start(Database.BatchableContext bc){if(creator==null)return Database.getQueryLocator('SELECT Id FROM Case');return Database.getQueryLocator('SELECT Id FROM Account WHERE CreatedById = \\''+creator+'\\'');}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Id FROM Account WHERE CreatedById = '000000000000000'"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
});

test("batch receiver inventory is shared across sites but site-specific control flow remains distinct",async()=>{
  const config="public class Config {public class Item {public String objectName;public Item(String o){objectName=o;}}public static Map<Integer,Item> make(){Map<Integer,Item> m=new Map<Integer,Item>{1=>new Item('Account'),2=>new Item('Contact')};return m;}}";
  const batch="public class Work implements Database.Batchable<SObject>{private Integer step;private Map<Integer,Config.Item> settings;public Work(Integer step){this.step=step;this.settings=Config.make();}public Database.QueryLocator start(Database.BatchableContext bc){Config.Item item=settings.get(step);String objectName=item.objectName;if(step==1){return Database.getQueryLocator('SELECT Id FROM '+objectName);}return Database.getQueryLocator('SELECT Name FROM '+objectName);}}";
  const counts=new Map<string,number>();
  const result=await withApexPerformance({count:(name,n)=>counts.set(name,(counts.get(name)??0)+n),duration:()=>{}},
    ()=>scan([{filePath:"Config.cls",source:config},{filePath:"Work.cls",source:batch}],"Work.cls"));
  assert.ok(result.queries.some(q=>q.query==="SELECT Id FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Contact"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.ok(!result.queries.some(q=>q.query==="SELECT Id FROM Contact"||q.query==="SELECT Name FROM Account"),JSON.stringify(result));
  assert.equal(counts.get("caller.batch_receiver_inventory_evaluations"),1);
  assert.ok((counts.get("caller.batch_receiver_cache_hits")??0)>=1);
});

test("duplicate batch query arguments leave bounded sampling capacity for later configuration keys",async()=>{
  const entries=Array.from({length:36},(_,i)=>`${i+1}=>new Item('${i<32?"Account":["Contact","Case","Lead","Opportunity"][i-32]}')`).join(",");
  const config=`public class Config {public class Item {public String objectName;public Item(String o){objectName=o;}}public static Map<Integer,Item> make(){Map<Integer,Item> m=new Map<Integer,Item>{${entries}};return m;}}`;
  const batch="public class Work implements Database.Batchable<SObject>{private Integer step;private Map<Integer,Config.Item> settings;public Work(Integer step){this.step=step;this.settings=Config.make();}public Database.QueryLocator start(Database.BatchableContext bc){Config.Item item=settings.get(step);return Database.getQueryLocator('SELECT Id FROM '+item.objectName);}}";
  const counts=new Map<string,number>();
  const result=await withApexPerformance({count:(name,n)=>counts.set(name,(counts.get(name)??0)+n),duration:()=>{}},
    ()=>scan([{filePath:"Config.cls",source:config},{filePath:"Work.cls",source:batch}],"Work.cls"));
  const queries=result.queries.filter(q=>q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT").map(q=>q.query);
  assert.deepEqual(new Set(queries),new Set(["Account","Contact","Case","Lead","Opportunity"].map(o=>"SELECT Id FROM "+o)),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
  assert.ok((counts.get("caller.batch_receiver_overflow_samples")??0)>0);
  assert.ok((counts.get("caller.batch_receiver_overflow_samples")??0)<=32);
});

test("stateful first execute carries constructor fields through a read-only start, but remains conditional",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>,Database.Stateful{private String fields;public Work(){fields='Name';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator('SELECT Id FROM Account');}public void execute(Database.BatchableContext bc,List<SObject> rows){Database.query('SELECT '+fields+' FROM Account');}public void finish(Database.BatchableContext bc){}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
  for(const variant of [
    batch.replace(",Database.Stateful",""),
    batch.replace("return Database.getQueryLocator","fields='Id';return Database.getQueryLocator"),
    batch.replace("return Database.getQueryLocator","Other.mutate(this);return Database.getQueryLocator"),
    batch.replace("private String fields","private transient String fields")
  ]){
    const rejected=await scan([{filePath:"Work.cls",source:variant}],"Work.cls");
    assert.ok(!rejected.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(rejected));
  }
});
test("private receiver dispatch preserves constructor state and call argument correlation",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>,Database.Stateful{private String fields;public Work(){fields='Name';}public Database.QueryLocator start(Database.BatchableContext bc){return Database.getQueryLocator('SELECT Id FROM Account');}public void execute(Database.BatchableContext bc,List<SObject> rows){this.fetch('Account');}private void fetch(String obj){Database.query('SELECT '+this.fields+' FROM '+obj);}public void finish(Database.BatchableContext bc){}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  assert.equal(result.unresolved.length,1);
  const mutated=batch.replace("this.fetch('Account');","fields='Id';this.fetch('Account');");
  const unsafe=await scan([{filePath:"Work.cls",source:mutated}],"Work.cls");
  assert.ok(!unsafe.queries.some(q=>q.query==="SELECT Name FROM Account"),JSON.stringify(unsafe));
});
test("private zero-argument dispatch from start is conditional, and unreachable call is not sampled",async()=>{
  const batch="public class Work implements Database.Batchable<SObject>{private String query;public Work(){query='SELECT Name FROM Account';}public Database.QueryLocator start(Database.BatchableContext bc){return this.fetch();}private Database.QueryLocator fetch(){return Database.getQueryLocator(query);}}";
  const result=await scan([{filePath:"Work.cls",source:batch}],"Work.cls");
  assert.ok(result.queries.some(q=>q.query==="SELECT Name FROM Account"&&q.coverage==="CONDITIONAL_FRAMEWORK_CONTEXT"),JSON.stringify(result));
  const unreachable=batch.replace("return this.fetch();","if(false){return this.fetch();}return Database.getQueryLocator('SELECT Id FROM Account');");
  const rejected=await scan([{filePath:"Work.cls",source:unreachable}],"Work.cls");
  assert.ok(!rejected.queries.some(q=>q.query==="SELECT Name FROM Account"),JSON.stringify(rejected));
});
