import type {ApexEnvironment,ApexValue} from "./ApexValueEvaluator.js";

/** Canonical state identity must preserve collection aliases as well as their
 * contents: two equal-but-independent Lists are not interchangeable with
 * two names for one List. Scalar values are immutable. */
export function apexStateIdentity(values:ApexEnvironment,stopped:boolean):string {
  const references=new Map<ApexValue,number>();
  const encode=(value:ApexValue):unknown=>{
    if(value.kind!=="collection"&&value.kind!=="map"&&value.kind!=="instance")return value;
    const previous=references.get(value);
    if(previous!==undefined)return ["alias",previous];
    const id=references.size;
    references.set(value,id);
    return value.kind==="collection"
      ?["collection",id,value.unique,value.items]
      :[value.kind,id,value.kind==="instance"?value.className:null,value.entries.map(([key,item])=>[key,encode(item)])];
  };
  return JSON.stringify([stopped,[...values.entries()]
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,encode(value)])]);
}
