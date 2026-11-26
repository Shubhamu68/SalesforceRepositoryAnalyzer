import {simplePermissionShape,type SoqlPermissionShape} from "./soqlPermissionAggregation.js";
import {proveFiniteStringUseDomain} from "../core/apex/ApexFiniteScalarDomain.js";
import {indexApexMethods,maskApexSource,type IndexedApexMethod} from "../core/apex/ApexSourceModel.js";
import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import type {SoqlQuery} from "../models/SoqlQuery.js";
import type {DeclaredSoqlMode} from "./soqlExecutionMode.js";

export type SoqlReferenceCoverage="COMPLETE_FINITE_DOMAIN"|"PARTIAL_REFERENCES"|"RUNTIME_DEPENDENT"|"METADATA_OR_HELPER_UNAVAILABLE"|"SECURITY_MODE_CONFLICT"|"ANALYSIS_LIMIT"|"UNRESOLVED";
export interface FinitePermissionCoverage {alternatives:number;inventories:number;invalidAlternatives:number}
const group=(s:SoqlPermissionShape)=>s.object.toLowerCase()+"|"+s.mode;
const field=(f:SoqlPermissionShape["fields"][number])=>f.context+"|"+f.fieldPath.toLowerCase();

/** Prove that every permission-bearing alternative in a closed source
 * domain is represented by accepted, mode-consistent inventories.
 * This is a reference coverage certificate, NOT a grant decision or a
 * guarantee that every runtime invocation succeeds. */
export function verifyFinitePermissionCoverage(source:string,site:ApexCallSite,queries:readonly SoqlQuery[],
  mode:DeclaredSoqlMode|null|undefined,methods:readonly IndexedApexMethod[]=indexApexMethods(source)):FinitePermissionCoverage|undefined{
  if(mode===null||!queries.length||queries.some(q=>q.selectPrefixOnly||q.runtimeFieldCoverage)||/\bclass\s+(?:Database|String)\b/i.test(maskApexSource(source)))return undefined;
  const method=methods.filter(m=>m.start<=site.offset&&site.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!method)return undefined;
  const symbols=apexSymbols(source,methods);
  if(symbols.lookup(method,"Database",site.offset)||symbols.hasLocalBinding(method,"Database",site.offset))return undefined;
  const values=proveFiniteStringUseDomain(source,methods,method,site.argument.trim(),site.offset);
  if(!values?.length)return undefined;
  const expected=new Map<string,Set<string>>();
  let alternatives=0,invalidAlternatives=0;
  for(const v of values){
    if(v.kind!=="text"||v.values.length!==1||v.scalarType)return undefined;
    const text=v.values[0].trim();
    // A known empty query or a lone security clause cannot read data.
    // Do not silently accept any other parser-invalid alternative.
    if(!text||/^WITH\s+(?:USER_MODE|SYSTEM_MODE|SECURITY_ENFORCED)$/i.test(text)){invalidAlternatives++;continue;}
    const shape=simplePermissionShape(text,site.line);
    if(!shape||mode&&shape.mode!=="UNSPECIFIED"&&shape.mode!==mode)return undefined;
    const key=group(shape),refs=expected.get(key)??new Set<string>();
    shape.fields.forEach(f=>refs.add(field(f)));expected.set(key,refs);alternatives++;
  }
  if(!alternatives)return undefined;
  const observed=new Map<string,Set<string>>();
  for(const q of queries){
    const shape=simplePermissionShape(q.query,q.lineNumber);
    if(!shape||q.dynamicAccessLevel!==(mode||undefined))return undefined;
    const key=group(shape),refs=observed.get(key)??new Set<string>();
    shape.fields.forEach(f=>refs.add(field(f)));observed.set(key,refs);
  }
  if(expected.size!==observed.size)return undefined;
  for(const [key,refs] of expected){
    const actual=observed.get(key);
    if(!actual||refs.size!==actual.size||[...refs].some(f=>!actual.has(f)))return undefined;
  }
  return {alternatives,inventories:queries.length,invalidAlternatives};
}

/** Keep legacy callers conservative. Only a source certificate with all
 * inventories still present in the analyzed set removes the redundant
 * site-level uncertainty row. Field, parser and mode findings are separate. */
export function needsDynamicCoverageReview(site:{referenceCoverage?:SoqlReferenceCoverage;siteId?:string;finiteCoverage?:FinitePermissionCoverage;securityModeConflict?:boolean},queries:readonly SoqlQuery[]):boolean{
  if(site.securityModeConflict||site.referenceCoverage!=="COMPLETE_FINITE_DOMAIN"||!site.siteId||!site.finiteCoverage)return true;
  const accepted=queries.filter(q=>q.querySiteId===site.siteId);
  return accepted.length!==site.finiteCoverage.inventories||accepted.some(q=>q.referenceCoverage!=="COMPLETE_FINITE_DOMAIN"||q.selectPrefixOnly||q.runtimeFieldCoverage);
}
