import {indexApexMethods,maskApexSource,matchingPair,sourceLine,splitApexTopLevel,type IndexedApexMethod} from "./ApexSourceModel.js";

/** Consumers choose invocation names and the arguments that matter to them.
 * The core never needs to know the business meaning of those arguments. */
export interface ApexInvocationSelection {
  method:string;
  argumentIndices:readonly number[];
}
export type ApexInvocationSelector=(qualifiedName:string,args:readonly string[])=>ApexInvocationSelection|undefined;
export interface ApexCallSite {
  offset:number;
  line:number;
  method:string;
  arguments:readonly string[];
  /** Backward-compatible aliases for existing SOQL consumers. */
  argument:string;
  accessLevelArgument?:string;
}
// Cache only the built-in pure selector. User-supplied selectors may carry
// state, so never memoize their decisions. Lifetime follows the syntax cache.
const databaseSites=new WeakMap<IndexedApexMethod[],ApexCallSite[]>();
export function discoverApexInvocations(source:string,select:ApexInvocationSelector,methods?:IndexedApexMethod[]):ApexCallSite[]{
  const key=select===dynamicDatabaseQuerySelector?(methods??indexApexMethods(source)):undefined;
  const cached=key?databaseSites.get(key):undefined;
  if(cached)return cached.map(site=>({...site,arguments:[...site.arguments]}));
  const masked=maskApexSource(source);
  const call=/\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g;
  const sites:ApexCallSite[]=[];
  for(const match of masked.matchAll(call)){
    const name=match[1].replace(/\s+/g,"");
    // Avoid matching parentheses and splitting unrelated invocation arguments.
    if(select===dynamicDatabaseQuerySelector&&!/^Database\.(?:queryWithBinds|countQueryWithBinds|getQueryLocatorWithBinds|query|countQuery|getQueryLocator)$/i.test(name))continue;
    const open=masked.indexOf("(",match.index!);
    const end=matchingPair(masked,open);
    const args=end<0?[]:splitApexTopLevel(source.slice(open+1,end),",");
    const choice=select(name,args);
    if(!choice)continue;
    const selected=choice.argumentIndices.map(index=>args[index]??"");
    sites.push({offset:match.index!,line:sourceLine(source,match.index!),method:choice.method,
      arguments:selected,argument:selected[0]??"",
      ...(selected[1]?{accessLevelArgument:selected[1]}:{})});
  }
  if(key)databaseSites.set(key,sites.map(site=>({...site,arguments:[...site.arguments]})));
  return sites;
}

/** Compatibility selector for the existing dynamic SOQL entry point. New
 * analysis consumers provide their own selection instead of changing core. */
export const dynamicDatabaseQuerySelector:ApexInvocationSelector=(name,args)=>{
  const method=/^Database\.(queryWithBinds|countQueryWithBinds|getQueryLocatorWithBinds|query|countQuery|getQueryLocator)$/i.exec(name)?.[1];
  if(!method||/^\s*\[\s*SELECT\b/i.test(args[0]??""))return undefined;
  const access=/withbinds$/i.test(method)?2:1;
  return {method,argumentIndices:args[access]?[0,access]:[0]};
};
