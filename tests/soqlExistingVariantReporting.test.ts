import assert from "node:assert/strict";
import {test} from "node:test";
import {applyExistingVariantReporting,applyLimitedCoverageReporting,EXISTING_VARIANT_LIMITATION,PARTIAL_REFERENCE_LIMITATION,PARTIAL_MODE_LIMITATION} from "../src/analyzer/soqlExistingVariantReporting.js";
import type {SoqlQuery} from "../src/models/SoqlQuery.js";
import type {SoqlSecurityFinding} from "../src/models/SoqlSecurityFinding.js";
import type {UnresolvedDynamicSoql} from "../src/scanner/dynamicSoqlScanner.js";
import {SoqlAnalysisService} from "../src/services/SoqlAnalysisService.js";
import type {SoqlSecurityAnalyzer} from "../src/analyzer/soqlSecurityAnalyzer.js";
import type {Persona} from "../src/models/Persona.js";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

const site:UnresolvedDynamicSoql={filePath:"Fixture.cls",lineNumber:10,siteId:"Fixture.cls@10",reason:"Other callers unverified",referenceCoverage:"PARTIAL_REFERENCES",existingQueryVariants:2};
const variants:SoqlQuery[]=["Industry","Name"].map((field,i)=>({
 filePath:site.filePath,lineNumber:site.lineNumber,querySiteId:site.siteId,queryVariantId:site.siteId+"#"+i,
 query:"SELECT "+field+" FROM Account",object:"Account",fields:[field],subqueries:[],
 securityMode:"UNSPECIFIED",withUserMode:false,dynamicOrigin:true,coverage:"KNOWN_CALLER_CONTEXT"
}));
function missing(q:SoqlQuery):SoqlSecurityFinding{return{
 filePath:q.filePath,lineNumber:q.lineNumber,queryVariantId:q.queryVariantId,query:q.query,
 object:q.object,field:q.fields[0],severity:"INFO",criticality:"Low",verificationSource:"ORG_DENIED",
 findingType:"FIELD_READ",withUserMode:false,effectiveMode:"SYSTEM_MODE",runtimeImpact:"Not enforced by query",
 reason:"Salesforce confirmed missing Read. Other callers unverified."
};}

test("scoped policy preserves unknowns, never promotes other sites or incomplete inventories",()=>{
 const denied=missing(variants[0]);
 const unrelated={...denied,queryVariantId:"Another.cls@10#0",filePath:"Another.cls"};
 const unknown:SoqlSecurityFinding={...denied,queryVariantId:variants[1].queryVariantId,
   severity:"REVIEW",criticality:"Unable to verify",verificationSource:"UNVERIFIED",reason:"Field access unavailable"};
 const result=applyExistingVariantReporting([site],variants,[denied,unrelated,unknown]);
 assert.equal(result.handledSiteIds.size,1);
 assert.equal(result.findings.length,3);
 assert.equal(result.findings[0].criticality,"High");
 assert.equal(result.findings[0].runtimeImpact,denied.runtimeImpact);
 assert.ok(result.findings[0].reason.endsWith(EXISTING_VARIANT_LIMITATION));
 assert.deepEqual(result.findings[1],unrelated);
 assert.equal(result.findings[2].criticality,"Unable to verify");
 assert.equal(denied.criticality,"Low","do not mutate shared input");
 for(const candidate of [
   {...site,existingQueryVariants:undefined,aggregatedPermissionInventories:2},
   {...site,securityModeConflict:true},
   {...site,referenceCoverage:"RUNTIME_DEPENDENT" as const},
   {...site,runtimeFieldCoverage:true}
 ]){
   const untouched=applyExistingVariantReporting([candidate],variants,[denied]);
   assert.equal(untouched.handledSiteIds.size,0);assert.deepEqual(untouched.findings,[denied]);
 }
 assert.equal(applyExistingVariantReporting([site],variants.slice(0,1),[denied]).handledSiteIds.size,0);
 assert.equal(applyExistingVariantReporting([site],[variants[0],{...variants[1],selectPrefixOnly:true}],[denied]).handledSiteIds.size,0);
});
test("an actual relationship review without variant identity prevents a false clean advisory",()=>{
 const diagnostic:SoqlSecurityFinding={...missing(variants[1]),queryVariantId:undefined,
  severity:"REVIEW",criticality:"Unable to verify",verificationSource:"UNVERIFIED",findingType:"RELATIONSHIP"};
 const result=applyExistingVariantReporting([site],variants,[diagnostic]);
 assert.equal(result.handledSiteIds.size,1);
 assert.deepEqual(result.findings,[diagnostic]);
});
test("all-personas high priority output applies the same reporting policy independently for each persona",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-existing-variants-personas-"));
 try{
  await writeFile(path.join(root,"Fixture.cls"),[
    "public class Fixture {",
    "public static void run(String f){Database.query('SELECT Id,'+f+' FROM Account');}",
    "public static void entry(){run('Industry');}",
    "}"
  ].join("\n"));
  const personas:Persona[]=["Denied","Granted","Unknown"].map(name=>({name,permissionSets:[],permissionSetGroups:[],mutingPermissionSets:[]}));
  const analyzer={prepare:async(queries:SoqlQuery[])=>queries,
    analyzePrepared:async(persona:Persona,queries:SoqlQuery[])=>{
      assert.equal(queries.length,1);
      const f={...missing(queries[0]),field:"Industry"};
      if(persona.name==="Denied")return [f];
      if(persona.name==="Unknown")return [{...f,severity:"REVIEW",criticality:"Unable to verify",verificationSource:"UNVERIFIED"}];
      return [];
    }} as unknown as SoqlSecurityAnalyzer;
  const result=await new SoqlAnalysisService(root,analyzer,path.join(root,"out")).analyzeAllHighPriority(personas);
  assert.deepEqual(result.personas.map(p=>p.highPriorityCount),[1,0,0]);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(result.reportPath);
  const sheet=workbook.getWorksheet("High Priority Summary")!;
  assert.ok(sheet.getColumn(6).values.some(v=>String(v??"").includes(EXISTING_VARIANT_LIMITATION)));
 }finally{await rm(root,{recursive:true,force:true});}
});


test("partial inventory reporting grades grants independently of mode and preserves genuinely unresolved decisions",()=>{
 const partial={...site,existingQueryVariants:undefined,aggregatedPermissionInventories:2};
 const inventories:SoqlQuery[]=variants.map(q=>({...q,coverage:"PROVEN_PARTIAL_STRUCTURE",permissionEvidence:"AGGREGATED_STRUCTURE",selectPrefixOnly:true}));
 const clean=applyLimitedCoverageReporting([partial],inventories,[]);
 assert.equal(clean.partialSiteIds.size,1);assert.equal(clean.existingSiteIds.size,0);
 assert.equal(clean.findings.length,1);
 assert.equal(clean.findings[0].criticality,"Low");
 assert.equal(clean.findings[0].effectiveMode,"UNKNOWN");
 assert.match(clean.findings[0].field,/Recovered partial references/);
 assert.ok(clean.findings[0].reason.includes(PARTIAL_REFERENCE_LIMITATION));
 assert.ok(clean.findings[0].reason.includes(PARTIAL_MODE_LIMITATION));
 const denied={...missing(inventories[0]),effectiveMode:"UNKNOWN" as const,runtimeImpact:"Undetermined" as const};
 const unknown:SoqlSecurityFinding={...missing(inventories[1]),severity:"REVIEW",criticality:"Unable to verify",verificationSource:"UNVERIFIED"};
 const result=applyLimitedCoverageReporting([partial],inventories,[denied,unknown]);
 assert.equal(result.findings.length,2);
 assert.equal(result.findings[0].criticality,"High");
 assert.equal(result.findings[0].effectiveMode,"UNKNOWN");
 assert.equal(result.findings[0].runtimeImpact,"Undetermined");
 assert.equal(result.findings[1].criticality,"Unable to verify");
 assert.ok(result.findings.every(f=>f.limitedPartialCoverage&&f.reason.includes(PARTIAL_REFERENCE_LIMITATION)));
 assert.equal(applyLimitedCoverageReporting([partial],inventories.slice(0,1),[]).handledSiteIds.size,0);
 assert.equal(applyLimitedCoverageReporting([partial],variants,[]).handledSiteIds.size,0);
 for(const candidate of [{...partial,securityModeConflict:true},{...partial,runtimeFieldCoverage:true},
  {...partial,referenceCoverage:"RUNTIME_DEPENDENT" as const},{...partial,referenceCoverage:"COMPLETE_FINITE_DOMAIN" as const}]){
   assert.equal(applyLimitedCoverageReporting([candidate],inventories,[]).handledSiteIds.size,0);
 }
});
