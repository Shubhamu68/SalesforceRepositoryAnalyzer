import type {ApexEnvironment,ApexValue} from "./ApexValueEvaluator.js";
import {unknown} from "./ApexValueEvaluator.js";
export function isApexReference(value:ApexValue):boolean{
  return value.kind==="collection"||value.kind==="map"||value.kind==="instance"||value.kind==="instanceList";
}
export function lexicalValue(values:ReadonlyMap<string,ApexValue>,name:string):ApexValue|undefined{
  const exact=values.get(name);if(exact!==undefined)return exact;
  const lower=name.toLowerCase(),matches=[...values].filter(([key])=>key.toLowerCase()===lower);
  return matches.length===1?matches[0][1]:undefined;
}
/** Walk only explicitly modeled object fields, not arbitrary properties. */
export function referenceMember(values:ReadonlyMap<string,ApexValue>,path:string):ApexValue|undefined{
  const parts=path.split(".");let value=lexicalValue(values,parts.shift()!);
  if(value===undefined)return undefined;
  for(const part of parts){
    if(value.kind==="unknown")return value;
    if(value.kind!=="instance"&&value.kind!=="record")return undefined;
    const entry=value.entries.filter(([key])=>key.toLowerCase()===part.toLowerCase());
    if(entry.length!==1)return unknown("Instance member path is not proven: "+path);
    value=entry[0][1];
  }
  return value;
}
/** Preserve all reachable aliases, including nested references. Return no
 * proof on cycles or an oversized graph; never silently truncate pins. */
export function collectApexReferences(inputs:readonly ApexValue[],limit=128):ApexValue[]|undefined{
  const refs=new Set<ApexValue>(),active=new Set<ApexValue>();
  const visit=(value:ApexValue,depth:number):boolean=>{
    if(!isApexReference(value))return true;
    if(active.has(value)||depth>12)return false;
    if(refs.has(value))return true;
    if(refs.size>=limit)return false;
    refs.add(value);active.add(value);
    const children=value.kind==="instanceList"?value.items:
      value.kind==="instance"||value.kind==="map"?value.entries.map(([,item])=>item):[];
    const ok=children.every(child=>visit(child,depth+1));
    active.delete(value);return ok;
  };
  return inputs.every(value=>visit(value,0))?[...refs]:undefined;
}
/** Simultaneous identity-based substitutions. An updated root already
 * carries its updated descendants; do not rewrite it a second time. */
export function replaceApexReferences(values:ApexEnvironment,replacements:ReadonlyMap<ApexValue,ApexValue>):boolean{
  let found=false;
  const memo=new Map<ApexValue,ApexValue>();
  const visit=(value:ApexValue,depth:number):ApexValue=>{
    const replacement=replacements.get(value);if(replacement!==undefined){found=true;return replacement;}
    if(!isApexReference(value))return value;
    if(depth>12)return unknown("Reference update exceeded supported nesting.");
    const cached=memo.get(value);if(cached!==undefined)return cached;
    let result=value;
    if(value.kind==="instanceList"){
      const items=value.items.map(v=>visit(v,depth+1));if(items.some((v,i)=>v!==value.items[i]))result={...value,items};
    }else if(value.kind==="instance"||value.kind==="map"){
      const entries=value.entries.map(([k,v]):[string,ApexValue]=>[k,visit(v,depth+1)]);
      if(entries.some(([,v],i)=>v!==value.entries[i][1]))result={...value,entries};
    }
    memo.set(value,result);return result;
  };
  for(const [key,value] of values)values.set(key,visit(value,0));
  return found;
}
