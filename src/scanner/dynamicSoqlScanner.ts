import {analyzeApexInvocations,inspectApexInvocationContexts} from "../core/apex/ApexAnalysisEngine.js";
import {dynamicDatabaseQuerySelector,type ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {explainUncapturedApexQuery} from "../core/apex/ApexExecutionPathDiagnostics.js";
import type { ApexRepositoryMethodIndex } from "../core/apex/ApexRepositoryMethodIndex.js";
import type { ApexValue } from "../core/apex/ApexValueEvaluator.js";
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
 * All paths at a site must yield complete valid SOQL; otherwise one REVIEW
 * is emitted for the site. No partial resolved results are ever published.
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
    const fail=(reason:string)=>{
      let explanation=reason;
      const owner=repositoryIndex?.methodAt(filePath,site.offset);
      if(owner?.arity && /dependency|runtime|symbol|join|parameter|helper|unsupported/i.test(reason)){
        const evidence=repositoryIndex!.inspectCallers(owner.className,owner.methodName,owner.arity);
        if(evidence.candidateCalls)explanation +=
          " Repository caller index: "+evidence.knownCalls+" known and "+
          evidence.unknownCalls+" unproven explicit caller(s)."+
          (evidence.externallyCallable
            ?" Method is externally callable; complete caller coverage cannot be established from repository metadata."
            :"");
        const scoped=inspectApexInvocationContexts(filePath,site.offset,site.arguments,resolveExternal,repositoryIndex);
        if(scoped?.contexts.known.length){
          const variants=new Set<string>();
          for(const args of scoped.arguments){
            const query=args[0];
            if(query?.kind!=="text")continue;
            for(const value of query.values){
              const text=value.trim();
              if(!/^SELECT\b/i.test(text))continue;
              const parsed=parseNestedSoql(text,site.line);
              const fields=extractSoqlExpressionFields(text);
              if(parsed&&fields.parsed&&!fields.limitations.length)variants.add(text);
            }
          }
          explanation+=" Known repository contexts: "+scoped.contexts.known.length+
            "; structurally valid query variants in probed contexts: "+variants.size+
            (scoped.bounded?" (bounded sample).":"." )+
            " Context evidence only; complete execution coverage is not proven.";
        }
      }
      unresolved.push({filePath,lineNumber:site.line,siteId,reason:explanation});
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
        reason=capture.query.kind==="unknown"?capture.query.reason:"Database query argument was not a String.";
        break;
      }
      strings.push(...capture.query.values);
    }
    if(reason){fail("Query dependency unresolved: "+reason);continue;}
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
