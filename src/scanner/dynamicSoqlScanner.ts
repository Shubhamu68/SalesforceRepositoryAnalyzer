import {analyzeApexInvocations,inspectApexInvocationContexts} from "../core/apex/ApexAnalysisEngine.js";
import {dynamicDatabaseQuerySelector,type ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {explainUncapturedApexQuery} from "../core/apex/ApexExecutionPathDiagnostics.js";
import type { ApexRepositoryMethodIndex } from "../core/apex/ApexRepositoryMethodIndex.js";
import {provePartialSoql} from "../analyzer/soqlPartialStructure.js";
import {describePartialApexText,type ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {describeMalformedSoql} from "../analyzer/soqlReconstructionDiagnostics.js";
import { classifySoqlMode } from "../analyzer/soqlExecutionMode.js";
import { extractSoqlExpressionFields } from "../analyzer/soqlExpressionInventory.js";
import { parseNestedSoql } from "../analyzer/nestedSoqlScopes.js";
import type { SoqlQuery } from "../models/SoqlQuery.js";

export interface UnresolvedDynamicSoql {
  filePath: string;
  lineNumber: number;
  /** Immutable call-site identity, even if two sites share a source line. */
  siteId?: string;
  reason: string;
  /** Known variants coexist with this unresolved execution site. */
  knownVariants?: number;
  partialStructureVariants?:number;
  conditionalFrameworkVariants?:number;
}
export interface DynamicSoqlScanResult {
  queries: SoqlQuery[];
  unresolved: UnresolvedDynamicSoql[];
}
const MAX_VARIANTS = 32;
function explicitMode(site:ApexCallSite):"USER_MODE"|"SYSTEM_MODE"|undefined|null{
  if(!site.accessLevelArgument)return undefined;
  const mode=/^AccessLevel\.(USER_MODE|SYSTEM_MODE)$/i.exec(site.accessLevelArgument.trim());
  return mode?mode[1].toUpperCase() as "USER_MODE"|"SYSTEM_MODE":null;
}

/**
 * A thin, SOQL-specific adapter over the reusable Apex data-flow engine.
 * Complete coverage requires all paths to resolve. Explicitly proven caller
 * variants can also be analyzed, but retain the site REVIEW and coverage tag.
 */
export function extractDynamicSoqlQueries(source:string,filePath:string,
  resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined,
  repositoryIndex?: ApexRepositoryMethodIndex):DynamicSoqlScanResult {
  if(!/\bDatabase\s*\.\s*(?:query|countQuery|getQueryLocator)/i.test(source))
    return {queries:[],unresolved:[]};
  const flow=analyzeApexInvocations(source,filePath,dynamicDatabaseQuerySelector,resolveExternal,repositoryIndex);
  const queries:SoqlQuery[]=[];
  const unresolved:UnresolvedDynamicSoql[]=[];
  for(const site of flow.sites){
    const siteId=filePath+"@"+site.offset;
    const fail=(reason:string,partialValues:readonly ApexValue[]=[])=>{
      let explanation=reason;
      let knownVariants=0,conditionalFrameworkVariants=0;
      const partialEvidence=[...partialValues];
      const variants=new Set<string>();
      const owner=repositoryIndex?.methodAt(filePath,site.offset);
      const mode=explicitMode(site);
      if(owner?.arity && (/dependency|runtime|symbol|join|parameter|helper|unsupported/i.test(reason)||
        (owner.visibility==="private"&&/budget/i.test(reason)))){
        const evidence=repositoryIndex!.inspectCallers(owner.className,owner.methodName,owner.arity);
        if(evidence.candidateCalls)explanation +=
          " Repository caller index: "+evidence.knownCalls+" known and "+
          evidence.unknownCalls+" unproven explicit caller(s)."+
          (evidence.externallyCallable
            ?" Method is externally callable; complete caller coverage cannot be established from repository metadata."
            :"");
        const scoped=inspectApexInvocationContexts(filePath,site.offset,[site.argument],resolveExternal,repositoryIndex);
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
              if(!parsed||!fields.parsed||fields.limitations.length||
                (mode&&declared!=="UNSPECIFIED"&&declared!==mode))continue;
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
              if(!parsed||!fields.parsed||fields.limitations.length||(mode&&declared!=="UNSPECIFIED"&&declared!==mode))continue;
              variants.add(text);conditionalFrameworkVariants++;
              queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,fields:parsed.fields,subqueries:parsed.subqueries,
                withUserMode:declared==="USER_MODE"||mode==="USER_MODE",securityMode:declared,dynamicOrigin:true,querySiteId:siteId,
                queryVariantId:siteId+"#framework-"+(conditionalFrameworkVariants-1),coverage:"CONDITIONAL_FRAMEWORK_CONTEXT",...(mode?{dynamicAccessLevel:mode}:{})});
            }
          }
          explanation+=" Known repository contexts: "+scoped.contexts.known.length+
            "; partially known contexts: "+scoped.contexts.partial.length+
            (scoped.receiverContexts?"; known framework receiver contexts: "+scoped.receiverContexts:"")+
            (scoped.receiverScenarios?"; conditional framework receiver scenarios: "+scoped.receiverScenarios:"")+
            (scoped.contexts.freshEntryContexts?"; sampled direct fresh framework entry contexts: "+scoped.contexts.freshEntryContexts:"")+
            "; structurally valid query variants in probed contexts: "+knownVariants+
            (scoped.bounded?" (bounded sample).":"." )+
            (knownVariants?" Known variants are submitted for separate access analysis;":" Context evidence only;")+
            " complete execution coverage is not proven.";
        }
      }
      if(conditionalFrameworkVariants)explanation+=" Conditional framework variants: "+conditionalFrameworkVariants+". Constructor-only or sampled map-key scenarios are conditional source evidence, not observed batch submissions. Typed runtime slots may use synthetic parser placeholders. Other receiver states remain unverified.";
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
        if(!parsed||!fields.parsed||fields.limitations.length||
          (mode&&declared!=="UNSPECIFIED"&&declared!==mode))continue;
        variants.add(text);partialStructureVariants++;
        queries.push({filePath,lineNumber:site.line,query:text,object:parsed.fromName,
          fields:parsed.fields,subqueries:parsed.subqueries,securityMode:declared,
          withUserMode:declared==="USER_MODE"||mode==="USER_MODE",dynamicOrigin:true,
          querySiteId:siteId,queryVariantId:siteId+"#partial-"+(partialStructureVariants-1),
          coverage:"PROVEN_PARTIAL_STRUCTURE",...(mode?{dynamicAccessLevel:mode}:{})});
      }
      if(partialStructureVariants)explanation+=" Proven partial structural variants: "+partialStructureVariants+
        ". Typed numeric or quoted Id slots use synthetic parser placeholders, not actual runtime values; only those proven field and object references are submitted for access analysis. Complete execution coverage remains unverified.";
      unresolved.push({filePath,lineNumber:site.line,siteId,reason:explanation,...(knownVariants?{knownVariants}:{}),
        ...(partialStructureVariants?{partialStructureVariants}:{}),...(conditionalFrameworkVariants?{conditionalFrameworkVariants}:{})});
    };
    const failure=flow.failures.get(site.offset);
    if(failure){fail(failure);continue;}
    if(flow.unreachable.has(site.offset))continue;
    const captures=flow.captures.get(site.offset)??[];
    if(!captures.length){fail("Invocation is outside a supported method or execution path. "+
      explainUncapturedApexQuery(source,site.offset,site.argument));continue;}
    const mode=explicitMode(site);
    if(mode===null){fail("Dynamic Database AccessLevel expression could not be established.");continue;}
    const strings:string[]=[];
    let reason:string|undefined;
    for(const capture of captures){
      if(capture.query.kind!=="text"){
        reason=capture.query.kind==="unknown"?capture.query.reason+describePartialApexText(capture.query):"Database query argument was not a String.";
        break;
      }
      strings.push(...capture.query.values);
    }
    if(reason){fail("Query dependency unresolved: "+reason,captures.map(c=>c.query));continue;}
    const variants=[...new Set(strings.map(s=>s.trim()))];
    if(!variants.length||variants.length>MAX_VARIANTS){
      fail("Query has no proven complete value or exceeds the variant limit.");continue;
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
        reason="Complete query failed SOQL parsing: "+detail+describeMalformedSoql(queryText,detail);
        break;
      }
      const declared=classifySoqlMode(queryText);
      if(mode&&declared!=="UNSPECIFIED"&&declared!==mode){
        reason="Explicit Database AccessLevel conflicts with the query WITH clause.";
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
    if(reason){fail(reason);continue;}
    queries.push(...candidates);
  }
  return {queries,unresolved};
}
