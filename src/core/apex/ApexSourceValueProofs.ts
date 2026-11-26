import {maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod} from "./ApexSourceModel.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {evaluateApexExpression,runtimeParameter,type ApexValue} from "./ApexValueEvaluator.js";
const clean=(s:string)=>stripApexComments(s).trim();
const literal=(s:string)=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))?evaluateApexExpression(clean(s),{values:new Map()}):undefined;
/** A typed field of a uniquely declared local wrapper. No guessed field type
 * based on a name like 'shipDate'; no inherited or external member lookup. */
export function resolveApexWrapperMemberType(source:string,type:string,field:string):string|undefined{
  if(!/^[a-z_]\w*$/i.test(type))return undefined;
  const masked=maskApexSource(source);
  const hits=[...masked.matchAll(new RegExp("\\bclass\\s+"+type+"\\s*\\{","gi"))];
  if(hits.length!==1)return undefined;
  const open=hits[0].index!+hits[0][0].length-1,end=matchingPair(masked,open,"{","}");
  if(end<0)return undefined;
  const inside=masked.slice(open+1,end);
  const match=[...inside.matchAll(new RegExp("\\b(DateTime|Date|Integer|Long|Decimal|Double|Boolean|Id|String)\\s+"+field+"\\s*;","gi"))];
  const direct=match.filter(m=>{
    let depth=0;
    for(const c of inside.slice(0,m.index)){if(c==="{")depth++;else if(c==="}")depth--;}
    return depth===0;
  });
  return direct.length===1?direct[0][1].toLowerCase():undefined;
}

/** Only the fixed ISO GMT formatter of a source-typed Date is abstracted.
 * The returned symbol records a typed formatting constraint, not a value. */
export function proveFixedIsoDateTimeValue(source:string,owner:IndexedApexMethod,expression:string,methods:readonly IndexedApexMethod[]):ApexValue|undefined{
  const call=/^([A-Za-z_]\w*)\s*\(\s*\)$/.exec(clean(expression));
  if(!call)return undefined;
  const symbols=apexSymbols(source,methods);
  const matches=methods.filter(m=>m.name.toLowerCase()===call[1].toLowerCase()&&!m.parameters.length&&symbols.sameOwner(owner,m));
  if(matches.length!==1)return undefined;
  const helper=matches[0];
  if(helper.visibility!=="private"||helper.returnType?.toLowerCase()!=="string"||helper===owner||(!helper.isStatic&&owner.isStatic)||
    helper.body.length!==2||helper.body.some(n=>n.kind!=="statement"))return undefined;
  if(/\bclass\s+(?:DateTime|Time)\b/i.test(maskApexSource(source))||["DateTime","Time"].some(n=>symbols.lookup(helper,n,helper.start)))return undefined;
  const init=/^DateTime\s+([A-Za-z_]\w*)\s*=\s*DateTime\s*\.\s*newInstance\s*\(\s*([A-Za-z_]\w*)\s*,\s*Time\s*\.\s*newInstance\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)\s*\)\s*;$/i.exec(clean(helper.body[0].text??""));
  if(!init||symbols.lookup(helper,init[2],helper.body[0].start)?.toLowerCase()!=="date")return undefined;
  const ret=new RegExp("^return\\s+"+init[1]+"\\s*\\.\\s*formatGMT\\s*\\(\\s*('(?:\\\\.|[^'\\\\])*')\\s*\\)\\s*;$","i").exec(clean(helper.body[1].text??""));
  const format=ret?literal(ret[1]):undefined;
  if(format?.kind!=="text"||format.values.length!==1||format.values[0]!=="yyyy-MM-dd'T'HH:mm:ss'Z'")return undefined;
  return runtimeParameter(call[1],"datetime","Fixed ISO GMT date formatter; runtime value unknown.");
}

