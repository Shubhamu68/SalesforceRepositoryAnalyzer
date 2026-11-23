import { ApexDataFlowEngine, type ApexCallSite } from "../core/apex/ApexDataFlowEngine.js";
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
export function extractDynamicSoqlQueries(source:string,filePath:string):DynamicSoqlScanResult {
  if(!/\bDatabase\s*\.\s*(?:query|countQuery|getQueryLocator)/i.test(source))
    return {queries:[],unresolved:[]};
  const engine=new ApexDataFlowEngine(source);
  const flow=engine.analyze();
  const queries:SoqlQuery[]=[];
  const unresolved:UnresolvedDynamicSoql[]=[];
  for(const site of engine.sites){
    const siteId=filePath+"@"+site.offset;
    const fail=(reason:string)=>unresolved.push({filePath,lineNumber:site.line,siteId,reason});
    if(flow.exceeded){fail("Apex analysis exceeded its bounded path or operation budget.");continue;}
    const captures=flow.captures.get(site.offset)??[];
    if(!captures.length){fail("Invocation is outside a supported method or execution path.");continue;}
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
        reason="Built query does not start with a supported SOQL SELECT.";
        break;
      }
      // The current field-access analyzer is SOQL-specific, not SOSL.
      if(!/^SELECT\b/i.test(queryText)){reason="SOSL is not supported by the SOQL analyzer.";break;}
      const parsed=parseNestedSoql(queryText,site.line);
      const fields=extractSoqlExpressionFields(queryText);
      if(!parsed||!fields.parsed||fields.limitations.length){
        reason="Complete query failed SOQL parsing: "+(fields.limitations[0]??"Root scope invalid.");
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
