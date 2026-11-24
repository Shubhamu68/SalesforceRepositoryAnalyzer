import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexDataFlowEngine} from "../src/core/apex/ApexDataFlowEngine.js";
import {indexApexMethods} from "../src/core/apex/ApexSourceModel.js";
import {apexStateIdentity} from "../src/core/apex/ApexStateIdentity.js";
import {ApexExecutionBudget} from "../src/core/apex/ApexExecutionBudget.js";
import {listValue,unknown,type ApexEnvironment} from "../src/core/apex/ApexValueEvaluator.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";

test("dead root-local scalar alternatives collapse before later independent branches",()=>{
  const code=[
    "public class Builder {",
    " public static String build(Boolean first,Boolean second,Boolean third){",
    "   String one='A'; if(first){one='B';} System.debug(one);",
    "   String two='C'; if(second){two='D';} System.debug(two);",
    "   String three='E'; if(third){three='F';} System.debug(three);",
    "   return 'SELECT Id FROM Account';",
    " }",
    "}",
  ].join("\n");
  const method=indexApexMethods(code)[0];
  assert.ok(method);
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const result=engine.summarizeMethodReturn(method,[unknown("first"),unknown("second"),unknown("third")]);
  assert.deepEqual(result,{kind:"text",values:["SELECT Id FROM Account"]});
});

test("live scalar alternatives that change SELECT remain distinct",()=>{
  const code=[
    "public class Builder {",
    " public static String build(Boolean flag){",
    "   String field='Name'; if(flag){field='Phone';}",
    "   System.debug(field);",
    "   return 'SELECT Id,'+field+' FROM Account';",
    " }",
    "}",
  ].join("\n");
  const method=indexApexMethods(code)[0];
  const result=new ApexDataFlowEngine(code,{maxPaths:2}).summarizeMethodReturn(method,[unknown("flag")]);
  assert.equal(result.kind,"text");
  if(result.kind==="text")assert.deepEqual(result.values.sort(),["SELECT Id,Name FROM Account","SELECT Id,Phone FROM Account"]);
});

test("state identity distinguishes equal collection contents from shared references",()=>{
  const shared=listValue(["Id"]);
  const aliases:ApexEnvironment=new Map([["left",shared],["right",shared]]);
  const copies:ApexEnvironment=new Map([["left",listValue(["Id"])],["right",listValue(["Id"])]]);
  const otherShared=listValue(["Id"]);
  const equivalent:ApexEnvironment=new Map([["right",otherShared],["left",otherShared]]);
  assert.notEqual(apexStateIdentity(aliases,false),apexStateIdentity(copies,false));
  assert.equal(apexStateIdentity(aliases,false),apexStateIdentity(equivalent,false));
});

test("alias-sensitive branches produce both complete query variants",()=>{
  const code=[
    "public class AliasQuery {",
    " public static void run(Boolean flag){",
    "   List<String> first=new List<String>{'Id'};",
    "   List<String> second=new List<String>{'Id'};",
    "   if(flag){second=first;}",
    "   first.add('Name');",
    "   Database.query('SELECT '+String.join(second, ',')+' FROM Account');",
    " }",
    "}",
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"AliasQuery.cls");
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.deepEqual(result.queries.map(q=>q.query).sort(),["SELECT Id FROM Account","SELECT Id,Name FROM Account"]);
});

test("known foreach retains outer accumulator and excludes iteration-local bindings",()=>{
  const code=[
    "public class LoopQuery {",
    " public static void run(){",
    "   String fields='Id';",
    "   for(String item : new List<String>{'Name','Phone'}){",
    "     String local=item; fields += ','+local;",
    "   }",
    "   Database.query('SELECT '+fields+' FROM Account');",
    " }",
    "}",
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"LoopQuery.cls");
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.equal(result.queries[0].query,"SELECT Id,Name,Phone FROM Account");
});

test("shared budget distinguishes paths and operations and resets per analysis",()=>{
  const budget=new ApexExecutionBudget(2,2);
  assert.equal(budget.visit(10,"build"),true);
  assert.equal(budget.checkPaths(3,15,"build"),false);
  assert.match(budget.reason??"",/path enumeration.*3\/2.*build.*15/);
  budget.reset();
  assert.equal(budget.visit(20,"run"),true);
  assert.equal(budget.visit(21,"run"),true);
  assert.equal(budget.visit(22,"run"),false);
  assert.match(budget.reason??"",/operation budget.*3\/2.*run.*22/);
});

test("malformed SELECT is never repaired; report original punctuation with literals masked",()=>{
  const code=[
    "public class InvalidQuery {",
    " public static void run(){",
    "   String q='SELECT Id, FROM Account WHERE Name = \\'private value\\'';",
    "   Database.query(q);",
    " }",
    "}",
  ].join("\n");
  const result=extractDynamicSoqlQueries(code,"InvalidQuery.cls");
  assert.equal(result.queries.length,0);
  assert.equal(result.unresolved.length,1);
  assert.match(result.unresolved[0].reason,/Reconstructed query structure.*SELECT Id, FROM Account/);
  assert.doesNotMatch(result.unresolved[0].reason,/private value/);
});


test("terminated paths do not consume the live frontier budget or lose return alternatives",()=>{
  const code=[
    "public class Builder {",
    " public static String build(Boolean a,Boolean b,Boolean c){",
    "   String name='Account';",
    "   if(a){name='Contact';return 'SELECT Id FROM Contact';}",
    "   if(b){name='Case';return 'SELECT Id FROM Contact';}",
    "   if(c){name='Opportunity';return 'SELECT Id FROM Contact';}",
    "   return 'SELECT Id FROM '+name;",
    " }",
    "}",
  ].join("\n");
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const method=indexApexMethods(code)[0];
  const result=engine.summarizeMethodReturn(method,[unknown("a"),unknown("b"),unknown("c")]);
  assert.equal(result.kind,"text");
  if(result.kind==="text")assert.deepEqual(result.values.sort(),["SELECT Id FROM Account","SELECT Id FROM Contact"]);
});


test("repeated immutable Boolean guards preserve correlated paths without increasing the path budget",()=>{
  const code="public class Builder { public static String build(Boolean full){ String fields='Id'; String obj='Account'; if(full){fields='Name';} if(full){obj='Contact';} return 'SELECT '+fields+' FROM '+obj; } }";
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const method=indexApexMethods(code)[0];
  const result=engine.summarizeMethodReturn(method,[unknown("runtime")]);
  assert.equal(result.kind,"text");
  if(result.kind==="text")assert.deepEqual(result.values.sort(),["SELECT Id FROM Account","SELECT Name FROM Contact"]);
});

test("guard refinement is not reused when a parameter is reassigned",()=>{
  const code="public class Builder { public static String build(Boolean full){ String fields='Id'; if(full){fields='Name';} full=false; if(full){fields='Email';} return 'SELECT '+fields+' FROM Account'; } }";
  const engine=new ApexDataFlowEngine(code,{maxPaths:2});
  const result=engine.summarizeMethodReturn(indexApexMethods(code)[0],[unknown("runtime")]);
  assert.equal(result.kind,"text");
  if(result.kind==="text")assert.deepEqual(result.values.sort(),["SELECT Id FROM Account","SELECT Name FROM Account"]);
});
