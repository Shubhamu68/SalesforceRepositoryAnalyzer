import assert from "node:assert/strict";
import {test} from "node:test";
import {explainUncapturedApexQuery} from "../src/core/apex/ApexExecutionPathDiagnostics.js";

test("v0.1.1 fallback points to known loop-mutated query dependency",()=>{
  const source=[
    "public class ReconHelper {",
    " public static void process(List<String> fields){",
    "   String soql='SELECT Id';",
    "   for(String f: fields){",
    "     soql += ', '+f;",
    "   }",
    "   Database.query(soql);",
    " }",
    "}",
  ].join("\n");
  const offset=source.indexOf("Database.query");
  assert.match(explainUncapturedApexQuery(source,offset,"soql"),/loop.*soql|soql.*loop/i);
});

test("v0.1.1 fallback distinguishes a recognized method without loop dependencies",()=>{
  const source=[
    "public class Helper {",
    " public static void run(String q){",
    "   Database.query(q);",
    " }",
    "}",
  ].join("\n");
  assert.match(explainUncapturedApexQuery(
    source,source.indexOf("Database.query"),"q"),/method run/i);
});

test("v0.1.1 fallback does not claim an anonymous or out-of-scope call is resolved",()=>{
  const source="Database.query('SELECT Id FROM Account');";
  assert.match(explainUncapturedApexQuery(
    source,source.indexOf("Database.query"),"'SELECT Id FROM Account'"),
    /not inside a fully indexed Apex method/i);
});
