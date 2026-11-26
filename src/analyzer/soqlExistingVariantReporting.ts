import path from "node:path";
import type {SoqlQuery} from "../models/SoqlQuery.js";
import type {SoqlSecurityFinding} from "../models/SoqlSecurityFinding.js";
import type {UnresolvedDynamicSoql} from "../scanner/dynamicSoqlScanner.js";

/** This is a reporting policy for existing variants, not an exhaustive
 * coverage certificate and not a new OLS/FLS evaluation mechanism. */
export const EXISTING_VARIANT_LIMITATION="All recovered query variants were analyzed; additional runtime-dependent variants may exist.";

export function applyExistingVariantReporting(
  sites:readonly UnresolvedDynamicSoql[],
  queries:readonly SoqlQuery[],
  findings:readonly SoqlSecurityFinding[],
):{findings:SoqlSecurityFinding[];handledSiteIds:Set<string>}{
  const bySite=new Map<string,SoqlQuery[]>();
  for(const q of queries){
    if(!q.querySiteId)continue;
    const items=bySite.get(q.querySiteId)??[];
    items.push(q);bySite.set(q.querySiteId,items);
  }
  const handledSiteIds=new Set<string>();
  const result=[...findings];
  for(const site of sites){
    if(site.referenceCoverage!=="PARTIAL_REFERENCES"||site.securityModeConflict||
      !site.siteId||!site.existingQueryVariants||site.runtimeFieldCoverage)continue;
    const variants=bySite.get(site.siteId)??[];
    // A filtered or incomplete analyzed set is not enough to claim that
    // all generated variants were evaluated. Prefix-only/schema-runtime
    // candidates are a separate policy and remain outside this change.
    if(variants.length!==site.existingQueryVariants+(site.aggregatedPermissionInventories??0)||
      variants.some(q=>!q.queryVariantId||q.selectPrefixOnly||q.runtimeFieldCoverage)||
      new Set(variants.map(q=>q.queryVariantId)).size!==variants.length)continue;
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
        limitedVariantCoverage:true,
        reason:reason+" "+EXISTING_VARIANT_LIMITATION};
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
        field:"(Recovered query variants: "+path.basename(site.filePath)+":"+site.lineNumber+"@"+site.siteId.split("@").at(-1)+")",
        query:"(coverage advisory for "+variants.length+" recovered query variants)",
        withUserMode:modes.length===1&&modes[0]==="USER_MODE",
        declaredMode:modes.length===1?modes[0]:"UNSPECIFIED",effectiveMode:"UNKNOWN",runtimeImpact:"Not assessed",
        limitedVariantCoverage:true,
        reason:"No missing OLS/FLS was identified across "+variants.length+" recovered query variant"+(variants.length===1?"":"s")+". "+EXISTING_VARIANT_LIMITATION,
      });
    }
    handledSiteIds.add(site.siteId);
  }
  return {findings:result,handledSiteIds};
}
