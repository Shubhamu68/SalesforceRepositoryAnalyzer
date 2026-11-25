import {maskApexSource,matchingPair} from "./ApexSourceModel.js";
import type {ApexValue} from "./ApexValueEvaluator.js";

const unknown=(reason:string):ApexValue=>({kind:"unknown",reason});
const bool=(value:boolean):ApexValue=>({kind:"text",values:[String(value)],scalarType:"boolean"});
export function knownBoolean(value:ApexValue):boolean|undefined{
  return value.kind==="text"&&value.scalarType==="boolean"&&value.values.length===1
    ?value.values[0]==="true"?true:value.values[0]==="false"?false:undefined:undefined;
}

/** Locate the rightmost operator at one precedence level, outside strings,
 * nested expressions, SOQL literals and recognized generic type arguments.
 * Rightmost split preserves the left associativity of arithmetic. */
export function splitScalarOperator(source:string,operators:readonly string[]):
  {left:string;operator:string;right:string}|undefined{
  const masked=maskApexSource(source);
  let depth=0,match:{left:string;operator:string;right:string}|undefined;
  for(let i=0;i<masked.length;i++){
    const ch=masked[i];
    if("([{".includes(ch)){depth++;continue;}
    if(")]}".includes(ch)){depth--;continue;}
    if(depth!==0)continue;
    if(ch==="<"&&/\b(?:List|Set|Map)\s*$/i.test(masked.slice(0,i))){
      const close=matchingPair(masked,i,"<",">");
      if(close>=0&&/^[\w\s,.<>]+$/.test(masked.slice(i+1,close))){i=close;continue;}
    }
    // Don't misread safe navigation, shifts, increment/decrement, assignment
    // or map arrows as binary scalar operators.
    const token=["===","!==","<<",">>","++","--","+=","-=","*=","/=","=>","==","!=","<=",">=","+","-","*","/","<",">"].find(op=>masked.startsWith(op,i));
    if(!token)continue;
    const start=i;i+=token.length-1;
    if(!operators.includes(token))continue;
    const left=source.slice(0,start).trim(),right=source.slice(i+1).trim();
    if(!left||!right)continue;
    // Unary sign after another operator, or at the start of an expression.
    // Inspect the ORIGINAL prefix because masked string literals are spaces.
    if((token==="+"||token==="-")&&/[+\-*/<>=!&|?:,(]$/.test(left))continue;
    match={left,operator:token,right};
  }
  return match;
}

export function compareScalars(left:ApexValue,right:ApexValue,operator:string):ApexValue{
  if(left.kind==="unknown"||right.kind==="unknown")
    return unknown("Runtime conditional comparison is unproven: "+
      (left.kind==="unknown"?left.reason:right.kind==="unknown"?right.reason:"unknown operand"));
  if(operator==="=="||operator==="!="){
    let equal:boolean|undefined;
    if(left.kind==="null"||right.kind==="null")equal=left.kind===right.kind;
    else if(left.kind==="number"&&right.kind==="number")equal=left.value===right.value;
    else if(left.kind==="text"&&right.kind==="text"&&left.values.length===1&&right.values.length===1){
      if(left.scalarType!==right.scalarType)return unknown("Comparison operand types are not proven compatible.");
      const a=left.values[0],b=right.values[0];
      if(left.scalarType==="boolean")equal=a===b;
      else if(a===b)equal=true;
      // Salesforce String == is locale-sensitive and case-insensitive.
      // ASCII API identifiers and plain ASCII strings are supported; leave
      // non-ASCII differences unknown until a locale is explicitly known.
      else if(/^[\x20-\x7e]*$/.test(a)&&/^[\x20-\x7e]*$/.test(b))equal=a.toLowerCase()===b.toLowerCase();
    }
    if(equal!==undefined)return bool(operator==="=="?equal:!equal);
    return unknown("Equality operand types or values are not proven.");
  }
  if((left.kind==="null"&&right.kind==="number")||(right.kind==="null"&&left.kind==="number"))return bool(false);
  if(left.kind!=="number"||right.kind!=="number")return unknown("Relational comparison requires proven numeric operands.");
  const a=left.value,b=right.value;
  if(!Number.isFinite(a)||!Number.isFinite(b))return unknown("Nonfinite numeric comparison.");
  return bool(operator===">"?a>b:operator===">="?a>=b:operator==="<"?a<b:a<=b);
}

/** Integer arithmetic only, within the signed Apex Integer range.
 * Without type/precision provenance, fractional division, decimal rounding
 * and overflow cannot be claimed as exact Apex results. */
export function integerArithmetic(left:ApexValue,right:ApexValue,operator:string):ApexValue{
  if(left.kind!=="number"||right.kind!=="number")return unknown("Arithmetic requires proven numeric operands.");
  const a=left.value,b=right.value;
  const safe=(n:number)=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647;
  if(!safe(a)||!safe(b)||(operator==="/"&&(b===0||a%b!==0)))
    return unknown("Arithmetic type, precision or division result is not proven.");
  const value=operator==="+"?a+b:operator==="-"?a-b:operator==="*"?a*b:a/b;
  return safe(value)?{kind:"number",value}:unknown("Arithmetic exceeds the supported exact Integer range.");
}
