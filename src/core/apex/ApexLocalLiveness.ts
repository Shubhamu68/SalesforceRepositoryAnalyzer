import type {ApexEnvironment} from "./ApexValueEvaluator.js";
import {maskApexSource,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";

/**
 * Conservative lexical liveness for uniquely declared immutable scalar
 * locals and parameters, including straight-line nested branch statements.
 * Raw references include strings/comments and bind tokens. Never project
 * within a loop: earlier lexical references may execute again.
 */
export class ApexLocalLiveness {
  private readonly lastReference=new Map<string,number>();
  private readonly loops:Array<{start:number;end:number}>=[];
  constructor(source:string,method:IndexedApexMethod,stopOffset?:number){
    const names=new Set<string>();
    const parameters=new Set(method.parameters.map(p=>p.toLowerCase()));
    method.parameters.forEach((name,i)=>{
      if(/^(?:String|Boolean|Integer|Long|Decimal|Double|Id|Date|Datetime)$/i.test(method.parameterTypes?.[i]??""))names.add(name.toLowerCase());
    });
    const declarations=new Map<string,number>();
    const scalars=new Set<string>();
    const visit=(nodes:readonly SourceNode[])=>{
      for(const node of nodes){
        if(node.kind==="for")this.loops.push({start:node.start,end:node.end});
        if(node.kind==="statement"){
          const visible=maskApexSource(node.text??"").trim();
          const declaration=/^(?:final\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>]+>)?(?:\[\])?\s+([A-Za-z_]\w*)\s*(?:=|;)/i.exec(visible);
          if(declaration){
            const name=declaration[1].toLowerCase();
            declarations.set(name,(declarations.get(name)??0)+1);
            if(/^(?:final\s+)?(?:String|Boolean|Integer|Long|Decimal|Double|Id|Date|Datetime)\s+/i.test(visible))scalars.add(name);
          }
        }
        visit(node.body??[]);visit(node.otherwise??[]);
      }
    };
    visit(method.body);
    for(const name of scalars)if(declarations.get(name)===1&&!parameters.has(name))names.add(name);
    // A declaration shadowing a parameter, including an unsupported local
    // type, makes lexical ownership ambiguous.
    for(const name of parameters)if(declarations.has(name))names.delete(name);
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
  discardDeadScalars(values:ApexEnvironment,statementEnd:number,statementStart?:number):void {
    if(statementStart!==undefined&&this.loops.some(loop=>loop.start<statementStart&&statementStart<loop.end))return;
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
