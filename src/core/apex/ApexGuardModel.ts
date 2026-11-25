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


/** A finite membership guard supplies candidate values only when the
 * caller proves the collection's complete, exact contents. The negative
 * branch never gets an invented String. Optional conjuncts must be safe
 * null/blank tests of the same immutable selector. */
export function readApexFiniteMembershipGuard(source:string,stringPlatformAllowed:boolean):
  {receiver:string;parameter:string;negated:boolean}|undefined{
  const parts=splitApexTopLevel(stripApexComments(source).trim(),"&&");
  const unwrap=(s:string):string=>{
    s=s.trim();
    while(s.startsWith("(")&&matchingPair(maskApexSource(s),0)===s.length-1)s=s.slice(1,-1).trim();
    return s;
  };
  const normalized=parts.map(unwrap);
  const members=normalized.map(s=>/^(!\s*)?([A-Za-z_]\w*)\s*\.\s*contains\s*\(\s*([A-Za-z_]\w*)\s*\)$/i.exec(s));
  const found=members.flatMap((v,i)=>v?[{v,i}]:[]);
  if(found.length!==1)return undefined;
  const {v,i}=found[0],parameter=v[3],negated=!!v[1];
  if(parts.length>1&&negated)return undefined;
  const nullCheck=new RegExp("^(?:"+parameter+"\\s*!=\\s*null|null\\s*!=\\s*"+parameter+")$","i");
  const blankCheck=new RegExp("^String\\s*\\.\\s*isNotBlank\\s*\\(\\s*"+parameter+"\\s*\\)$","i");
  if(normalized.some((s,j)=>j!==i&&!nullCheck.test(s)&&!(stringPlatformAllowed&&blankCheck.test(s))))return undefined;
  return {receiver:v[2],parameter,negated};
}

/** Partition a single immutable String predicate into true/false paths,
 * without assuming a concrete runtime String or case. Opposite comparisons
 * share the same predicate identity. Distinct predicates are not independent
 * unless a consumer can prove their relation. */
export function readApexStringPredicate(source:string,stringPlatformAllowed:boolean):
  {parameter:string;predicate:string;negated:boolean}|undefined{
  let s=stripApexComments(source).trim();
  while(s.startsWith("(")&&matchingPair(maskApexSource(s),0)===s.length-1)s=s.slice(1,-1).trim();
  const blank=/^String\s*\.\s*(isBlank|isNotBlank)\s*\(\s*([A-Za-z_]\w*)\s*\)$/i.exec(s);
  if(blank&&stringPlatformAllowed)return {parameter:blank[2],predicate:"blank",negated:blank[1].toLowerCase()==="isnotblank"};
  const comparison=splitScalarOperator(s,["==","!="]);
  if(!comparison)return undefined;
  const id=/^[A-Za-z_]\w*$/;
  const literal=/^'(?:\\.|[^'\\])*'$/s;
  const left=id.test(comparison.left)&&literal.test(comparison.right);
  const right=id.test(comparison.right)&&literal.test(comparison.left);
  if(!left&&!right)return undefined;
  const value=evaluateApexExpression(left?comparison.right:comparison.left,{values:new Map()});
  if(value.kind!=="text"||value.values.length!==1||!/^[\x20-\x7e]*$/.test(value.values[0]))return undefined;
  return {parameter:left?comparison.left:comparison.right,predicate:"ascii-eq:"+value.values[0].toLowerCase(),negated:comparison.operator==="!="};
}
