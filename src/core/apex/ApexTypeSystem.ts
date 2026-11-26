/** Source-level types, separate from abstract runtime values.
 * No inference from the contents of a String, a collection, or a runtime
 * object's concrete class is sufficient to select an Apex overload. */
export type ApexArgumentTypes=readonly (string|undefined)[];
export interface ApexTypedSignature {parameters:readonly string[];parameterTypes?:readonly string[]}
export type ApexCallResolver=(name:string,args:import("./ApexValueEvaluator.js").ApexValue[],argumentTypes?:ApexArgumentTypes,fromFilePath?:string)=>import("./ApexValueEvaluator.js").ApexValue|undefined;

export function canonicalApexType(raw:string|undefined):string|undefined{
  if(!raw)return undefined;
  const text=raw.replace(/\s+/g,"").toLowerCase();
  let at=0;
  function type(depth:number):string|undefined{
    if(depth>12)return undefined;
    const name=/^[a-z_]\w*(?:\.[a-z_]\w*)*/.exec(text.slice(at))?.[0];
    if(!name)return undefined;
    at+=name.length;
    let result=name;
    if(text[at]==="<"){
      at++;const parts:string[]=[];
      for(;;){
        const part=type(depth+1);if(!part)return undefined;parts.push(part);
        if(text[at]!==",")break;at++;
      }
      if(text[at++]!==">")return undefined;
      if((name==="list"||name==="set")&&parts.length!==1||name==="map"&&parts.length!==2)return undefined;
      result=name+"<"+parts.join(",")+">";
    }
    while(text.slice(at,at+2)==="[]"){result="list<"+result+">";at+=2;}
    return result;
  }
  const parsed=type(0);return at===text.length?parsed:undefined;
}

/** Select only a unique exact source-signature match among equal-arity
 * candidates. Apex implicit conversions and subtype ranking are deliberately
 * not guessed. Untyped null and unknown declared types cannot select an overload.
 * Retain legacy unambiguous arity behavior for the single-candidate subset. */
export function selectApexOverload<T extends ApexTypedSignature>(candidates:readonly T[],arity:number,types?:ApexArgumentTypes):T|undefined{
  const same=candidates.filter(c=>c.parameters.length===arity);
  if(same.length===1)return same[0];
  if(!same.length||types?.length!==arity)return undefined;
  const normalized=types.map(canonicalApexType);
  if(normalized.some(t=>!t||t==="null"))return undefined;
  // Missing candidate signatures are not evidence of incompatibility.
  if(same.some(c=>c.parameterTypes?.length!==arity||c.parameterTypes.some(t=>!canonicalApexType(t))))return undefined;
  const exact=same.filter(c=>c.parameterTypes!.every((t,i)=>canonicalApexType(t)===normalized[i]));
  return exact.length===1?exact[0]:undefined;
}
export function apexSignatureKey(signature:ApexTypedSignature):string{
  return signature.parameters.length+"|"+(signature.parameterTypes??[]).map(t=>canonicalApexType(t)??"?").join(",");
}
/** Parse a parameter/local type without treating return/throw as declarations. */
export function parseApexDeclaration(text:string):{name:string;type:string}|undefined{
  const match=/^\s*(?:final\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>\[\]]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_]\w*)\s*(?:$|=(?!=|>)|;|:)/i.exec(text);
  if(!match||/^(?:return|throw|insert|update|upsert|delete|undelete|merge|break|continue|else|new)$/i.test(match[1]))return undefined;
  const type=canonicalApexType(match[1]);return type?{name:match[2],type}:undefined;
}
