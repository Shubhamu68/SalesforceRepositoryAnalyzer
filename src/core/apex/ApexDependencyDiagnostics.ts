import {sourceLine} from "./ApexSourceModel.js";

/** Opt-in, source-only diagnostic. No expression text, values, metadata
 * responses, absolute paths or raw provider/exception reasons. */
export interface ApexDependencyDiagnostic {
  code:string;
  file:string;
  line:number;
  method?:string;
  symbol?:string;
  depth:number;
  count?:number;
}
export type ApexDependencyObserver=(event:ApexDependencyDiagnostic)=>void;
export function sourceFileName(filePath:string):string{
  const name=filePath.split(/[\\/]/).at(-1)??"";
  return /^[A-Za-z0-9_.-]{1,180}$/.test(name)?name:"<source>";
}
export function sourceIdentifier(name?:string):string|undefined{
  return name&&/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(name)?name:undefined;
}
export function reportApexDependency(observer:ApexDependencyObserver|undefined,code:string,
  frame:{filePath:string;source:string;depth:number;method?:{name:string}},offset:number,symbol?:string,count?:number):void{
  if(!observer)return;
  observer({code,file:sourceFileName(frame.filePath),line:sourceLine(frame.source,offset),
    method:sourceIdentifier(frame.method?.name),symbol:sourceIdentifier(symbol),depth:frame.depth,
    ...(count===undefined?{}:{count})});
}
