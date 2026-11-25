import {maskApexSource,type SourceNode} from "./ApexSourceModel.js";
import {declaredLoopLocals} from "./ApexLocalLiveness.js";

/** A bounded lexical may-write summary, not an execution or purity proof.
 * Locals declared inside the loop cannot escape as invented outer bindings.
 * Unknown helper calls are retained for the engine's reference-escape checks. */
export function summarizeUnknownLoopEffects(node:SourceNode):{
  writes:Set<string>; locals:Set<string>; callSources:string[]; possibleReturn:boolean; opaque:boolean; aliasSources:Set<string>
}{
  const writes=new Set<string>(),locals=new Set<string>(),callSources:string[]=[];
  let possibleReturn=false,opaque=false;
  const aliasSources=new Set<string>();
  const collect=(nodes:readonly SourceNode[])=>{
    for(const local of declaredLoopLocals(nodes))locals.add(local.toLowerCase());
    for(const item of nodes){
      if(item.loopVariable)locals.add(item.loopVariable.toLowerCase());
      collect(item.body??[]);collect(item.otherwise??[]);
    }
  };
  if(node.loopVariable)locals.add(node.loopVariable.toLowerCase());
  collect(node.body??[]);
  const headerLocal=/^\s*(?:final\s+)?[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*=/i.exec(maskApexSource(node.text??""));
  if(headerLocal)locals.add(headerLocal[1].toLowerCase());
  const scan=(source:string)=>{
    const visible=maskApexSource(source);
    if(/\breturn\b/i.test(visible))possibleReturn=true;
    // Include direct writes, compound writes, indexed writes and collection
    // mutations; assignment matching must not consume comparisons or arrows.
    const pattern=/\b((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(?:=(?!=|>)|[+\-*/%&|^]=|\+\+|--|\.\s*(?:add|addAll|clear|remove|put|putAll|removeAll|retainAll|set|sort|reverse)\s*\()/gi;
    for(const match of visible.matchAll(pattern))writes.add(match[1].replace(/\s/g,""));
    for(const match of visible.matchAll(/(?:\+\+|--)\s*((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\b/g))writes.add(match[1].replace(/\s/g,""));
    // A local alias of an outer reference may later escape under another
    // name. Retain the source binding as a potential reference mutation.
    const alias=/=\s*([A-Za-z_]\w*)(?:\s*\.\s*[A-Za-z_]\w*)*\s*;/i.exec(visible);
    if(alias)aliasSources.add(alias[1].toLowerCase());
    if(visible.includes("("))callSources.push(source);
  };
  const walk=(nodes:readonly SourceNode[])=>{
    for(const child of nodes){
      if(child.kind==="opaque")opaque=true;
      if(child.text)scan(child.text);
      if(child.condition)scan(child.condition);
      if(child.iterable)scan(child.iterable);
      walk(child.body??[]);walk(child.otherwise??[]);
    }
  };
  if(node.text)scan(node.text);
  if(node.condition)scan(node.condition);
  walk(node.body??[]);
  return {writes,locals,callSources,possibleReturn,opaque,aliasSources};
}
