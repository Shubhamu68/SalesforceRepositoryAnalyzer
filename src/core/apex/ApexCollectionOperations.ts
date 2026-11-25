import {listValue,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import {stripApexComments,type SourceNode} from "./ApexSourceModel.js";
import {readApexReadOperation} from "./ApexReadOperations.js";

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


/** Unknown additional String members, distinct from an exact collection.
 * A Describe domain is preserved only when every unknown member is
 * constrained to a field-map key (up to case). No runtime values invented. */
export interface ApexRuntimeCollectionMembers {describeObject?:string}
export function mergeApexRuntimeMembers(a:ApexRuntimeCollectionMembers|undefined,b:ApexRuntimeCollectionMembers|undefined):ApexRuntimeCollectionMembers|undefined{
  if(!a)return b;if(!b)return a;
  return a.describeObject&&a.describeObject.toLowerCase()===b.describeObject?.toLowerCase()?a:{};
}
interface AddOnlyIteration {membership?:{receiver:string;key:string};caseOnly:boolean;usesStringGuard:boolean}
/** Prove an iteration's only effect is adding a projection of its String
 * element, optionally under a supported read-only guard. Reject all other
 * effects, including unknown calls, reassignment, else, and early exits.
 * Uses shared parser nodes and read-operation recognition. */
export function proveApexAddOnlyIteration(nodes:readonly SourceNode[],target:string,item:string):AddOnlyIteration|undefined{
  const clean=(s:string)=>stripApexComments(s).trim();
  const same=(s:string)=>s.toLowerCase()===item.toLowerCase();
  const projection=(s:string):"case"|"trim"|undefined=>{
    s=clean(s);if(same(s))return "case";
    const read=readApexReadOperation(s);
    if(!read||read.args.length)return undefined;
    const parent=projection(read.receiver);
    if(!parent)return undefined;
    if(/^(?:toLowerCase|toUpperCase)$/i.test(read.name))return parent;
    if(/^trim$/i.test(read.name))return "trim";
    return undefined;
  };
  let membership:AddOnlyIteration["membership"],usesStringGuard=false;
  let current=nodes;
  while(current.length===1){
    const node=current[0];
    if(node.kind==="block"){current=node.body??[];continue;}
    if(node.kind==="if"&&!node.otherwise?.length){
      const condition=clean(node.condition??"");
      const nonblank=/^String\s*\.\s*isNotBlank\s*\(\s*([A-Za-z_]\w*)\s*\)$/i.exec(condition);
      if(nonblank&&same(nonblank[1]))usesStringGuard=true;
      else{
        const read=readApexReadOperation(condition);
        if(membership||!read||read.name.toLowerCase()!=="containskey"||read.args.length!==1||
          !/^[A-Za-z_]\w*$/.test(read.receiver)||projection(read.args[0])!=="case")return undefined;
        membership={receiver:read.receiver,key:read.args[0]};
      }
      current=node.body??[];continue;
    }
    if(node.kind!=="statement")return undefined;
    const add=/^([A-Za-z_]\w*)\s*\.\s*add\s*\(([\s\S]*)\)\s*;$/i.exec(clean(node.text??""));
    if(!add||add[1].toLowerCase()!==target.toLowerCase())return undefined;
    const projected=projection(add[2]);
    if(!projected||membership&&projected!=="case")return undefined;
    return {membership,caseOnly:projected==="case",usesStringGuard};
  }
  return undefined;
}
