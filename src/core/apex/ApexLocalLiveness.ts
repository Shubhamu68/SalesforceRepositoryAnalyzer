import type {ApexEnvironment} from "./ApexValueEvaluator.js";
import {maskApexSource,type IndexedApexMethod} from "./ApexSourceModel.js";

/**
 * Conservative liveness for immutable scalar locals at method-root statement
 * boundaries. No field, parameter, collection, reference or nested local is
 * eligible. Raw source references (including strings/comments) are counted
 * conservatively, so bind tokens and unsupported syntax cannot be discarded.
 *
 * Not a general control-flow liveness proof. In particular, never run this
 * projection between loop iterations or inside a nested branch.
 */
export class ApexLocalLiveness {
  private readonly lastReference=new Map<string,number>();
  constructor(source:string,method:IndexedApexMethod){
    const names=new Set<string>();
    const parameters=new Set(method.parameters.map(p=>p.toLowerCase()));
    for(const node of method.body){
      if(node.kind!=="statement")continue;
      const declaration=/^(?:final\s+)?(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(?:=|;)/i
        .exec(maskApexSource(node.text??"").trim());
      if(declaration&&!parameters.has(declaration[1].toLowerCase()))
        names.add(declaration[1].toLowerCase());
    }
    for(const match of source.slice(method.start,method.end).matchAll(/\b[A-Za-z_]\w*\b/g)){
      const name=match[0].toLowerCase();
      if(names.has(name))this.lastReference.set(name,method.start+match.index!+match[0].length);
    }
  }

  /** Values no longer lexically reachable from a subsequent statement cannot
   * distinguish the remaining method execution. Leave all alias-bearing state
   * and unknown ownership alone. */
  discardDeadScalars(values:ApexEnvironment,statementEnd:number):void {
    for(const [name,value] of values){
      if(value.kind!=="text"&&value.kind!=="number"&&value.kind!=="unknown")continue;
      const last=this.lastReference.get(name.toLowerCase());
      if(last!==undefined&&last<=statementEnd)values.delete(name);
    }
  }
}
