import {maskApexSource,matchingPair,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import type {ApexValue} from "./ApexValueEvaluator.js";

/** A partial string with real source fragments is useful incoming evidence,
 * even when it is the only argument. Bare runtime unknowns are not seeds. */
export function hasIncomingArgumentEvidence(args:readonly ApexValue[]):boolean{
  return args.some(v=>v.kind!=="unknown"||v.fragments?.some(f=>f.kind==="literal"&&f.text.length>0));
}

/** Argument-only evidence for direct lexical calls to a private instance
 * helper. Do not infer receiver fields, virtual dispatch, calls on aliases,
 * or evaluation order in nested arguments. All arguments are scalar tokens
 * or lexical names; the ordinary flow engine still evaluates their values. */
export function isDirectPrivateInstanceCall(source:string,caller:IndexedApexMethod,offset:number,
  receiver:string|undefined,args:readonly string[]):boolean{
  if(caller.isStatic||(receiver!==undefined&&receiver.toLowerCase()!=="this"))return false;
  if(args.some(a=>! /^(?:'(?:\\.|[^'\\])*'|[-+]?\d+(?:\.\d+)?|[A-Za-z_]\w*)$/i.test(a.trim())||
    /^this$/i.test(a.trim())))return false;
  const at=(nodes:readonly SourceNode[]):SourceNode|undefined=>{
    for(const n of nodes){
      if(n.start>offset||offset>=n.end)continue;
      if(n.kind==="statement")return n;
      const nested=at(n.body??[])??at(n.otherwise??[]);
      if(nested)return nested;
    }
    return undefined;
  };
  const node=at(caller.body);
  if(!node)return false;
  const statement=maskApexSource(source.slice(node.start,node.end));
  const relative=offset-node.start;
  // Restrict to standalone calls or direct returns, never calls preceded
  // by another expression (including a receiver evaluation or assignment).
  if(!/^\s*(?:return\s+)?$/i.test(statement.slice(0,relative)))return false;
  const open=statement.indexOf("(",relative);
  if(open<0)return false;
  const close=matchingPair(statement,open);
  return close>=0&&/^\s*;?\s*$/.test(statement.slice(close+1));
}
