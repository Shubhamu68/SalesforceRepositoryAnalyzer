import {maskApexSource,matchingPair,splitApexTopLevel,stripApexComments} from "./ApexSourceModel.js";
import {splitScalarOperator} from "./ApexScalarOperators.js";
import {evaluateApexExpression,type ApexValue} from "./ApexValueEvaluator.js";
import {canonicalApexType} from "./ApexTypeSystem.js";

export interface ApexGuardContext {
  typeOf:(identifier:string)=>string|undefined;
  valueOf:(identifier:string)=>ApexValue;
  stringPlatformAllowed:boolean;
}
/** Syntax and declared-type admission for side-effect-free scalar guards.
 * All comparison, Boolean and collection observations are delegated to
 * ApexValueEvaluator. Undefined denotes unsupported syntax, distinct from
 * an admitted guard whose runtime inputs are unknown. */
export function evaluateReadOnlyApexGuard(source:string,ctx:ApexGuardContext):ApexValue|undefined{
  const expression=stripApexComments(source).trim();
  if(expression.length>2000)return undefined;
  const names=new Set<string>();
  const scalar=/^(?:string|boolean|integer|long|decimal|double|id|date|datetime)$/;
  const collection=/^(?:list|set)<string>$/;
  const atom=(input:string,depth=0):boolean=>{
    if(depth>16)return false;
    const s=input.trim();
    if(/^(?:true|false|null|-?\d+(?:\.\d+)?|'(?:\\.|[^'\\])*')$/is.test(s))return true;
    if(/^[A-Za-z_]\w*$/.test(s)){
      const type=canonicalApexType(ctx.typeOf(s));
      if(!type||!scalar.test(type)&&!collection.test(type))return false;
      names.add(s);return true;
    }
    const staticRead=/^String\s*\.\s*(?:isBlank|isNotBlank|isEmpty)\s*\(\s*([\s\S]*)\)$/i.exec(s);
    if(staticRead&&ctx.stringPlatformAllowed)return atom(staticRead[1],depth+1)&&/^[A-Za-z_]\w*$|^'|^null$/i.test(staticRead[1].trim());
    const read=/^([A-Za-z_]\w*)\s*\.\s*(isEmpty|size|contains|equalsIgnoreCase)\s*\(\s*([\s\S]*?)\s*\)$/i.exec(s);
    if(read){
      const type=canonicalApexType(ctx.typeOf(read[1]))??"",op=read[2].toLowerCase();
      const valid=op==="size"?collection.test(type):op==="equalsignorecase"?type==="string":type==="string"||collection.test(type);
      if(!valid)return false;
      names.add(read[1]);
      return op==="isempty"||op==="size"?!read[3].trim():/^[A-Za-z_]\w*$|^'|^null$/i.test(read[3].trim())&&atom(read[3],depth+1);
    }
    return false;
  };
  const valid=(input:string,depth=0):boolean=>{
    if(depth>16)return false;
    const s=input.trim();
    if(s.startsWith("(")&&matchingPair(maskApexSource(s),0)===s.length-1)return valid(s.slice(1,-1),depth+1);
    for(const op of ["||","&&"]){
      const pieces=splitApexTopLevel(s,op);
      if(pieces.length>1)return pieces.every(p=>valid(p,depth+1));
    }
    const comparison=splitScalarOperator(s,["==","!=","<",">","<=",">="]);
    if(comparison)return atom(comparison.left)&&atom(comparison.right);
    if(s.startsWith("!")&&!s.startsWith("!="))return valid(s.slice(1),depth+1);
    return atom(s);
  };
  if(!valid(expression))return undefined;
  return evaluateApexExpression(expression,{values:new Map([...names].map(n=>[n,ctx.valueOf(n)])),strictBooleanGuards:true});
}
