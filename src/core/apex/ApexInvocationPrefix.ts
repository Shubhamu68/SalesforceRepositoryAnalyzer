import type {SourceNode} from "./ApexSourceModel.js";

/** A query/inspection argument has a lexical execution target. If a target
 * is inside a loop, an earlier iteration can visit either branch and modify
 * the next iteration, so prefix pruning must be disabled there. */
export function targetWithinLoop(nodes:readonly SourceNode[],offset:number):boolean{
  for(const node of nodes){
    if(offset<node.start||offset>=node.end)continue;
    if(node.kind==="for")return true;
    return targetWithinLoop(node.body??[],offset)||targetWithinLoop(node.otherwise??[],offset);
  }
  return false;
}
/** Only direct lexical ownership is proof; conditions and header calls do
 * not belong to either body. No expression/dispatch assumptions. */
export function targetBranch(node:SourceNode,offset:number):"then"|"else"|undefined{
  if(node.kind!=="if"||offset<node.start||offset>=node.end)return undefined;
  if(node.body?.some(child=>child.start<=offset&&offset<child.end))return "then";
  if(node.otherwise?.some(child=>child.start<=offset&&offset<child.end))return "else";
  return undefined;
}
