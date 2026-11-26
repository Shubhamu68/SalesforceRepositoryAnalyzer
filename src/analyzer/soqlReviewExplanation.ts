import type {SoqlReferenceCoverage,FinitePermissionCoverage} from "./soqlReferenceCoverage.js";
/** A single final user-facing explanation. Verbose reconstruction details
 * are retained for diagnostics, never concatenated into the Excel finding.
 * Counts describe evidence, not successful query execution. */
export interface SoqlReviewEvidence {
  reason:string;
  referenceCoverage?:SoqlReferenceCoverage;
  finiteCoverage?:FinitePermissionCoverage;
  blocker?:string;
  conflict?:string;
  knownVariants?:number;
  partialStructureVariants?:number;
  conditionalFrameworkVariants?:number;
  aggregatedPermissionInventories?:number;
  recoveredClauses?:readonly string[];
  unknownWhere?:boolean;
  unknownOrder?:boolean;
  incompleteSelect?:boolean;
  runtimeFieldCoverage?:boolean;
  bounded?:boolean;
}
function compactReason(reason:string):string{
  const cleaned=reason.split(" Reconstructed query structure (")[0]
    .split(" Partial expression evidence:")[0].replace(/\s+/g," ").trim();
  return cleaned.length>200?cleaned.slice(0,197).trimEnd()+"...":cleaned.replace(/[.]$/,"")+".";
}
export function explainSoqlReview(e:SoqlReviewEvidence):string{
  if(e.conflict)return e.conflict;
  if(e.referenceCoverage==="COMPLETE_FINITE_DOMAIN"&&e.finiteCoverage){
    const f=e.finiteCoverage;
    return `All ${f.alternatives} source-defined query alternatives are covered by ${f.inventories} permission inventories. The executed query depends on runtime input.${f.invalidAlternatives?" A non-query alternative was excluded.":""}`;
  }
  if(e.referenceCoverage==="RUNTIME_DEPENDENT")return "OLS/FLS could not be fully verified because the dynamic query’s object or field references depend on runtime inputs.";
  if(e.referenceCoverage==="METADATA_OR_HELPER_UNAVAILABLE")return "OLS/FLS could not be fully verified because required metadata or a helper result could not be resolved.";
  const limited=e.bounded?" Analysis limit reached.":"";
  if(e.runtimeFieldCoverage)return "Known fields checked; additional runtime-selected fields remain unverified."+limited;
  if(e.aggregatedPermissionInventories){
    const n=e.aggregatedPermissionInventories;
    const known=e.recoveredClauses?.length?"Known "+e.recoveredClauses.join(" / ")+" references recovered":"Known query references recovered";
    const clauses=[...(e.incompleteSelect?["additional SELECT fields"]:[]),...(e.unknownWhere?["runtime WHERE"]:[]),...(e.unknownOrder?["ORDER BY"]:[])];
    const remaining=clauses.length?clauses.join(", ").replace(/^./,c=>c.toUpperCase())+" and effective enforcement remain unverified.":"Full runtime query and effective enforcement remain unverified.";
    if(e.referenceCoverage==="PARTIAL_REFERENCES")return known+". "+(clauses.length?remaining:"Other runtime query references or effective enforcement are not fully verified.")+limited;
    return known+" ("+n+" "+(n===1?"inventory":"inventories")+"). "+remaining+limited;
  }
  if(e.knownVariants||e.partialStructureVariants||e.conditionalFrameworkVariants)
    return "Known query versions or references checked. Other runtime paths remain unverified."+limited;
  return (e.blocker??compactReason(e.reason))+" Permissions not verified."+limited;
}
