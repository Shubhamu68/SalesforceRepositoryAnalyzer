import assert from "node:assert/strict";
import {test} from "node:test";
import {explainSoqlReview} from "../src/analyzer/soqlReviewExplanation.js";
import {needsDynamicCoverageReview} from "../src/analyzer/soqlReferenceCoverage.js";
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
 assert.equal(result.unresolved[0].referenceCoverage,"RUNTIME_DEPENDENT");
 assert.match(result.unresolved[0].reportReason??"",/OLS\/FLS.*runtime inputs/);
 assert.ok((result.unresolved[0].reportReason??"").length<240);
 assert.equal(result.unresolved[0].trace,undefined);
});


test("clause-specific report distinguishes known sort and unknown predicates",()=>{
 assert.equal(explainSoqlReview({reason:"old",aggregatedPermissionInventories:3,recoveredClauses:["SELECT","ORDER BY"],unknownWhere:true}),"Known SELECT / ORDER BY references recovered (3 inventories). Runtime WHERE and effective enforcement remain unverified.");
});

test("complete finite source domains remove only redundant coverage reviews",()=>{
 const source="public class Q {public static void run(String typeName){try{String q='';if(typeName=='A'){q='SELECT Id,Name FROM Account WHERE Id=:rid';}else if(typeName=='C'){q='SELECT Id,Email FROM Contact WHERE Id=:rid';}q+=' WITH SECURITY_ENFORCED';Database.query(q);}catch(Exception e){System.debug(e);}}}";
 const result=extractDynamicSoqlQueries(source,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source}]));
 const site=result.unresolved[0];
 assert.equal(site.referenceCoverage,"COMPLETE_FINITE_DOMAIN",JSON.stringify(site));
 assert.deepEqual(site.finiteCoverage,{alternatives:2,inventories:2,invalidAlternatives:1});
 assert.equal(needsDynamicCoverageReview(site,result.queries),false);
 assert.equal(needsDynamicCoverageReview(site,result.queries.slice(0,1)),true);
 assert.equal(needsDynamicCoverageReview({...site,securityModeConflict:true},result.queries),true);
 const mutation=source.replace("q+=' WITH SECURITY_ENFORCED';","q+=runtimeSuffix();");
 const incomplete=extractDynamicSoqlQueries(mutation,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source:mutation}]));
 assert.ok(incomplete.unresolved.every(s=>needsDynamicCoverageReview(s,incomplete.queries)));
});
test("switch domain certificate excludes only guard-terminated null branch",()=>{
 const source="public class Q {private Integer step=1;private Date startDate;public void run(){String q=byStep(step);if(String.isBlank(q)||this.startDate==null){return;}Database.query(q);}private String byStep(Integer n){String suffix=' WHERE Id=:rid';switch on n{when 1{return 'SELECT Id FROM Account'+suffix;}when 2{return 'SELECT Id FROM Contact'+suffix;}when else{return null;}}}}";
 const result=extractDynamicSoqlQueries(source,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source}]));
 // Force mutable selector state; exact forward resolutions need no review.
 const mutable=source.replace("public void run()","public void setStep(Integer n){step=n;}public void run()");
 const scan=extractDynamicSoqlQueries(mutable,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source:mutable}]));
 assert.ok(result.queries.length);
 assert.equal(scan.unresolved[0]?.referenceCoverage,"COMPLETE_FINITE_DOMAIN",JSON.stringify(scan.unresolved));
 assert.equal(needsDynamicCoverageReview(scan.unresolved[0],scan.queries),false);
 const bad=mutable.replace("if(String.isBlank(q)||this.startDate==null){return;}","");
 const rejected=extractDynamicSoqlQueries(bad,"Q.cls",undefined,new ApexRepositoryMethodIndex([{filePath:"Q.cls",source:bad}]));
 assert.ok(rejected.unresolved.every(s=>needsDynamicCoverageReview(s,rejected.queries)));
});
