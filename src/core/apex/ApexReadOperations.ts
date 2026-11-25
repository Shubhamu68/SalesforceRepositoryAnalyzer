import {maskApexSource,matchingPair,splitApexTopLevel} from "./ApexSourceModel.js";
import {isBoundedStringOperation} from "./ApexBoundedStringOperations.js";

const ordinary=new Set(["trim","tolowercase","touppercase","split","isempty","contains","containsignorecase","equalsignorecase","removeend","containskey","keyset","get","getfieldpath"]);
export interface ApexReadOperation {receiver:string;name:string;args:string[]}
/** Shared read-only operation syntax. Value provenance is the caller's responsibility. */
export function readApexReadOperation(expression:string):ApexReadOperation|undefined{
  const visible=maskApexSource(expression);
  for(const match of visible.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)){
    if(!ordinary.has(match[1].toLowerCase())&&!isBoundedStringOperation(match[1]))continue;
    const open=match.index!+match[0].length-1;
    if(matchingPair(visible,open)!==visible.length-1)continue;
    const receiver=expression.slice(0,match.index).trim(),input=expression.slice(open+1,-1).trim();
    if(receiver)return {receiver,name:match[1],args:input?splitApexTopLevel(input,","):[]};
  }
  return undefined;
}
