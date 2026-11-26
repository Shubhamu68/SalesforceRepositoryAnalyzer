import path from "node:path";
import type {SoqlQuery} from "../models/SoqlQuery.js";
import type {SoqlSecurityFinding} from "../models/SoqlSecurityFinding.js";
import type {UnresolvedDynamicSoql} from "../scanner/dynamicSoqlScanner.js";

/** Shared reporting policy for limited query evidence, not an exhaustive
 * coverage certificate and not a new OLS/FLS evaluation mechanism. */
export const EXISTING_VARIANT_LIMITATION="All recovered query variants were analyzed; additional runtime-dependent variants may exist.";

export const PARTIAL_REFERENCE_LIMITATION="Permission analysis is limited to recovered object and field references. Additional runtime-dependent references may exist that could not be analyzed.";
export const PARTIAL_MODE_LIMITATION="The effective query mode is not verified for the partial structure.";

export function applyLimitedCoverageReporting(
  sites:readonly UnresolvedDynamicSoql[],
  queries:readonly SoqlQuery[],
  findings:readonly SoqlSecurityFinding[],
  includePartial=true,
):{findings:SoqlSecurityFinding[];handledSiteIds:Set<string>;existingSiteIds:Set<string>;partialSiteIds:Set<string>}{
  const bySite=new Map<string,SoqlQuery[]>();
  for(const q of queries){
    if(!q.querySiteId)continue;
    const items=bySite.get(q.querySiteId)??[];
    items.push(q);bySite.set(q.querySiteId,items);
  }
  const handledSiteIds=new Set<string>(),existingSiteIds=new Set<string>(),partialSiteIds=new Set<string>();
  const result=[...findings];
  for(const site of sites){
    if(site.referenceCoverage!=="PARTIAL_REFERENCES"||site.securityModeConflict||
      !site.siteId||site.runtimeFieldCoverage)continue;
    const existing=!!site.existingQueryVariants;
    const partial=!existing&&includePartial&&!!site.aggregatedPermissionInventories;
    if(!existing&&!partial)continue;
    const variants=bySite.get(site.siteId)??[];
    // Only accepted, identified inventories passed to the evaluator qualify.
    // Preserve the earlier existing-variant policy. For a partial inventory
    // a proven prefix is sufficient for grants, not for effective mode.
    if(variants.length!==(site.existingQueryVariants??0)+(site.aggregatedPermissionInventories??0)||
      variants.some(q=>!q.queryVariantId||q.runtimeFieldCoverage||
        (existing&&q.selectPrefixOnly)||
        (partial&&(q.permissionEvidence!=="AGGREGATED_STRUCTURE"||q.coverage!=="PROVEN_PARTIAL_STRUCTURE")))||
      new Set(variants.map(q=>q.queryVariantId)).size!==variants.length)continue;
    const caveat=existing?EXISTING_VARIANT_LIMITATION:PARTIAL_REFERENCE_LIMITATION;
    const modeCaveat=partial&&variants.some(q=>q.selectPrefixOnly)?" "+PARTIAL_MODE_LIMITATION:"";
    const coverageFlag=existing?{limitedVariantCoverage:true}:{limitedPartialCoverage:true};
    const ids=new Set(variants.map(q=>q.queryVariantId));
    const texts=new Set(variants.map(q=>q.query));
    let hasDenial=false,hasUnverified=false;
    for(let i=0;i<findings.length;i++){
      const original=findings[i];
      const exact=original.queryVariantId!==undefined&&ids.has(original.queryVariantId);
      // Older parser/relationship reviews may lack variant IDs. Keep
      // their uncertainty and conservatively prevent a clean advisory
      // if the query text or source location matches. Never promote a
      // denial by ambiguous file/line matching.
      const possible=!original.queryVariantId&&original.filePath===site.filePath&&
        (texts.has(original.query)||original.lineNumber===site.lineNumber);
      if(!exact&&!possible)continue;
      const permission=original.findingType==="FIELD_READ"||original.findingType==="OBJECT_READ";
      const denied=permission&&original.verificationSource==="ORG_DENIED";
      if(denied)hasDenial=true;
      if(original.severity==="REVIEW"||original.criticality==="Unable to verify"||
        original.verificationSource==="UNVERIFIED")hasUnverified=true;
      if(!exact)continue;
      // Confirmed grants/denials are still sourced exclusively from the
      // existing persona evaluator. High here means a confirmed missing
      // Read permission, NOT necessarily a runtime exception.
      const reason=original.reason.replace(/ (?:Other callers unverified|Actual job state unverified|Partial query coverage only)\.$/,"");
      result[i]={...original,
        ...(denied?{severity:"ERROR",criticality:"High"} as const:{}),
        ...coverageFlag,
        reason:reason+" "+caveat+modeCaveat};
    }
    // Do not emit a clean advisory if an actual permission or parser
    // decision is unknown. Its specific Unable to verify row remains.
    if(!hasDenial&&!hasUnverified){
      const roots=[...new Set(variants.map(q=>q.object))];
      const modes=[...new Set(variants.map(q=>q.dynamicAccessLevel??q.securityMode))];
      result.push({
        severity:"INFO",criticality:"Low",verificationSource:"UNVERIFIED",findingType:"PARSER",
        filePath:site.filePath,lineNumber:site.lineNumber,queryVariantId:site.siteId,
        object:roots.length===1?roots[0]:"Dynamic SOQL",
        field:"("+(existing?"Recovered query variants":"Recovered partial references")+": "+path.basename(site.filePath)+":"+site.lineNumber+"@"+site.siteId.split("@").at(-1)+")",
        query:"(coverage advisory for "+variants.length+(existing?" recovered query variants":" recovered permission inventories")+")",
        withUserMode:modes.length===1&&modes[0]==="USER_MODE",
        declaredMode:modes.length===1?modes[0]:"UNSPECIFIED",effectiveMode:"UNKNOWN",runtimeImpact:"Not assessed",
        ...coverageFlag,
        reason:(existing?"No missing OLS/FLS was identified across "+variants.length+" recovered query variant"+(variants.length===1?"":"s")+". "
          :"No missing OLS/FLS was identified for the recovered object and field references. ")+caveat+modeCaveat,
      });
    }
    handledSiteIds.add(site.siteId);
    (existing?existingSiteIds:partialSiteIds).add(site.siteId);
  }
  return {findings:result,handledSiteIds,existingSiteIds,partialSiteIds};
}

/** Existing-only entry point for consumers that explicitly request that scope. */
export function applyExistingVariantReporting(
  sites:readonly UnresolvedDynamicSoql[],queries:readonly SoqlQuery[],findings:readonly SoqlSecurityFinding[],
){
  return applyLimitedCoverageReporting(sites,queries,findings,false);
}
