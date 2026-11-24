import {maskApexSource,matchingPair} from "./ApexSourceModel.js";
import type {ApexValue} from "./ApexValueEvaluator.js";

/** A conditional expression is not an unconditional call-site. Unknown or
 * unsupported syntax always remains possible; never invent a skipped branch.
 * Offsets are kept in the original source, including quoted Apex literals. */
export function invocationMayExecute(statement:string,offset:number,
  evaluate:(expression:string)=>ApexValue):boolean{
  const masked=maskApexSource(statement);
  // Extract the expression of a simple assignment or return. Do not mistake
  // equality tests, map arrows or assignments inside call arguments for it.
  let start=0,end=masked.length;
  const assignment=/^\s*(?:(?:final\s+)?[A-Za-z_]\w*(?:\s*<[\w\s,.<>]+>)?(?:\[\])?\s+)?[A-Za-z_]\w*\s*\+?=(?!=|>)/i.exec(masked);
  const returned=/^\s*return\s+/i.exec(masked);
  if(assignment)start=assignment[0].length;
  else if(returned)start=returned[0].length;
  if(offset<start||offset>=end)return true;
  const visit=(from:number,to:number,depth:number):boolean=>{
    if(depth>24)return true;
    let nesting=0,question=-1,colon=-1,inner=0;
    for(let i=from;i<to;i++){
      const ch=masked[i];
      if("([{".includes(ch)){nesting++;continue;}
      if(")]}".includes(ch)){nesting--;continue;}
      if(nesting!==0)continue;
      if(ch==="?"){
        if(question<0)question=i;
        else inner++;
      }else if(ch===":"&&question>=0){
        if(inner>0)inner--;
        else{colon=i;break;}
      }else if(ch===","&&question<0){
        // Multiple argument expressions: split at a top-level comma.
        return offset<i?visit(from,i,depth+1):visit(i+1,to,depth+1);
      }
    }
    if(question>=0&&colon>=0){
      if(offset<question)return visit(from,question,depth+1);
      const condition=statement.slice(from,question).trim();
      const value=evaluate(condition);
      const known=value.kind==="text"&&value.values.length===1&&value.scalarType==="boolean"
        ?value.values[0]:undefined;
      if(offset>question&&offset<colon){
        if(known==="false")return false;
        return visit(question+1,colon,depth+1);
      }
      if(offset>colon){
        if(known==="true")return false;
        return visit(colon+1,to,depth+1);
      }
      return true;
    }
    // A nested ternary can be enclosed in grouping or call parentheses.
    // Square brackets (static SOQL/indexing) and braces are kept opaque.
    for(let i=from;i<to;i++){
      const ch=masked[i];
      if(!"([{".includes(ch))continue;
      const close=matchingPair(masked,i,ch,ch==="("?")":ch==="["?"]":"}");
      if(close<0||close>=to)return true;
      if(offset>i&&offset<close)
        return ch==="("?visit(i+1,close,depth+1):true;
      i=close;
    }
    return true;
  };
  return visit(start,end,0);
}
