import {maskApexSource,type SourceNode} from "./ApexSourceModel.js";

/** Shared declaration recognizer for source slicing and symbolic execution. */
export function trackedStandaloneDeclaration(statement:string):string|undefined {
  return /^(?:final\s+)?(?:String|List<[^>]+>|Set<[^>]+>|Integer|Boolean)\s+([A-Za-z_]\w*)\s*;?\s*$/i
    .exec(statement.trim())?.[1];
}

/**
 * Query-site backward dependency slice. Only simple, provably side-effect-free
 * statements are eligible for pruning. Calls, control-flow exits and opaque
 * Apex remain live unless explicitly demonstrated irrelevant.
 */
export function invocationDependencySlice(nodes:SourceNode[], offset:number, expression:string):Set<SourceNode> {
  const live=new Set<SourceNode>();
  const relevant=new Set<string>();
  const identifiers=(text:string):string[]=>[...maskApexSource(text).matchAll(/\b[A-Za-z_]\w*\b/g)]
    .map(match=>match[0].toLowerCase());
  for(const name of identifiers(expression))relevant.add(name);
  const mark=(node:SourceNode):boolean=>{
    if(node.start>offset)return false;
    const isTarget=node.start<=offset&&node.end>offset;
    if(node.kind==="opaque"){live.add(node);return true;}
    if(node.kind==="statement") {
      const statement=(node.text??"").trim();
      const includesCall=isTarget;
      const terminates=/^(?:return|throw|break|continue)\b/i.test(statement);
      const assignment=/\b([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]+?);?\s*$/.exec(statement);
      const mutation=/\b([A-Za-z_]\w*)\s*\.\s*(?:add|addAll|clear|remove|put|putAll)\s*\(/i.exec(statement);
      const memberWrite=/^\s*[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+\s*(?:\+?=)(?!=|>)/.test(maskApexSource(statement));
      const write=(assignment?.[1]??mutation?.[1])?.toLowerCase();
      // Keeping a referenced outer declaration preserves its lexical scope:
      // otherwise branch cleanup incorrectly deletes assignments to it.
      const declaration=trackedStandaloneDeclaration(statement)?.toLowerCase();
      // Methods may mutate collections by reference or instance state.
      // Keep calls until an explicit side-effect model proves them harmless.
      const calls=[...maskApexSource(statement).matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(/g)];
      const containsCall=calls.length>0;
      const safeDebug=calls.length===1&&/^System\.debug\s*\(/i.test(statement);
      // Only simple declared scalar/local writes may be pruned. Preserve
      // unfamiliar statements (DML, indexed writes, increments, callouts).
      const simpleWrite=!!assignment&&/^(?:(?:final\s+)?(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+)?[A-Za-z_]\w*\s*\+?=(?!=|>)/i.test(maskApexSource(statement));
      const unfamiliar=!simpleWrite&&!declaration&&!safeDebug;
      const needed=includesCall||terminates||memberWrite||unfamiliar||(write!==undefined&&relevant.has(write))||
        (declaration!==undefined&&relevant.has(declaration))||
        (containsCall&&!safeDebug)||(!write&&/[\[\]{}]/.test(statement));
      if(!needed)return false;
      live.add(node);
      // Member writes can change the value read through another alias. Keep
      // the receiver declaration and its reference-producing dependencies.
      if(memberWrite||unfamiliar)for(const name of identifiers(statement))relevant.add(name);
      if(write!==undefined&&relevant.has(write)) {
        for(const name of identifiers(assignment?.[3]??statement))relevant.add(name);
      }
      // A retained unknown call may mutate a relevant collection or shared state.
      if(containsCall&&!safeDebug)for(const name of identifiers(statement))relevant.add(name);
      return true;
    }
    let childNeeded=false;
    const children=[...(node.body??[]),...(node.otherwise??[])];
    // A write near the end of a loop can feed a read at the beginning of
    // the next iteration. Revisit loop dependencies to a fixed point.
    do{
      const before=relevant.size;
      for(let i=children.length-1;i>=0;i--)if(mark(children[i]))childNeeded=true;
      if(node.kind!=="for"||before===relevant.size)break;
    }while(true);
    const condition=(node.condition??"")+" "+(node.iterable??"");
    const conditionCalls=[...maskApexSource(condition).matchAll(
      /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)].map(match=>match[1]);
    const opaqueCondition=conditionCalls.some(name=>
      !/^(?:String\.(?:isBlank|isNotBlank)|Math\.\w+)$/i.test(name));
    const needed=isTarget||childNeeded||opaqueCondition;
    if(needed) {
      live.add(node);
      for(const name of identifiers(condition))relevant.add(name);
    }
    return needed;
  };
  // A later-discovered receiver or loop dependency can make an earlier
  // skipped statement relevant. Recompute to a bounded fixed point; on
  // exhaustion use the unsliced body rather than drop possible effects.
  for(let pass=0;pass<8;pass++){
    const before=live.size+relevant.size;
    for(let i=nodes.length-1;i>=0;i--)mark(nodes[i]);
    if(before===live.size+relevant.size)return live;
  }
  const retain=(items:SourceNode[])=>{for(const node of items){if(node.start>offset)continue;live.add(node);retain(node.body??[]);retain(node.otherwise??[]);}};
  retain(nodes);
  return live;
}
