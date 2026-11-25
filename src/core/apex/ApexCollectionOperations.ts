import {listValue,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";

export type ApexStringCollection=Extract<ApexValue,{kind:"collection"}>;
/** Exact mutations. Candidate-union semantics remain in the backward caller. */
export function applyApexStringCollectionMutation(existing:ApexStringCollection,operation:string,args:readonly ApexValue[],expression:string):ApexValue{
  const action=operation.toLowerCase(),arg=args[0];
  const item=arg?.kind==="text"&&arg.values.length===1?arg.values[0]:undefined;
  if(action==="clear"&&args.length===0)return listValue([],existing.unique);
  if(action==="add"&&args.length===1&&item!==undefined)return listValue([...existing.items,item],existing.unique);
  if(action==="addall"&&args.length===1&&arg?.kind==="collection")return listValue([...existing.items,...arg.items],existing.unique);
  if(action==="remove"&&args.length===1&&existing.unique&&item!==undefined)return listValue(existing.items.filter(v=>v!==item),true);
  if(action==="remove"&&args.length===1&&!existing.unique&&arg?.kind==="number"&&Number.isInteger(arg.value)&&arg.value>=0&&arg.value<existing.items.length)
    return listValue(existing.items.filter((_,i)=>i!==arg.value),false);
  if(action==="add"||action==="addall")return unknown("Collection "+operation+" argument "+expression+" is unknown: "+(arg?(arg.kind==="unknown"?arg.reason:"unsupported value shape"):"missing argument"));
  return unknown("Unsupported mutation "+operation+" may change the complete query field inventory.");
}
/** Known bounded elements. Instance lists retain reference-aware replay in forward flow. */
export function apexIterationValues(value:ApexValue,limit:number):ApexValue[]|undefined{
  if(value.kind==="collection"&&value.items.length<=limit)return value.items.map(textValue);
  if(value.kind==="records"&&value.items.length<=limit)return value.items.map(entries=>({kind:"record",entries}));
  return undefined;
}
