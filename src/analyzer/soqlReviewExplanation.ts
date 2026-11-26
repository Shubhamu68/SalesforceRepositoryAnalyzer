/** A single final user-facing explanation. Verbose reconstruction details
 * are retained for diagnostics, never concatenated into the Excel finding.
 * Counts describe evidence, not successful query execution. */
export interface SoqlReviewEvidence {
  reason:string;
  blocker?:string;
  conflict?:string;
  knownVariants?:number;
  partialStructureVariants?:number;
  conditionalFrameworkVariants?:number;
  aggregatedPermissionInventories?:number;
  recoveredClauses?:readonly string[];
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
  const limited=e.bounded?" Analysis limit reached.":"";
  if(e.runtimeFieldCoverage)return "Known fields checked; additional runtime-selected fields remain unverified."+limited;
  if(e.aggregatedPermissionInventories){
    const n=e.aggregatedPermissionInventories;
    const known=e.recoveredClauses?.length?"Known "+e.recoveredClauses.join(" / ")+" references recovered":"Known query references recovered";
    return known+" ("+n+" "+(n===1?"inventory":"inventories")+"). Full runtime query and effective enforcement remain unverified."+limited;
  }
  if(e.knownVariants||e.partialStructureVariants||e.conditionalFrameworkVariants)
    return "Known query versions or references checked. Other runtime paths remain unverified."+limited;
  return (e.blocker??compactReason(e.reason))+" Permissions not verified."+limited;
}
