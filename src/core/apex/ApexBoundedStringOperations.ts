import type {ApexValue} from "./ApexValueEvaluator.js";

const unknown=(reason:string):ApexValue=>({kind:"unknown",reason});
const text=(value:string):ApexValue=>({kind:"text",values:[value]});
const bool=(value:boolean):ApexValue=>({kind:"text",values:[String(value)],scalarType:"boolean"});
const integer=(v:ApexValue|undefined):number|undefined=>v?.kind==="number"&&Number.isInteger(v.value)&&v.value>=-2147483648&&v.value<=2147483647?v.value:undefined;
const one=(v:ApexValue|undefined):string|undefined=>v?.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;
const allowed=new Set(["length","substring","substringbefore","substringafter","endswith","startswith","replace","size"]);
export function isBoundedStringOperation(name:string):boolean{return allowed.has(name.toLowerCase());}

/** Exact values only. No regex replacement or unknown substring inference,
 * no selecting one of several possible values, no fabricated runtime data. */
export function evaluateBoundedStringOperation(receiver:ApexValue,operation:string,args:readonly ApexValue[]):ApexValue{
  const op=operation.toLowerCase();
  if(receiver.kind==="unknown")return {...receiver,reason:"Receiver for "+op+" is not proven: "+receiver.reason,fragments:undefined,symbol:undefined};
  if(op==="size"&&!args.length){
    if(receiver.kind==="collection"||receiver.kind==="instanceList"||receiver.kind==="records")return {kind:"number",value:receiver.items.length};
    if(receiver.kind==="map")return {kind:"number",value:receiver.entries.length};
  }
  const value=one(receiver);
  if(value===undefined)return unknown("String "+op+" requires one proven string.");
  const first=one(args[0]);
  const result=(v:string):ApexValue=>v.length<=100000?text(v):unknown("String result exceeds the supported bound.");
  if(op==="length"&&!args.length)return {kind:"number",value:value.length};
  if(op==="substring"&&(args.length===1||args.length===2)){
    const start=integer(args[0]),end=args.length===2?integer(args[1]):value.length;
    if(start===undefined||end===undefined||start<0||end<start||end>value.length)
      return unknown("String substring bounds are not proven valid.");
    return result(value.slice(start,end));
  }
  if(args.length===1&&first!==undefined){
    if(op==="endswith")return bool(value.endsWith(first));
    if(op==="startswith")return bool(value.startsWith(first));
    const at=value.indexOf(first);
    if(first.length&&at>=0){
      if(op==="substringbefore")return result(value.slice(0,at));
      if(op==="substringafter")return result(value.slice(at+first.length));
    }
  }
  if(op==="replace"&&args.length===2&&first!==undefined&&first.length){
    const second=one(args[1]);
    if(second!==undefined){
      const parts=value.split(first);
      const length=parts.reduce((n,p)=>n+p.length,0)+(parts.length-1)*second.length;
      if(length<=100000)return text(parts.join(second));
    }
  }
  return unknown("String "+op+" arguments or operation are not proven.");
}
