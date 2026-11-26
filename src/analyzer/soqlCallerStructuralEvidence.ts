import {indexApexMethods,maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod,type SourceNode} from "../core/apex/ApexSourceModel.js";
import type {ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {evaluateApexCallerStringTemplate} from "../core/apex/ApexCallerStringTemplate.js";
import {collectApexLiteralStringReturns} from "../core/apex/ApexLiteralReturnEvidence.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {provePartialSoql} from "./soqlPartialStructure.js";
import {simplePermissionShape} from "./soqlPermissionAggregation.js";

const clean=(s:string)=>stripApexComments(s).trim();
const word=(name:string)=>new RegExp("\\b"+name+"\\b","i");

interface Template {owner:IndexedApexMethod;expression:string;prefix:SourceNode[]}
export function directTemplate(source:string,site:ApexCallSite,methods:IndexedApexMethod[]):Template|undefined{
  const owner=methods.filter(m=>m.start<=site.offset&&site.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!owner)return undefined;
  const target=owner.body.find(n=>n.kind==="statement"&&n.start<=site.offset&&site.offset<n.end);
  if(!target)return undefined;
  const prior=owner.body.filter(n=>n.end<=target.start);
  const argument=clean(site.argument);
  // Require a direct invocation statement, not an expression with additional
  // side effects or an argument evaluated after a mutating nested call.
  const raw=clean(target.text??"");
  const invocation=/^(?:return\s+(?:\([\w\s<>,.\[\]]+\)\s*)?|[\w\s<>,.\[\]]+\s+[A-Za-z_]\w*\s*=\s*)?Database\s*\.\s*(?:query|countQuery|getQueryLocator)\s*\(/i.exec(raw);
  if(!invocation)return undefined;
  const opening=invocation[0].length-1,close=matchingPair(maskApexSource(raw),opening);
  if(close<0||raw.slice(close+1).trim()!==";")return undefined;
  if(/^[A-Za-z_]\w*$/.test(argument)&&!owner.parameters.some(p=>p.toLowerCase()===argument.toLowerCase())){
    const def=new RegExp("^String\\s+"+argument+"\\s*=\\s*([\\s\\S]+);$","i");
    const matches=prior.flatMap((n,i)=>{
      const hit=n.kind==="statement"?def.exec(clean(n.text??"")):null;
      return hit?[{expression:hit[1],i}]:[];
    });
    if(matches.length!==1)return undefined;
    const match=matches[0];
    // No reassignments or aliasing of the query after its declaration.
    if(prior.slice(match.i+1).some(n=>word(argument).test(maskApexSource(source.slice(n.start,n.end)))))return undefined;
    return {owner,expression:match.expression,prefix:prior.filter((_,i)=>i!==match.i)};
  }
  return {owner,expression:argument,prefix:prior};
}

/** Interpret generic caller String candidates as SOQL only in this adapter. */
export function proveCallerPermissionShapes(source:string,site:ApexCallSite,seeds:readonly ApexValue[][],methods=indexApexMethods(source)):string[]{
  const template=directTemplate(source,site,methods);
  if(!template)return [];
  const result=new Set<string>();
  for(const value of evaluateApexCallerStringTemplate(source,template.owner,template.expression,template.prefix,site.offset,seeds,methods)){
    const texts=value.kind==="text"?value.values:[provePartialSoql(value)?.text];
    for(const text of texts)if(text&&simplePermissionShape(text,site.line))result.add(text.trim());
  }
  return [...result];
}
export function proveLiteralHelperPermissionShapes(source:string,site:ApexCallSite,methods=indexApexMethods(source)):string[]{
  const template=directTemplate(source,site,methods);
  if(!template)return [];
  const values=collectApexLiteralStringReturns(source,template.owner,template.expression,template.prefix,methods);
  return values.every(value=>!!simplePermissionShape(value,site.line))?values:[];
}
