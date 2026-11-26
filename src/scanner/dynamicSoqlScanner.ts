import {analyzeApexInvocations,inspectApexInvocationContexts} from "../core/apex/ApexAnalysisEngine.js";
import {dynamicDatabaseQuerySelector,type ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {parseApexAccessLevel} from "../core/apex/ApexDatabaseAccessMode.js";
import {explainUncapturedApexQuery} from "../core/apex/ApexExecutionPathDiagnostics.js";
import type { ApexRepositoryMethodIndex } from "../core/apex/ApexRepositoryMethodIndex.js";
import {provePartialSoql} from "../analyzer/soqlPartialStructure.js";
import {proveLocalSoqlPermissionShape} from "../analyzer/soqlSourceStructuralEvidence.js";
import {proveCallerPermissionShapes,proveLiteralHelperPermissionShapes} from "../analyzer/soqlCallerStructuralEvidence.js";
import {proveLabelBackedPermissionShapes} from "../analyzer/soqlLabelStructuralEvidence.js";
import {backtrackSoqlPermissionShapes} from "../analyzer/soqlBackwardEvidence.js";
import {aggregatePermissionShapes,simplePermissionShape,type SoqlPermissionShape} from "../analyzer/soqlPermissionAggregation.js";
import {describePartialApexText,type ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {describeMalformedSoql} from "../analyzer/soqlReconstructionDiagnostics.js";
import { classifySoqlMode, type DeclaredSoqlMode } from "../analyzer/soqlExecutionMode.js";
import { extractSoqlExpressionFields } from "../analyzer/soqlExpressionInventory.js";
import { parseNestedSoql } from "../analyzer/nestedSoqlScopes.js";
import type { SoqlQuery } from "../models/SoqlQuery.js";
import {collectSoqlTrace,newSoqlTraceReport,type SoqlTraceReport} from "../analyzer/soqlTraceDiagnostics.js";
import {collectApexDependencyBlockers,type ApexDependencyObserver} from "../core/apex/ApexDependencyDiagnostics.js";
import {explainSoqlReview} from "../analyzer/soqlReviewExplanation.js";

/** Failure category, independent of wording shown to users. */
export type DynamicSoqlFailureKind = "QUERY_DEPENDENCY" | "NO_CAPTURE" | "ENGINE_FAILURE" | "OTHER";
export interface UnresolvedDynamicSoql {
  filePath: string;
  lineNumber: number;
  /** Immutable call-site identity, even if two sites share a source line. */
  siteId?: string;
  reason: string;
  /** Concise final evidence summary for report/UI consumers; reason retains diagnostics. */
  reportReason?:string;
  failureKind?:DynamicSoqlFailureKind;
  /** Compact source evidence retained independently of opt-in trace logging. */
  backwardExplanation?:string;
  /** Structurally validated source candidates with conflicting explicit declarations. */
  securityModeConflict?: boolean;
  /** Known variants coexist with this unresolved execution site. */
  knownVariants?: number;
  partialStructureVariants?:number;
  conditionalFrameworkVariants?:number;
  aggregatedPermissionInventories?:number;
  /** Known references proven; only schema-constrained SELECT additions remain runtime dependent. */
  runtimeFieldCoverage?:boolean;
  trace?:SoqlTraceReport;
}
export interface DynamicSoqlScanResult {
  queries: SoqlQuery[];
  unresolved: UnresolvedDynamicSoql[];
}
const MAX_VARIANTS = 32;
function explicitMode(site:ApexCallSite){return parseApexAccessLevel(site.accessLevelArgument);}

/**
 * A thin, SOQL-specific adapter over the reusable Apex data-flow engine.
 * Complete coverage requires all paths to resolve. Explicitly proven caller
 * variants can also be analyzed, but retain the site REVIEW and coverage tag.
 */
export function extractDynamicSoqlQueries(source:string,filePath:string,
  resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined,
  repositoryIndex?: ApexRepositoryMethodIndex,traceEnabled=false):DynamicSoqlScanResult {
  if(!/\bDatabase\s*\.\s*(?:query|countQuery|getQueryLocator)/i.test(source))
    return {queries:[],unresolved:[]};
  const flow=analyzeApexInvocations(source,filePath,dynamicDatabaseQuerySelector,resolveExternal,repositoryIndex);
  const queries:SoqlQuery[]=[];
  const unresolved:UnresolvedDynamicSoql[]=[];
  for(const site of flow.sites){
    const siteId=filePath+"@"+site.offset;
    const fail=(reason:string,partialValues:readonly ApexValue[]=[],initialConflict?:DeclaredSoqlMode,
      failureKind:DynamicSoqlFailureKind="OTHER")=>{
      let explanation=reason;
      let backwardExplanation:string|undefined;
      const trace=traceEnabled?newSoqlTraceReport(filePath,site.line,site.offset,site.argument):undefined;
      const observe=trace?collectSoqlTrace(trace):undefined;
      const note=(code:string,count?:number)=>{if(trace)observe?.({code,file:trace.file,line:site.line,depth:0,...(count===undefined?{}:{count})});};
      let knownVariants=0,conditionalFrameworkVariants=0;
      const partialEvidence=[...partialValues];
      let callerSeeds:readonly ApexValue[][]=[];
      const variants=new Set<string>();
      const owner=repositoryIndex?.methodAt(filePath,site.offset);
      const mode=explicitMode(site);
      const conflicts=new Set<DeclaredSoqlMode>();
      const hasModeConflict=(declared:DeclaredSoqlMode):boolean=>{
        if(!mode||declared==="UNSPECIFIED"||declared===mode)return false;
        conflicts.add(declared);note("ACCESS_MODE_CONFLICT");return true;
      };
      if(initialConflict)hasModeConflict(initialConflict);
      // A captured but unresolved query argument always warrants caller /
      // receiver probing, even if its reason mentions only constructor state.
      // Older core engine failures still supply raw internal diagnostics:
      // keep their existing eligibility checks until the core exposes typed
      // failure categories. Never test the formatted report explanation.
      const shouldProbe=failureKind==="QUERY_DEPENDENCY"||
        /dependency|runtime|symbol|join|parameter|helper|unsupported/i.test(reason)||
        (owner?.visibility==="private"&&/budget/i.test(reason));
      if(owner && (owner.arity>0||(owner.visibility==="private"&&!owner.isStatic)) && shouldProbe){
        const evidence=repositoryIndex!.inspectCallers(owner.className,owner.methodName,owner.arity);
        if(evidence.candidateCalls)explanation +=
          " Source callers: "+evidence.knownCalls+" known and "+
          evidence.unknownCalls+" unproven."+
          (evidence.externallyCallable
            ?" The method is externally callable, so other calls may exist outside the repository."
            :"");
        const scoped=inspectApexInvocationContexts(filePath,site.offset,[site.argument],resolveExternal,repositoryIndex);
        if(scoped)callerSeeds=[...scoped.contexts.known,...scoped.contexts.partial];
        if(scoped?.lifecycleDiagnostics?.length)
          explanation+=" Framework execution details: "+scoped.lifecycleDiagnostics.join(", ")+".";
        if(scoped&&(scoped.contexts.known.length||scoped.contexts.partial.length||scoped.receiverContexts||scoped.receiverScenarios)){
          partialEvidence.push(...scoped.partialArguments.map(args=>args[0]).filter((v):v is ApexValue=>v!==undefined));
          // Do not publish a guessed security mode, even if SELECT is valid.
          if(mode!==null)for(const args of scoped.arguments){
            const query=args[0];
            if(query?.kind!=="text")continue;
            for(const value of query.values){
              const text=value.trim();
              if(!/^SELECT\b/i.test(text)||variants.has(text)||variants.size>=MAX_VARIANTS)continue;
              const parsed=parseNestedSoql(text,site.line);
              const fields=extractSoqlExpressionFields(text);
              const declared=classifySoqlMode(text);
              if(!parsed||!fields.parsed||fields.limitations.length||hasModeConflict(declared))continue;
              variants.add(text);
              queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,
                fields:parsed.fields,subqueries:parsed.subqueries,
                withUserMode:declared==="USER_MODE"||mode==="USER_MODE",securityMode:declared,
                dynamicOrigin:true,querySiteId:siteId,queryVariantId:siteId+"#known-"+(variants.size-1),
                coverage:"KNOWN_CALLER_CONTEXT",...(mode?{dynamicAccessLevel:mode}:{})});
            }
          }
          knownVariants=variants.size;
          if(mode!==null)for(const args of scoped.conditionalArguments){
            const value=args[0];
            const proof=value?.kind==="unknown"?provePartialSoql(value):undefined;
            const candidates=value?.kind==="text"?value.values:proof?[proof.text]:[];
            for(const value of candidates){
              const text=value.trim();
              if(!/^SELECT\b/i.test(text)||variants.has(text)||variants.size>=MAX_VARIANTS)continue;
              const parsed=parseNestedSoql(text,site.line),fields=extractSoqlExpressionFields(text),declared=classifySoqlMode(text);
              if(!parsed||!fields.parsed||fields.limitations.length||hasModeConflict(declared))continue;
              variants.add(text);conditionalFrameworkVariants++;
              queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,fields:parsed.fields,subqueries:parsed.subqueries,
                withUserMode:declared==="USER_MODE"||mode==="USER_MODE",securityMode:declared,dynamicOrigin:true,querySiteId:siteId,
                queryVariantId:siteId+"#framework-"+(conditionalFrameworkVariants-1),coverage:"CONDITIONAL_FRAMEWORK_CONTEXT",...(mode?{dynamicAccessLevel:mode}:{})});
            }
          }
          explanation+=" Calls with known inputs: "+scoped.contexts.known.length+
            "; calls with partially known inputs: "+scoped.contexts.partial.length+
            (scoped.receiverContexts?"; known framework states: "+scoped.receiverContexts:"")+
            (scoped.receiverScenarios?"; possible framework states: "+scoped.receiverScenarios:"")+
            (scoped.contexts.freshEntryContexts?"; sampled new framework instances: "+scoped.contexts.freshEntryContexts:"")+
            "; valid query versions found: "+knownVariants+
            (scoped.bounded?" (limited sample).":"." )+
            (knownVariants?" Known query versions are checked separately;":" These inputs alone do not establish a query;")+
            " other execution paths remain unchecked.";
        }
      }
      if(conditionalFrameworkVariants)explanation+=" Possible framework query versions: "+conditionalFrameworkVariants+". Based on constructors or sampled map keys, not actual batch runs. Placeholder values may be used for analysis; other framework states were not verified.";
      let partialStructureVariants=0;
      // Grammar-specific proof is intentionally confined to this adapter.
      // The core Apex value remains unknown; no synthetic query is executed.
      if(mode!==null)for(const value of partialEvidence){
        if(variants.size>=MAX_VARIANTS)break;
        const proof=provePartialSoql(value);
        if(!proof)continue;
        const text=proof.text.trim();
        if(variants.has(text)||!/^SELECT\b/i.test(text))continue;
        const parsed=parseNestedSoql(text,site.line);
        const fields=extractSoqlExpressionFields(text);
        const declared=classifySoqlMode(text);
        if(!parsed||!fields.parsed||fields.limitations.length||hasModeConflict(declared))continue;
        variants.add(text);partialStructureVariants++;
        queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,
          fields:parsed.fields,subqueries:parsed.subqueries,securityMode:declared,
          withUserMode:declared==="USER_MODE"||mode==="USER_MODE",dynamicOrigin:true,
          querySiteId:siteId,queryVariantId:siteId+"#partial-"+(partialStructureVariants-1),
          coverage:"PROVEN_PARTIAL_STRUCTURE",...(mode?{dynamicAccessLevel:mode}:{})});
      }
      // Aggregate only additional permission evidence. Existing variants
      // keep their IDs, occurrence counts and coverage classifications.
      let aggregatedPermissionInventories=0,runtimeFieldCoverage=false;
      let compactBlocker:string|undefined,bounded=false,unknownWhere=false,incompleteSelect=false;
      const recoveredClauses=new Set<string>();
      if(trace){trace.priorVariants=variants.size;trace.fallback=mode===null?"SKIP_UNKNOWN_ACCESS_MODE":"NOT_ATTEMPTED";}
      if(mode!==null){
        const methods=repositoryIndex?.indexedMethods(filePath,source);
        // Never reinterpret arbitrary unresolved captures as complete
        // permission evidence (unknown loops may expose only zero iterations).
        const local=variants.size===0?[
          ...proveLocalSoqlPermissionShape(source,site,methods),
          ...proveLiteralHelperPermissionShapes(source,site,methods),
          ...proveLabelBackedPermissionShapes(source,site,resolveExternal,methods)
        ]:[];
        const callers=callerSeeds.length?proveCallerPermissionShapes(source,site,callerSeeds,methods):[];
        // The report must retain actual blockers even when no query could
        // be reconstructed. Do not require the opt-in verbose trace, and
        // never perform a second backward analysis just for explanations.
        const blockers=collectApexDependencyBlockers();
        const structuralCodes=new Set<string>();
        const reportObserver:ApexDependencyObserver=event=>{
          blockers.observe(event);observe?.(event);
          if(event.code==="SOQL_OPTIONAL_WHERE_UNVERIFIED")unknownWhere=true;
          if(event.code==="SOQL_PARTIAL_EFFECT_PREFIX_VALIDATED")incompleteSelect=true;
          if(["SOQL_CONDITIONAL_MERGE_REJECTED","SOQL_RUNTIME_SLOT_UNPROVEN","SOQL_REQUIRED_REFERENCE_MISMATCH","SOQL_VALUE_UNRESOLVED","RUNTIME_SELECT_DOMAIN_MISMATCH"].includes(event.code))
            structuralCodes.add(event.code);
        };
        const traced=variants.size===0&&!local.length&&!callers.length
          ?backtrackSoqlPermissionShapes(source,filePath,site,repositoryIndex,resolveExternal,reportObserver):undefined;
        compactBlocker=blockers.summarizeCompact();
        bounded=!!traced?.bounded;
        if(traced&&!traced.queries.length){
          const details=blockers.summarize();
          const structure=structuralCodes.has("SOQL_CONDITIONAL_MERGE_REJECTED")
            ?" Could not combine conditional parts into a query suitable for permission checks."
            :structuralCodes.has("RUNTIME_SELECT_DOMAIN_MISMATCH")||structuralCodes.has("SOQL_REQUIRED_REFERENCE_MISMATCH")
              ?" Could not verify required object or field references."
              :structuralCodes.has("SOQL_RUNTIME_SLOT_UNPROVEN")
                ?" Some parts of the query remain unknown."
                :structuralCodes.has("SOQL_VALUE_UNRESOLVED")?" Could not reconstruct the complete query.":"";
          if(details||structure)backwardExplanation="Why the query could not be fully resolved: "+(details??"")+structure;
        }
        if(trace){
          trace.localCandidates=local.length;trace.callerCandidates=callers.length;
          trace.fallback=traced?"ATTEMPTED":variants.size?"SKIP_EXISTING_VARIANTS":local.length?"SKIP_LOCAL_CANDIDATES":"SKIP_CALLER_CANDIDATES";
          if(traced){trace.backwardCandidates=traced.queries.length;trace.callerEdges=traced.callerEdges;trace.metadataRows=traced.metadataRows;trace.bounded=traced.bounded;}
        }
        if(traced?.queries.length)explanation+=" Query details recovered from "+traced.callerEdges+" source caller(s) and "+traced.metadataRows+" possible metadata record(s). Placeholder filter values are for analysis only; SOQL injection safety was not checked.";
        if(traced?.bounded)explanation+=" Backward analysis reached its processing limit.";
        const prefixTexts=new Set(traced?.partialSelectQueries??[]);
        const shapeEntries=[...local,...callers,...(traced?.queries??[])].flatMap(text=>{
          const shape=simplePermissionShape(text,site.line,trace?(code)=>note(code):undefined);
          return shape&&!hasModeConflict(shape.mode)?[{shape,prefixOnly:prefixTexts.has(text)}]:[];
        });
        const shapes=shapeEntries.map(entry=>entry.shape);
        // A whole validated group is kept if it introduces a new reference.
        // Avoid stripping SELECT scaffolding or changing clause usage.
        const covered=new Map<string,Set<string>>();
        const groupKey=(shape:SoqlPermissionShape)=>shape.object.toLowerCase()+"|"+shape.mode;
        const fieldKey=(field:SoqlPermissionShape["fields"][number])=>field.context+"|"+field.fieldPath.toLowerCase();
        for(const text of variants){
          const shape=simplePermissionShape(text,site.line);
          if(!shape)continue;
          const key=groupKey(shape),fields=covered.get(key)??new Set<string>();
          for(const field of shape.fields)fields.add(fieldKey(field));
          covered.set(key,fields);
        }
        const aggregates=[
          ...aggregatePermissionShapes(shapeEntries.filter(e=>!e.prefixOnly).map(e=>e.shape),trace?(code)=>note(code):undefined).map(text=>({text,selectPrefixOnly:false})),
          ...aggregatePermissionShapes(shapeEntries.filter(e=>e.prefixOnly).map(e=>e.shape),trace?(code)=>note(code):undefined).map(text=>({text,selectPrefixOnly:true}))
        ];
        const runtimeOnly=!!traced?.runtimeFieldQueries?.length&&!traced.bounded&&!local.length&&!callers.length&&shapes.length===traced.queries.length&&aggregates.length===1&&!conflicts.size;
        if(trace){trace.compatibleShapes=shapes.length;trace.aggregateCandidates=aggregates.length;}
        for(const {text,selectPrefixOnly} of aggregates){
          if(variants.size>=MAX_VARIANTS||variants.has(text)){note(variants.size>=MAX_VARIANTS?"VARIANT_LIMIT":"DUPLICATE_VARIANT");continue;}
          const shape=simplePermissionShape(text,site.line,trace?(code)=>note(code):undefined);
          if(!shape)continue;
          const existing=covered.get(groupKey(shape));
          if(existing&&shape.fields.every(f=>existing.has(fieldKey(f)))){note("REFERENCES_ALREADY_COVERED");continue;}
          const parsed=parseNestedSoql(text,site.line);
          if(!parsed){note("FINAL_ROOT_PARSE_FAILED");continue;}
          const declared=shape.mode;
          variants.add(text);partialStructureVariants++;aggregatedPermissionInventories++;
          for(const field of shape.fields)recoveredClauses.add(field.context.replace("_"," "));
          if(runtimeOnly)runtimeFieldCoverage=true;
          queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,
            fields:parsed.fields,subqueries:parsed.subqueries,securityMode:declared,
            withUserMode:declared==="USER_MODE"||mode==="USER_MODE",dynamicOrigin:true,
            querySiteId:siteId,queryVariantId:siteId+"#partial-"+(partialStructureVariants-1),
            coverage:"PROVEN_PARTIAL_STRUCTURE",permissionEvidence:"AGGREGATED_STRUCTURE",...(selectPrefixOnly?{selectPrefixOnly:true}:{}),...(runtimeOnly?{runtimeFieldCoverage:true}:{}),...(mode?{dynamicAccessLevel:mode}:{})});
        }
        if(trace)trace.added=aggregatedPermissionInventories;
        if(aggregatedPermissionInventories)explanation+=" Permission inventory aggregated from known object and field references. The reconstructed query is for analysis only, not execution.";
        if(traced?.partialSelectQueries?.length)explanation+=" Independently proven SELECT fields were checked for grants. An explicit Database AccessLevel is present, but effective enforcement, runtime WHERE and ORDER BY clauses, and possible text-mode conflicts remain unverified.";
      }
      if(backwardExplanation)explanation=backwardExplanation+" Initial analysis: "+explanation;
      if(runtimeFieldCoverage)explanation+=" Known fields are checked for permissions; additional runtime-dependent fields are outside verified coverage.";
      if(partialStructureVariants)explanation+=" Partially resolved query versions: "+partialStructureVariants+
        ". Placeholder values are for analysis only. Only known objects and fields are checked; the full query remains unverified.";
      if(conflicts.size&&mode){
        const declarations=[...conflicts].sort().map(m=>"WITH "+m).join(" / ");
        explanation="REVIEW — Security-mode conflict: a resolved query version uses "+declarations+
          ", but Database."+site.method+" uses AccessLevel."+mode+
          ". Make both declarations use the intended mode. Actual permission enforcement is unclear; the conflicting query was excluded from OLS/FLS checks. "+
          explanation;
      }
      const reportReason=explainSoqlReview({reason,blocker:compactBlocker,knownVariants,partialStructureVariants,
        conditionalFrameworkVariants,aggregatedPermissionInventories,runtimeFieldCoverage,bounded,
        recoveredClauses:[...recoveredClauses],unknownWhere,incompleteSelect,
        ...(conflicts.size&&mode?{conflict:"Security-mode conflict: WITH "+[...conflicts].sort().join(" / WITH ")+" disagrees with AccessLevel."+mode+". Conflicting query permissions not verified."}:{})});
      unresolved.push({filePath,lineNumber:site.line,siteId,reason:explanation,reportReason,failureKind,...(backwardExplanation?{backwardExplanation}:{}),...(conflicts.size?{securityModeConflict:true}:{}),...(knownVariants?{knownVariants}:{}),
        ...(partialStructureVariants?{partialStructureVariants}:{}),...(conditionalFrameworkVariants?{conditionalFrameworkVariants}:{}),...(aggregatedPermissionInventories?{aggregatedPermissionInventories}:{}),...(runtimeFieldCoverage?{runtimeFieldCoverage:true}:{}),...(trace?{trace}:{})});
    };
    const failure=flow.failures.get(site.offset);
    if(failure){fail(failure,[],undefined,"ENGINE_FAILURE");continue;}
    if(flow.unreachable.has(site.offset))continue;
    const captures=flow.captures.get(site.offset)??[];
    if(!captures.length){fail("Invocation is outside a supported method or execution path. "+
      explainUncapturedApexQuery(source,site.offset,site.argument),[],undefined,"NO_CAPTURE");continue;}
    const mode=explicitMode(site);
    if(mode===null){fail("Could not determine the query's Database AccessLevel.");continue;}
    const strings:string[]=[];
    let reason:string|undefined;
    let initialConflict:DeclaredSoqlMode|undefined;
    for(const capture of captures){
      if(capture.query.kind!=="text"){
        reason=capture.query.kind==="unknown"?capture.query.reason+describePartialApexText(capture.query):"Database query argument was not a String.";
        break;
      }
      strings.push(...capture.query.values);
    }
    if(reason){fail("Could not build the full query: "+reason,captures.map(c=>c.query),undefined,"QUERY_DEPENDENCY");continue;}
    const variants=[...new Set(strings.map(s=>s.trim()))];
    if(!variants.length||variants.length>MAX_VARIANTS){
      fail("Could not reconstruct a complete query or the query version limit was reached.");continue;
    }
    const candidates:SoqlQuery[]=[];
    for(let index=0;index<variants.length;index++){
      const queryText=variants[index];
      if(!/^(?:SELECT|FIND)\b/i.test(queryText)){
        reason="Built query does not start with a supported SOQL SELECT."+describeMalformedSoql(queryText,"");
        break;
      }
      // The current field-access analyzer is SOQL-specific, not SOSL.
      if(!/^SELECT\b/i.test(queryText)){reason="SOSL is not supported by the SOQL analyzer.";break;}
      const parsed=parseNestedSoql(queryText,site.line);
      const fields=extractSoqlExpressionFields(queryText);
      if(!parsed||!fields.parsed||fields.limitations.length){
        const detail=fields.limitations[0]??"Root scope invalid.";
        reason="The reconstructed SOQL could not be parsed: "+detail+describeMalformedSoql(queryText,detail);
        break;
      }
      const declared=classifySoqlMode(queryText);
      if(mode&&declared!=="UNSPECIFIED"&&declared!==mode){
        reason="Explicit Database AccessLevel conflicts with the query WITH clause.";
        initialConflict=declared;
        break;
      }
      candidates.push({
        filePath,lineNumber:site.line,query:queryText,object:parsed.fromName,
        fields:parsed.fields,subqueries:parsed.subqueries,
        withUserMode:declared==="USER_MODE"||mode==="USER_MODE",
        securityMode:declared,
        dynamicOrigin:true,
        querySiteId:siteId,
        queryVariantId:siteId+"#"+index,
        ...(mode?{dynamicAccessLevel:mode}:{})
      });
    }
    if(reason){fail(reason,[],initialConflict);continue;}
    queries.push(...candidates);
  }
  return {queries,unresolved};
}
