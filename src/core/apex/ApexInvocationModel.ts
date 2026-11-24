import {maskApexSource,matchingPair,sourceLine,splitApexTopLevel} from "./ApexSourceModel.js";

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
export function discoverApexInvocations(source:string,select:ApexInvocationSelector):ApexCallSite[]{
  const masked=maskApexSource(source);
  const call=/\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g;
  const sites:ApexCallSite[]=[];
  for(const match of masked.matchAll(call)){
    const open=masked.indexOf("(",match.index!);
    const end=matchingPair(masked,open);
    const args=end<0?[]:splitApexTopLevel(source.slice(open+1,end),",");
    const name=match[1].replace(/\s+/g,"");
    const choice=select(name,args);
    if(!choice)continue;
    const selected=choice.argumentIndices.map(index=>args[index]??"");
    sites.push({offset:match.index!,line:sourceLine(source,match.index!),method:choice.method,
      arguments:selected,argument:selected[0]??"",
      ...(selected[1]?{accessLevelArgument:selected[1]}:{})});
  }
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
