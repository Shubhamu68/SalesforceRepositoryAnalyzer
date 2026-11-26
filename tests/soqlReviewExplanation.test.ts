import assert from "node:assert/strict";
import {test} from "node:test";
import {explainSoqlReview} from "../src/analyzer/soqlReviewExplanation.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";

test("report describes recovered evidence without repeating obsolete forward blockers",()=>{
 const reason=explainSoqlReview({reason:"Could not build the full query: String.join collection unknown. "+"Old cause ".repeat(100),aggregatedPermissionInventories:3,recoveredClauses:["SELECT","ORDER BY"]});
 assert.equal(reason,"Known SELECT / ORDER BY references recovered (3 inventories). Full runtime query and effective enforcement remain unverified.");
 assert.doesNotMatch(reason,/String\.join|Old cause|Placeholder/);
});
test("review explanation preserves conflict, limit, runtime field coverage and specific dependency",()=>{
 assert.equal(explainSoqlReview({reason:"old",conflict:"Security-mode conflict."}),"Security-mode conflict.");
 assert.equal(explainSoqlReview({reason:"old",blocker:"Could not determine input values: obj (Q.cls:2).",bounded:true}),"Could not determine input values: obj (Q.cls:2). Permissions not verified. Analysis limit reached.");
 assert.equal(explainSoqlReview({reason:"old",runtimeFieldCoverage:true,partialStructureVariants:2}),"Known fields checked; additional runtime-selected fields remain unverified.");
 assert.ok(explainSoqlReview({reason:"a".repeat(1000)}).length<240);
});
test("normal scanner creates concise final report reason without opt-in trace",()=>{
 const source="public class Q { public static void run(String obj){String q='SELECT Id FROM '+obj;Database.query(q);} }";
 const index=new ApexRepositoryMethodIndex([{filePath:"Q.cls",source}]);
 const result=extractDynamicSoqlQueries(source,"Q.cls",undefined,index);
 assert.equal(result.unresolved.length,1);
 assert.match(result.unresolved[0].reportReason??"",/Could not determine input values.*obj/);
 assert.ok((result.unresolved[0].reportReason??"").length<240);
 assert.equal(result.unresolved[0].trace,undefined);
});
