import {stripApexComments,type IndexedApexMethod} from "./ApexSourceModel.js";
import {canonicalApexType} from "./ApexTypeSystem.js";
import {evaluateApexExpression,listValue,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import type {ApexCallResolver} from "./ApexTypeSystem.js";

type Identity={object:ApexValue;fieldSet:ApexValue};
type Piece=string|Identity;
type Local={kind:"scalar";value:ApexValue}|{kind:"type"|"describe";object:ApexValue}|
  {kind:"fieldSet"|"members";identity:Identity}|{kind:"list";pieces:Piece[]};

/** Source proof for a fresh String list built from platform Field Set members.
 * The proof is deliberately narrower than general method-return evaluation:
 * all locals are typed, no receiver escapes, no static writes, no arbitrary
 * callbacks, no guessed utility names. Fetch metadata only after proving the
 * entire body. Undefined means unproven effects, unknown means proven shape
 * with unavailable data. The caller must distinguish these cases.
 */
export function evaluateConstructorFieldList(method:IndexedApexMethod,args:readonly ApexValue[],
  resolve?:ApexCallResolver):ApexValue|undefined{
  if(!method.isStatic||!["public","global"].includes(method.visibility)||
    canonicalApexType(method.returnType)!=="list<string>"||
    method.parameters.length!==args.length||method.parameterTypes?.length!==args.length||
    method.parameterTypes.some(t=>canonicalApexType(t)!=="string")||
    args.some(v=>v.kind!=="text"&&v.kind!=="unknown"&&v.kind!=="null")||
    method.body.length>24)return undefined;
  const locals=new Map<string,Local>();
  const reserved=new Set(["schema","string","list","system","this","super"]);
  const declare=(name:string,value:Local):boolean=>{
    const key=name.toLowerCase();
    if(reserved.has(key)||locals.has(key))return false;
    locals.set(key,value);return true;
  };
  for(let i=0;i<args.length;i++)if(!declare(method.parameters[i],{kind:"scalar",value:args[i]}))return undefined;
  const scalar=(expr:string):ApexValue|undefined=>{
    const s=expr.trim();
    const existing=locals.get(s.toLowerCase());
    if(existing?.kind==="scalar")return existing.value;
    if(/^'(?:\\.|[^'\\])*'$/.test(s))return evaluateApexExpression(s,{values:new Map()});
    return undefined;
  };
  const read=(expression:string,depth=0):Local|undefined=>{
    if(depth>8)return undefined;
    const expr=stripApexComments(expression).trim();
    const existing=locals.get(expr.toLowerCase());
    if(existing)return existing;
    const getFields=/^([\s\S]+)\.\s*getFields\s*\(\s*\)$/i.exec(expr);
    if(getFields){
      const receiver=read(getFields[1],depth+1);
      return receiver?.kind==="fieldSet"?{kind:"members",identity:receiver.identity}:undefined;
    }
    const fieldSet=/^([\s\S]+)\.\s*fieldSets\s*\.\s*getMap\s*\(\s*\)\s*\.\s*get\s*\(([\s\S]*)\)$/i.exec(expr);
    if(fieldSet){
      const receiver=read(fieldSet[1],depth+1),name=scalar(fieldSet[2]);
      if(receiver&&(receiver.kind==="type"||receiver.kind==="describe")&&name)
        return {kind:"fieldSet",identity:{object:receiver.object,fieldSet:name}};
      return undefined;
    }
    const describe=/^([\s\S]+)\.\s*getDescribe\s*\(\s*\)$/i.exec(expr);
    if(describe){
      const receiver=read(describe[1],depth+1);
      return receiver?.kind==="type"?{kind:"describe",object:receiver.object}:undefined;
    }
    const global=/^Schema\s*\.\s*getGlobalDescribe\s*\(\s*\)\s*\.\s*get\s*\(([\s\S]*)\)$/i.exec(expr);
    if(global){
      const object=scalar(global[1]);return object?{kind:"type",object}:undefined;
    }
    const literal=/^Schema\s*\.\s*SObjectType\s*\.\s*([A-Za-z_]\w*)$/i.exec(expr);
    if(literal)return {kind:"type",object:textValue(literal[1])};
    const value=scalar(expr);
    return value?{kind:"scalar",value}:undefined;
  };
  const kinds:Record<string,Local["kind"]>={
    "string":"scalar","schema.sobjecttype":"type","schema.describesobjectresult":"describe",
    "schema.fieldset":"fieldSet","list<schema.fieldsetmember>":"members","list<string>":"list"
  };
  let output:Piece[]|undefined;
  for(const [i,node] of method.body.entries()){
    if(node.kind==="for"){
      const loop=/^(?:final\s+)?Schema\.FieldSetMember\s+([A-Za-z_]\w*)\s*:/i.exec(node.text??"");
      if(!loop||!node.loopVariable||loop[1].toLowerCase()!==node.loopVariable.toLowerCase()||
        locals.has(loop[1].toLowerCase())||reserved.has(loop[1].toLowerCase())||
        node.body?.length!==1||node.body[0].kind!=="statement")return undefined;
      const members=read(node.iterable??"");
      const add=/^([A-Za-z_]\w*)\s*\.\s*add\s*\(\s*([A-Za-z_]\w*)\s*\.\s*getFieldPath\s*\(\s*\)\s*\)\s*;?$/i.exec(stripApexComments(node.body[0].text??"").trim());
      if(members?.kind!=="members"||!add||add[2].toLowerCase()!==loop[1].toLowerCase())return undefined;
      const list=locals.get(add[1].toLowerCase());
      if(list?.kind!=="list"||list.pieces.length>=40)return undefined;
      list.pieces.push(members.identity);continue;
    }
    if(node.kind!=="statement")return undefined;
    const statement=stripApexComments(node.text??"").trim().replace(/;\s*$/,"");
    const ret=/^return\s+([A-Za-z_]\w*)$/i.exec(statement);
    if(ret){
      const list=locals.get(ret[1].toLowerCase());
      if(i!==method.body.length-1||list?.kind!=="list")return undefined;
      output=list.pieces;continue;
    }
    const declaration=/^(?:final\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w.\s<>]+>)?)\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/i.exec(statement);
    if(declaration){
      const type=canonicalApexType(declaration[1]),kind=type?kinds[type]:undefined;
      if(!kind)return undefined;
      // A list must be a fresh allocation, not an alias to a parameter/member.
      const value=kind==="list"?
        (/^new\s+List\s*<\s*String\s*>\s*\(\s*\)$/i.test(declaration[3].trim())?{kind:"list" as const,pieces:[]}:undefined)
        :read(declaration[3]);
      if(!value||value.kind!==kind||!declare(declaration[2],value))return undefined;
      continue;
    }
    const append=/^([A-Za-z_]\w*)\s*\.\s*add\s*\(([\s\S]+)\)$/i.exec(statement);
    if(append){
      const list=locals.get(append[1].toLowerCase()),value=scalar(append[2]);
      if(list?.kind!=="list"||list.pieces.length>=40||value?.kind!=="text"||value.values.length!==1)return undefined;
      list.pieces.push(value.values[0]);continue;
    }
    return undefined;
  }
  if(!output)return undefined;
  // A complete source proof may still lack a complete metadata snapshot.
  const items:string[]=[];
  for(const piece of output){
    if(typeof piece==="string"){items.push(piece);continue;}
    const {object,fieldSet}=piece;
    if(object.kind!=="text"||object.values.length!==1||fieldSet.kind!=="text"||fieldSet.values.length!==1)
      return unknown("Constructor Field Set object or developer name is not proven.");
    const values=resolve?.("Schema.fieldSetFields",[object,fieldSet]);
    if(values?.kind!=="collection")return values?.kind==="unknown"?values:unknown("Complete constructor Field Set metadata is unavailable.");
    if(items.length+values.items.length>2000)return unknown("Constructor Field Set inventory exceeds the bounded collection size.");
    items.push(...values.items);
  }
  return listValue(items);
}
