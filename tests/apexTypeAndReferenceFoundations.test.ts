import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexAnalysisEngine,analyzeApexInvocations} from "../src/core/apex/ApexAnalysisEngine.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {ApexInstanceIndex} from "../src/core/apex/ApexInstanceModel.js";
import {canonicalApexType,selectApexOverload} from "../src/core/apex/ApexTypeSystem.js";
import {apexSymbols} from "../src/core/apex/ApexSymbolTable.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";

const selector=(name:string)=>name==="Inspector.inspect"?{method:name,argumentIndices:[0]}:undefined;
test("canonical types preserve nested generics and array aliases; exact overloads reject ambiguous null",()=>{
  assert.equal(canonicalApexType("Map<Id, List<Account[]>>"),"map<id,list<list<account>>>");
  assert.equal(canonicalApexType("String []"),"list<string>");
  assert.equal(canonicalApexType("Map<Id>"),undefined);
  const a={parameters:["v"],parameterTypes:["String"]};
  const b={parameters:["v"],parameterTypes:["Object"]};
  assert.equal(selectApexOverload([a,b],1,["string"]),a);
  assert.equal(selectApexOverload([a,b],1,["Object"]),b);
  assert.equal(selectApexOverload([a,b],1,["null"]),undefined);
  assert.equal(selectApexOverload([a,b],1,[undefined]),undefined);
});
test("lexical declarations and nested block lifetimes determine argument type",()=>{
  const source="public class C {public static void run(String name){ {Integer n=1;Inspector.inspect(n);} Inspector.inspect(name);} }";
  const methods=indexApexMethods(source),method=methods.find(m=>m.name==="run")!;
  const symbols=apexSymbols(source,methods);
  assert.equal(symbols.lookup(method,"N",source.indexOf("Inspector.inspect(n)")),"integer");
  assert.equal(symbols.lookup(method,"n",source.indexOf("Inspector.inspect(name)")),undefined);
  assert.equal(symbols.lookup(method,"NAME",source.indexOf("Inspector.inspect(name)")),"string");
});
test("same-arity method overloads use declared types rather than runtime values",()=>{
  const source="public class C {public static void run(){Object x='Account';String y='Contact';Inspector.inspect(choose(x));Inspector.inspect(choose(y));Inspector.inspect(choose(null));}private static String choose(Object v){return 'Object';}private static String choose(String v){return 'String';}}";
  const report=analyzeApexInvocations(source,"C.cls",selector);
  const captures=report.sites.map(s=>report.captures.get(s.offset)?.[0]?.query);
  assert.deepEqual(captures.slice(0,2),[textValue("Object"),textValue("String")]);
  assert.equal(captures[2]?.kind,"unknown");
});
test("cross-class overloads and private caller indexing retain source signatures",async()=>{
  const caller="public class C { public static void run(){String x='Account';Inspector.inspect(Helper.build(x));Inspector.inspect(Helper.build(new List<String>{'Id'}));} }";
  const helper="public class Helper { public static String build(String x){return 'string';} public static String build(List<String> x){return 'list';} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"C.cls",source:caller},{filePath:"Helper.cls",source:helper}]);
  const result=await new ApexAnalysisEngine(index).analyzeInvocations(caller,"C.cls",selector);
  assert.deepEqual(result.sites.map(s=>result.captures.get(s.offset)?.[0]?.query),[textValue("string"),textValue("list")]);
});
test("constructor overload and this delegation use declared source signatures",async()=>{
  const source="public class Builder {public String field;public Builder(){this('Name');}public Builder(String v){this.field=v;}public Builder(Integer v){this.field='Id';}public static void run(){String a='Name';Builder one=new Builder(a);Builder two=new Builder(1);Builder three=new Builder();Inspector.inspect(one.field);Inspector.inspect(two.field);Inspector.inspect(three.field);} }";
  const index=new ApexRepositoryMethodIndex([{filePath:"Builder.cls",source}]);
  const result=await new ApexAnalysisEngine(index).analyzeInvocations(source,"Builder.cls",selector);
  assert.deepEqual(result.sites.map(s=>result.captures.get(s.offset)?.[0]?.query),["Name","Id","Name"].map(textValue));
  const instances=new ApexInstanceIndex([{filePath:"Builder.cls",source}]);
  assert.equal(instances.construct("Builder",[{kind:"null"}],"Builder.cls",undefined,["null"])?.kind,"unknown");
});
test("nested object collection aliases survive a supported private helper mutation",async()=>{
  const source=[
    "public class Builder {",
    " public class Config {public String field='Name';public List<String> cols=new List<String>{'Id'};}",
    " public class Wrapper {public Config config=new Config();}",
    " public static void run(){Wrapper a=new Wrapper();Wrapper b=a;List<String> cols=a.config.cols;Wrapper separate=new Wrapper();updateConfig(b);Inspector.inspect(a.config.field);Inspector.inspect(String.join(cols,','));Inspector.inspect(String.join(separate.config.cols,','));}",
    " private static void updateConfig(Wrapper input){input.config.field='Phone';input.config.cols.add('Name');}",
    "}"
  ].join("\n");
  const index=new ApexRepositoryMethodIndex([{filePath:"Builder.cls",source}]);
  const result=await new ApexAnalysisEngine(index).analyzeInvocations(source,"Builder.cls",selector);
  assert.deepEqual(result.sites.map(s=>result.captures.get(s.offset)?.[0]?.query),["Phone","Id,Name","Id"].map(textValue),JSON.stringify([...result.failures]));
});
test("unknown or divergent instance effects never produce a complete stale query",async()=>{
  const source="public class Builder {public class Config {public String field='Id';}public static void run(Boolean flag){Config c=new Config();change(c,flag);Database.query('SELECT '+c.field+' FROM Account');}private static void change(Config c,Boolean flag){if(flag){c.field='Name';}else{c.field='Phone';}}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"Builder.cls",source}]);
  const report=await new ApexAnalysisEngine(index).analyze("Builder.cls",ctx=>extractDynamicSoqlQueries(source,"Builder.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(report.queries.length,0);
  assert.equal(report.unresolved.length,1);
});

test("private overload caller closure uses the matching declaration, not another overload",async()=>{
  const source="public class C {public static void run(){execute('Name');execute(new List<String>{'Phone'});}private static void execute(String field){Database.query('SELECT '+field+' FROM Account');}private static void execute(List<String> fields){Database.query('SELECT '+String.join(fields,',')+' FROM Contact');}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"C.cls",source}]);
  const report=await new ApexAnalysisEngine(index).analyze("C.cls",ctx=>extractDynamicSoqlQueries(source,"C.cls",ctx.resolveExternal,ctx.repositoryIndex));
  assert.equal(report.unresolved.length,0,JSON.stringify(report.unresolved));
  assert.deepEqual(report.queries.map(q=>q.query),["SELECT Name FROM Account","SELECT Phone FROM Contact"]);
});
test("outer class static calls never dispatch to a nested class method of the same name",async()=>{
  const caller="public class C {public static void run(){Inspector.inspect(Helper.build('Name'));}}";
  const helper="public class Helper {public class Nested {public static String build(String v){return 'Nested';}}public static String build(String v){return 'Outer';}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"C.cls",source:caller},{filePath:"Helper.cls",source:helper}]);
  const report=await new ApexAnalysisEngine(index).analyzeInvocations(caller,"C.cls",selector);
  assert.deepEqual(report.captures.get(report.sites[0].offset)?.[0]?.query,textValue("Outer"));
});
