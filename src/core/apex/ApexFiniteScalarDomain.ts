import {maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {addApexValues,evaluateApexExpression,textValue,type ApexValue} from "./ApexValueEvaluator.js";
import {canonicalApexType} from "./ApexTypeSystem.js";

const clean=(s:string)=>stripApexComments(s).trim();
const lit=/^'(?:\\.|[^'\\])*'$/s;
const ident=/^[A-Za-z_]\w*$/;
const one=(v:ApexValue)=>v.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;
function literalConcat(expression:string,locals:ReadonlyMap<string,ApexValue>):ApexValue|undefined{
  const pieces=splitApexTopLevel(clean(expression),"+");
  if(!pieces.length||pieces.length>32)return undefined;
  let result=textValue("");
  for(const p of pieces){
    const term=clean(p);
    const value=lit.test(term)?evaluateApexExpression(term,{values:new Map()}):ident.test(term)?locals.get(term.toLowerCase()):undefined;
    if(!value||one(value)===undefined)return undefined;
    result=addApexValues(result,value);
  }
  const value=one(result);
  return value!==undefined&&value.length<=16000?result:undefined;
}
export interface ScalarSwitchArm {label:number|"else";value:ApexValue}
/** Finite read-only return domain, not general switch execution. Only
 * private String helpers with one Integer parameter, literal local String
 * declarations, and a terminal switch whose arms each return one
 * literal concatenation (or null). All text remains source-correlated. */
export function proveScalarSwitchReturnDomain(source:string,method:IndexedApexMethod):ScalarSwitchArm[]|undefined{
  if(method.visibility!=="private"||canonicalApexType(method.returnType)!=="string"||
    method.parameters.length!==1||canonicalApexType(method.parameterTypes?.[0])!=="integer"||
    method.body.length<1||method.body.length>9)return undefined;
  const tail=method.body.at(-1)!;
  if(tail.kind!=="opaque")return undefined;
  const locals=new Map<string,ApexValue>(),parameter=method.parameters[0].toLowerCase();
  for(const n of method.body.slice(0,-1)){
    const decl=n.kind==="statement"?/^String\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+);$/i.exec(clean(n.text??"")):null;
    if(!decl||decl[1].toLowerCase()===parameter||locals.has(decl[1].toLowerCase()))return undefined;
    const value=literalConcat(decl[2],locals);
    if(!value)return undefined;
    locals.set(decl[1].toLowerCase(),value);
  }
  const body=clean(source.slice(tail.start,tail.end)),masked=maskApexSource(body);
  const head=/^switch\s+on\s+([A-Za-z_]\w*)\s*\{/i.exec(masked);
  if(!head||head[1].toLowerCase()!==parameter||body.length>64000)return undefined;
  const open=head[0].lastIndexOf("{"),close=matchingPair(masked,open,"{","}");
  if(close<0||masked.slice(close+1).trim())return undefined;
  const arms:ScalarSwitchArm[]=[],labels=new Set<number|"else">();
  let cursor=open+1;
  while(cursor<close){
    while(cursor<close&&/\s/.test(masked[cursor]))cursor++;
    if(cursor===close)break;
    const arm=/^when\s+(else|-?\d+)\s*\{/i.exec(masked.slice(cursor,close));
    if(!arm||labels.has("else")||arms.length>=32)return undefined;
    const label=arm[1].toLowerCase()==="else"?"else":Number(arm[1]);
    if(labels.has(label)||typeof label==="number"&&(!Number.isInteger(label)||label< -2147483648||label>2147483647))return undefined;
    const start=cursor+arm[0].lastIndexOf("{"),end=matchingPair(masked,start,"{","}");
    if(end<0||end>=close)return undefined;
    const ret=/^return\s+([\s\S]+);$/i.exec(clean(body.slice(start+1,end)));
    if(!ret)return undefined;
    const value=/^null$/i.test(clean(ret[1]))?{kind:"null" as const}:literalConcat(ret[1],locals);
    if(!value)return undefined;
    labels.add(label);arms.push({label,value});cursor=end+1;
  }
  return labels.has("else")&&arms.length>1?arms:undefined;
}
/** Independent finite String assignments from a pure equality dispatch.
 * An omitted else preserves the incoming value. Reject effects, nested
 * arbitrary branches, target-dependent guards and nonliteral writes. */
export function proveConditionalStringAssignmentDomain(node:SourceNode,target:string,method:IndexedApexMethod,incoming:ApexValue):ApexValue[]|undefined{
  if(node.kind!=="if"||!ident.test(target)||one(incoming)===undefined)return undefined;
  const values:ApexValue[]=[];
  let branch:SourceNode|undefined=node,selector:string|undefined;
  const assignment=new RegExp("^"+target+"\\s*=(?!=|>)\\s*([\\s\\S]+);$","i");
  const readAssignment=(body:readonly SourceNode[]):ApexValue|undefined=>{
    const m=body.length===1&&body[0].kind==="statement"?assignment.exec(clean(body[0].text??"")):null;
    return m?literalConcat(m[1],new Map()):undefined;
  };
  while(branch){
    if(values.length>=16)return undefined;
    const condition=clean(branch.condition??"");
    const match=/^([A-Za-z_]\w*)\s*==\s*('(?:\\.|[^'\\])*'|[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*)$/i.exec(condition);
    if(!match)return undefined;
    const name=match[1].toLowerCase(),parameter=method.parameters.findIndex(p=>p.toLowerCase()===name);
    if(name===target.toLowerCase()||parameter<0||canonicalApexType(method.parameterTypes?.[parameter])!=="string"||
      selector!==undefined&&selector!==name)return undefined;
    selector=name;
    const v=readAssignment(branch.body??[]);
    if(!v)return undefined;
    values.push(v);
    const other:SourceNode[]=branch.otherwise??[];
    if(!other.length){values.push(incoming);break;}
    if(other.length===1&&other[0].kind==="if"){branch=other[0];continue;}
    const last=readAssignment(other);
    if(!last)return undefined;
    values.push(last);break;
  }
  return [...new Map(values.map(v=>[JSON.stringify(v),v])).values()];
}
