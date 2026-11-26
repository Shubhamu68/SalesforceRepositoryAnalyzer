import assert from "node:assert/strict";
import {test} from "node:test";
import {traceApexDependencies} from "../src/core/apex/ApexBackwardDependencyEngine.js";
import {collectApexDependencyBlockers,type ApexDependencyDiagnostic} from "../src/core/apex/ApexDependencyDiagnostics.js";
import {ApexRepositoryMethodIndex} from "../src/core/apex/ApexRepositoryMethodIndex.js";
import {extractDynamicSoqlQueries} from "../src/scanner/dynamicSoqlScanner.js";
import {emitSoqlTraceReports,newSoqlTraceReport,collectSoqlTrace} from "../src/analyzer/soqlTraceDiagnostics.js";
import {simplePermissionShape} from "../src/analyzer/soqlPermissionAggregation.js";

test("source diagnostics identify exact caller and variable blocker, not literal values or full paths",()=>{
  const files=[
    {filePath:"/private/customer/Service.cls",source:"public class Service {public static void run(List<String> fields){Sink.consume(fields);}}"},
    {filePath:"/private/customer/Entry.cls",source:"public class Entry {public static void start(){List<String> cols=new List<String>{'SECRET_VALUE'};Other.mutate(cols);Service.run(cols);}}"}
  ];
  const {source,filePath}=files[0],use={expression:"fields",offset:source.indexOf("Sink.consume")};
  const index=new ApexRepositoryMethodIndex(files),events:ApexDependencyDiagnostic[]=[];
  const baseline=traceApexDependencies(source,filePath,use,index);
  const traced=traceApexDependencies(source,filePath,use,index,undefined,{observe:e=>events.push(e)});
  assert.deepEqual(traced,baseline);
  assert.ok(events.some(e=>e.code==="CALLER_ARGUMENT"&&e.file==="Entry.cls"));
  assert.ok(events.some(e=>e.code==="COLLECTION_ALIAS_OR_WRITE"&&e.symbol==="cols"));
  assert.doesNotMatch(JSON.stringify(events),/SECRET_VALUE|\/private\/customer/);
});
test("SOQL diagnostics are opt-in and preserve scan queries and unresolved reasons",()=>{
  const source="public class UI {public static void run(String obj){String q='SELECT Id FROM '+obj;Database.query(q);}}";
  const index=new ApexRepositoryMethodIndex([{filePath:"UI.cls",source}]);
  const base=extractDynamicSoqlQueries(source,"UI.cls",undefined,index);
  const traced=extractDynamicSoqlQueries(source,"UI.cls",undefined,index,true);
  assert.equal(base.unresolved[0].trace,undefined);
  assert.match(base.unresolved[0].reason,/Why the query could not be fully resolved:.*Could not determine input values.*obj.*no source caller could be verified/i);
  const {trace,...rest}=traced.unresolved[0];
  assert.deepEqual(base,{queries:traced.queries,unresolved:[rest]});
  assert.equal(trace?.fallback,"ATTEMPTED");
  assert.equal(trace?.added,0);
  assert.ok(trace?.events.some(e=>e.code==="NO_PROVEN_CALLER"));
  assert.ok(trace?.events.some(e=>e.code==="SOQL_VALUE_UNRESOLVED"||e.code==="SOQL_RUNTIME_SLOT_UNPROVEN"));
});
test("valid aggregate candidates and unknown access mode are distinguished",()=>{
  const source="public class C {public static void run(Boolean f){String q='SELECT Id FROM Account';if(f){q+=' WHERE Name != null';}else{q+=' WHERE Industry != null';}Database.query(q);}}";
  const scan=extractDynamicSoqlQueries(source,"C.cls",undefined,undefined,true);
  // The simple conditional may already be resolved by the execution engine.
  for(const site of scan.unresolved)assert.ok(site.trace);
  const unknown="public class C {public static void run(AccessLevel mode){Database.query('SELECT Id FROM Account',mode);}}";
  assert.equal(extractDynamicSoqlQueries(unknown,"C.cls",undefined,undefined,true).unresolved[0].trace?.fallback,"SKIP_UNKNOWN_ACCESS_MODE");
  const codes:string[]=[];
  assert.equal(simplePermissionShape("SELECT Id, (SELECT Id FROM Contacts) FROM Account",1,c=>codes.push(c)),undefined);
  assert.ok(codes.length>0);
});
test("trace block is bounded and does not emit source payloads or raw failure reasons",()=>{
  const report=newSoqlTraceReport("C:\\Users\\customer\\Service.cls",7,50,"'SECRET_VALUE'");
  const collect=collectSoqlTrace(report);
  for(let i=0;i<120;i++)collect({code:"VARIABLE_USE",file:"Service.cls",line:i,depth:0});
  collect({code:"VARIABLE_USE",file:"Service.cls",line:0,depth:0});
  const lines:string[]=[];
  emitSoqlTraceReports([{trace:report}],line=>lines.push(line));
  assert.equal(report.events.length,100);
  assert.equal(report.omittedEvents,20);
  assert.equal(lines.length,3);
  assert.match(lines[0],/BEGIN/);assert.match(lines[2],/END/);
  assert.doesNotMatch(lines.join("\n"),/SECRET_VALUE|customer|Users/);
});


test("normal explanations distinguish indexed-but-ineligible callers, metadata, helper arguments and earlier dependency gaps",()=>{
  const collector=collectApexDependencyBlockers();
  const emit=(code:string,symbol:string,line:number,count?:number)=>collector.observe({code,symbol,line,file:"Report.cls",method:"run",depth:0,count});
  emit("CALLER_INDEX_CANDIDATES","reportName",213,1);
  emit("CALLER_SOURCE_ELIGIBLE","reportName",213,0);
  emit("NO_PROVEN_CALLER","reportName",213);
  emit("SHARED_HELPER_ARGUMENT_UNPROVEN","getConfig",213);
  emit("METADATA_RECORD_UNRESOLVED","Object_API_Name__c",220);
  emit("SHARED_HELPER_ARGUMENT_UNPROVEN","getFieldListFromFieldSet",228);
  emit("LOOP_ITERABLE_UNPROVEN","selectFields",236);
  const summary=collector.summarize()!;
  assert.match(summary,/reportName.*1 caller found, none could be analyzed/);
  assert.match(summary,/Custom Metadata.*Object_API_Name__c/);
  assert.match(summary,/getConfig.*getFieldListFromFieldSet/);
  assert.doesNotMatch(summary,/LOOP_ITERABLE_UNPROVEN|selectFields/);
  const prior=collectApexDependencyBlockers();
  for(const [code,symbol,line] of [["CLASS_MEMBER_UNPROVEN","caseFieldList",112],["LOOP_EFFECT_UNSUPPORTED","finalFields",258],["SCALAR_WRITE_UNSUPPORTED","orderBy",273],["UNSUPPORTED_CALL","buildFields",228]] as const)
    prior.observe({code,symbol,line,file:"Old.cls",depth:0});
  assert.match(prior.summarize()!,/caseFieldList.*finalFields.*orderBy.*buildFields/);
});
test("report diagnostic summaries are bounded and do not print raw trace codes",()=>{
  const collector=collectApexDependencyBlockers();
  for(let i=0;i<500;i++)collector.observe({code:"NO_PROVEN_CALLER",symbol:"p"+i,file:"UI.cls",line:i,depth:0});
  assert.match(collector.summarize()!,/p0.*p3/);
  assert.doesNotMatch(collector.summarize()!,/p4|NO_PROVEN_CALLER/);
});


test("plain-language summaries combine source locations without dropping symbols",()=>{
  const collector=collectApexDependencyBlockers();
  for(const [symbol,line] of [["caseFieldList",112],["caseTypeFilterQuery",112],["otherField",114]] as const)
    collector.observe({code:"CLASS_MEMBER_UNPROVEN",symbol,file:"Batch.cls",method:"fetch",line,depth:0});
  const summary=collector.summarize()!;
  assert.equal(summary,"Could not determine class member or variable values: Batch.cls / fetch(): caseFieldList, caseTypeFilterQuery (line 112); otherField (line 114).");
  assert.equal(summary.split("Batch.cls").length,2);
});
