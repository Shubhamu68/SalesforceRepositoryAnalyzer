import type {ApexEnvironment} from "./ApexValueEvaluator.js";
import {maskApexSource,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";

/**
 * Conservative liveness for immutable scalar locals at method-root statement
 * boundaries. Declared scalar parameters are also eligible after their
 * last lexical reference. Fields, collections, references and nested locals are not. Raw source references (including strings/comments) are counted
 * conservatively, so bind tokens and unsupported syntax cannot be discarded.
 *
 * Not a general control-flow liveness proof. In particular, never run this
 * projection between loop iterations or inside a nested branch.
 */
export class ApexLocalLiveness {
  private readonly lastReference=new Map<string,number>();
  constructor(source:string,method:IndexedApexMethod,stopOffset?:number){
    const names=new Set<string>();
    const parameters=new Set(method.parameters.map(p=>p.toLowerCase()));
    method.parameters.forEach((name,i)=>{
      if(/^(?:String|Boolean|Integer|Long|Decimal|Double|Id|Date|Datetime)$/i.test(method.parameterTypes?.[i]??""))names.add(name.toLowerCase());
    });
    for(const node of method.body){
      if(node.kind!=="statement")continue;
      const declaration=/^(?:final\s+)?(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(?:=|;)/i
        .exec(maskApexSource(node.text??"").trim());
      if(declaration&&!parameters.has(declaration[1].toLowerCase()))
        names.add(declaration[1].toLowerCase());
    }
    // Include the complete root statement/block that contains the site. A
    // query in a loop can observe later lexical references on its next iteration.
    const root=stopOffset===undefined?undefined:method.body.find(node=>node.start<=stopOffset&&stopOffset<node.end);
    const end=root?.end??method.end;
    for(const match of source.slice(method.start,end).matchAll(/\b[A-Za-z_]\w*\b/g)){
      const name=match[0].toLowerCase();
      if(names.has(name))this.lastReference.set(name,method.start+match.index!+match[0].length);
    }
  }

  /** Local/parameter scalar values no longer lexically reachable from a subsequent statement cannot
   * distinguish the remaining method execution. Leave all alias-bearing state
   * and unknown ownership alone. */
  discardDeadScalars(values:ApexEnvironment,statementEnd:number):void {
    for(const [name,value] of values){
      if(value.kind!=="text"&&value.kind!=="number"&&value.kind!=="unknown"&&value.kind!=="null")continue;
      const last=this.lastReference.get(name.toLowerCase().replace(/^#predicate:/,""));
      if(last!==undefined&&last<=statementEnd)values.delete(name);
    }
  }
}

/** Identify only explicit direct declarations in a loop body. Unqualified
 * assignments to class fields or other outer symbols are not loop locals. */
export function declaredLoopLocals(nodes:readonly SourceNode[]):Set<string>{
  const names=new Set<string>();
  for(const node of nodes){
    if(node.kind!=="statement")continue;
    const declaration=/^(?:final\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>]+>)?(?:\[\])?\s+([A-Za-z_]\w*)\s*(?:=|;)/i
      .exec(maskApexSource(node.text??"").trim());
    if(declaration)names.add(declaration[1]);
  }
  return names;
}

/** Cache only frozen syntax; independent of evaluator state and metadata. */
const livenessCache=new WeakMap<IndexedApexMethod,Map<number,ApexLocalLiveness>>();
export function sharedApexLocalLiveness(source:string,method:IndexedApexMethod,stopOffset?:number):ApexLocalLiveness{
  if(!Object.isFrozen(method))return new ApexLocalLiveness(source,method,stopOffset);
  let cache=livenessCache.get(method);
  if(!cache){cache=new Map();livenessCache.set(method,cache);}
  // Several sites within the same outer statement have the same prefix.
  const root=stopOffset===undefined?undefined:method.body.find(n=>n.start<=stopOffset&&stopOffset<n.end);
  const key=root?.end??method.end;
  const previous=cache.get(key);
  if(previous)return previous;
  const value=new ApexLocalLiveness(source,method,stopOffset);
  if(cache.size>=32)cache.delete(cache.keys().next().value!);
  cache.set(key,value);return value;
}
