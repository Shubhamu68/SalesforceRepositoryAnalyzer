import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import {captureVerificationUsers,noteVerificationEvidence,verificationUserLabel} from "../src/services/SoqlVerificationProvenance.js";
import {OrgObjectReadVerificationService} from "../src/services/OrgObjectReadVerificationService.js";
import type {SalesforcePersonaAccessVerifier,OrgObjectAccessEvidence} from "../src/salesforce/SalesforcePersonaAccessVerifier.js";
import type {OrgVerificationStatusPolicy} from "../src/config/orgVerificationStatusPolicy.js";
import type {Persona} from "../src/models/Persona.js";
import {writeSoqlReport,writeAllPersonasHighPriorityReport} from "../src/reporter/soqlReportWriter.js";
import { SALESFORCE_HTTP_READ_CONCURRENCY, SALESFORCE_VERIFICATION_CONCURRENCY, ALL_PERSONAS_CONCURRENCY } from "../src/config/salesforceConcurrency.js";
const user=(id:string)=>({id,name:"Fixture "+id,username:id+"@example.invalid"});
function evidence(id:string):OrgObjectAccessEvidence{return{object:"Account",outcome:"VERIFIED",matchedUsers:1,checkedUsers:1,sampled:false,checkedUserDetails:[user(id)],message:"Fixture"};}
test("verification provenance includes consumed cache hits and isolates concurrent reports",async()=>{
 const persona:Persona={name:"A",permissionSets:[],permissionSetGroups:[],mutingPermissionSets:[]};
 let requests=0;
 const verifier={getVerificationScope:()=>"fixture-org",verifyObjectRead:async()=>{requests++;return evidence("A");}} as unknown as SalesforcePersonaAccessVerifier;
 const gateway=new OrgObjectReadVerificationService({} as OrgVerificationStatusPolicy,verifier);
 // No capture was active during the original request.
 await gateway.verifyObject(persona,"Account");
 const [a,b]=await Promise.all([
  captureVerificationUsers(async()=>{await gateway.verifyObject(persona,"Account");await gateway.verifyObject(persona,"Account");return 42;}),
  captureVerificationUsers(async()=>{noteVerificationEvidence(evidence("B"));noteVerificationEvidence({...evidence("C"),checkedUsers:0});})
 ]);
 assert.equal(requests,1);assert.deepEqual(a.users,[user("A")]);assert.equal(a.result,42);
 assert.deepEqual(b.users,[user("B")]);
 const multiple=await captureVerificationUsers(async()=>{noteVerificationEvidence(evidence("A"));noteVerificationEvidence(evidence("B"));});
 assert.match(verificationUserLabel(multiple.users),/Multiple users used/);
});
test("verification users appear in actual single and all-persona workbooks, even with no findings",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-user-provenance-"));
 try{
  const a=await writeSoqlReport(root,"A",2,[],[user("A")]);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(a.summaryReportPath);
  const sheet=workbook.getWorksheet("Summary")!;
  assert.equal(sheet.getCell("A5").value,"User used for verification from org");
  assert.equal(sheet.getCell("B5").value,"Fixture A (A@example.invalid)");
  assert.equal(sheet.getCell("H7").value,"Effective Query Mode");
  assert.equal(sheet.views[0]?.ySplit,7);
  const b=await writeAllPersonasHighPriorityReport(root,[
   {personaName:"A",queryCount:2,findings:[],verificationUsers:[user("A")]},
   {personaName:"B",queryCount:2,findings:[],verificationUsers:[]},
  ]);
  await workbook.xlsx.readFile(b.summaryReportPath);
  const high=workbook.getWorksheet("High Priority Summary")!;
  const labels=high.getColumn(2).values.map(v=>String(v??""));
  assert.ok(labels.includes("Fixture A (A@example.invalid)"));
  assert.ok(labels.some(v=>v.includes("No Salesforce user verified")));
 }finally{await rm(root,{recursive:true,force:true});}
});
test("release concurrency constants match the validated benchmark",()=>{
 assert.equal(SALESFORCE_HTTP_READ_CONCURRENCY,6);
 assert.equal(SALESFORCE_VERIFICATION_CONCURRENCY,5);
 assert.equal(ALL_PERSONAS_CONCURRENCY,2);
});
