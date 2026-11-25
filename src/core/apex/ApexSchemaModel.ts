import type {ApexObjectSchema,ApexSchemaField,MetadataResult} from "../metadata/ApexMetadataProvider.js";
import type {ApexValue} from "./ApexValueEvaluator.js";
import {canonicalApexType,type ApexCallResolver} from "./ApexTypeSystem.js";
import {stripApexComments,type SourceNode} from "./ApexSourceModel.js";
import {readApexMemberOperation} from "./ApexReadOperations.js";
import {compareScalars,knownBoolean,splitScalarOperator} from "./ApexScalarOperators.js";

/** Typed, immutable metadata facts. Do not encode a Schema token or enum as
 * an ordinary String; doing so invents Apex conversion/equality semantics. */
export type ApexSchemaValue =
  | {kind:"schema";schemaType:"objectToken"|"objectDescribe";objectApiName:string}
  | {kind:"schema";schemaType:"fieldToken"|"fieldDescribe";objectApiName:string;field:ApexSchemaField}
  | {kind:"schema";schemaType:"displayType";value:string};
const name=/^[A-Za-z_]\w*$/;
const displayTypes=new Set("ADDRESS ANYTYPE BASE64 BOOLEAN COMBOBOX COMPLEXVALUE CURRENCY DATACATEGORYGROUPREFERENCE DATE DATETIME DOUBLE EMAIL ENCRYPTEDSTRING FLOATARRAY ID INTEGER JSON LOCATION LONG MULTIPICKLIST PERCENT PHONE PICKLIST REFERENCE SOBJECT STRING TEXTAREA TEXTARRAY TIME URL".split(" "));
const displayType=(s:string)=>{const value=s.toUpperCase()==="INT"?"INTEGER":s.toUpperCase();return displayTypes.has(value)?value:undefined;};
const unknown=(reason:string):ApexValue=>({kind:"unknown",reason});
const text=(value:string):ApexValue=>({kind:"text",values:[value]});
const one=(v:ApexValue)=>v.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;
const bool=(v:boolean):ApexValue=>({kind:"text",values:[String(v)],scalarType:"boolean"});

/** Validate even non-live providers. Missing per-field attributes are not
 * defaulted. Complete field names do not imply complete field properties. */
export function resolveSchemaSnapshot(result:MetadataResult<ApexObjectSchema>|undefined,object:string,field?:string):ApexValue{
  const snapshot=result?.value;
  if(!result?.complete||!snapshot||typeof snapshot.name!=="string"||
    snapshot.name.toLowerCase()!==object.toLowerCase()||!Array.isArray(snapshot.fields)||
    snapshot.fields.some(f=>!f||typeof f.name!=="string"||!name.test(f.name))||
    new Set(snapshot.fields.map(f=>f.name.toLowerCase())).size!==snapshot.fields.length)
    return unknown("Complete Schema Describe unavailable for "+object+".");
  if(field===undefined)return {kind:"schema",schemaType:"objectToken",objectApiName:snapshot.name};
  const match=snapshot.fields.find(f=>f.name.toLowerCase()===field.toLowerCase());
  if(!match)return unknown("Schema field "+object+"."+field+" was not established.");
  // Copy only supported structural facts. No FLS or user-specific attributes.
  return schemaFieldToken(snapshot.name,match);
}

function schemaFieldToken(objectApiName:string,match:ApexSchemaField):ApexValue{
  const details:ApexSchemaField={name:match.name,
    ...(typeof match.type==="string"?{type:match.type}:{}),
    ...(typeof match.relationshipName==="string"||match.relationshipName===null?{relationshipName:match.relationshipName}:{}),
    ...(Array.isArray(match.referenceTo)&&match.referenceTo.every((v:unknown)=>typeof v==="string"&&name.test(v))?{referenceTo:[...match.referenceTo]}:{}),
    ...(typeof match.nameField==="boolean"?{nameField:match.nameField}:{})};
  return {kind:"schema",schemaType:"fieldToken",objectApiName,field:details};
}

/** A fresh map per getMap() evaluation; the shared metadata snapshot itself
 * remains immutable. Describe maps use case-insensitive field-name keys. */
export function resolveSchemaFieldMap(result:MetadataResult<ApexObjectSchema>|undefined,object:string):ApexValue{
  const token=resolveSchemaSnapshot(result,object);
  if(token.kind!=="schema"||token.schemaType!=="objectToken")return token;
  const fields=result!.value!.fields;
  if(fields.length>2000)return unknown("Schema field-map inventory exceeds the supported bound.");
  return {kind:"map",keyType:"schemaField",entries:fields.map(f=>[f.name.toLowerCase(),schemaFieldToken(token.objectApiName,f)])};
}
export type ApexSchemaFieldMap=Extract<ApexValue,{kind:"map"}>&{keyType:"schemaField"};
export function isSchemaFieldMap(value:ApexValue):value is ApexSchemaFieldMap{
  return value.kind==="map"&&value.keyType==="schemaField";
}
/** Only proven direct mutations; do not assume case-folding behavior for
 * writes to Salesforce's special Describe map or arbitrary putAll sources. */
export function mutateSchemaFieldMap(map:ApexSchemaFieldMap,operation:string,args:readonly ApexValue[]):ApexValue{
  const action=operation.toLowerCase();
  if(action==="clear"&&args.length===0)return {...map,entries:[]};
  const key=args.length?one(args[0]):undefined;
  if(key===undefined||key!==key.toLowerCase()||!name.test(key))
    return unknown("Schema field-map mutation key is not a proven normalized field name.");
  if(action==="remove"&&args.length===1)return {...map,entries:map.entries.filter(([k])=>k!==key)};
  const value=args[1];
  if(action==="put"&&args.length===2&&value?.kind==="schema"&&value.schemaType==="fieldToken"){
    const entries=map.entries.filter(([k])=>k!==key);
    if(entries.length>=2000)return unknown("Schema field-map mutation exceeds the supported bound.");
    return {...map,entries:[...entries,[key,value]]};
  }
  return unknown("Schema field-map mutation is unsupported or not proven.");
}

export function evaluateSchemaRead(receiver:ApexValue,operation:string,args:readonly ApexValue[]):ApexValue|undefined{
  if(receiver.kind!=="schema")return undefined;
  const op=operation.toLowerCase();
  if(args.length)return unknown("Unsupported Schema method arguments.");
  if(receiver.schemaType==="displayType"){
    if(op==="name")return text(receiver.value);
    return unknown("Unsupported Schema DisplayType operation.");
  }
  if(receiver.schemaType==="objectToken"||receiver.schemaType==="objectDescribe"){
    if(op==="getdescribe"&&receiver.schemaType==="objectToken")return {...receiver,schemaType:"objectDescribe"};
    if(op==="getname"&&receiver.schemaType==="objectDescribe")return text(receiver.objectApiName);
    if(op==="getsobjecttype"&&receiver.schemaType==="objectDescribe")return {...receiver,schemaType:"objectToken"};
    return unknown("Unsupported Schema object operation.");
  }
  if(receiver.schemaType==="fieldToken"&&op==="getdescribe")return {...receiver,schemaType:"fieldDescribe"};
  if(receiver.schemaType!=="fieldDescribe")return unknown("Field Describe result is required.");
  const f=receiver.field;
  if(op==="getname")return text(f.name);
  if(op==="getsobjectfield")return {...receiver,schemaType:"fieldToken"};
  if(op==="gettype"){
    const value=typeof f.type==="string"?displayType(f.type):undefined;
    return value?{kind:"schema",schemaType:"displayType",value}:unknown("Field type unavailable for "+receiver.objectApiName+"."+f.name+".");
  }
  if(op==="getrelationshipname")return f.relationshipName===null?{kind:"null"}:
    typeof f.relationshipName==="string"&&name.test(f.relationshipName)?text(f.relationshipName):unknown("Relationship name unavailable for "+f.name+".");
  if(op==="isnamefield")return typeof f.nameField==="boolean"?bool(f.nameField):unknown("Name-field metadata unavailable for "+f.name+".");
  if(op==="getreferenceto"){
    // REST target order is not evidence of Apex positional ordering. Only
    // singleton (or explicitly empty) references have established positions.
    if(!Array.isArray(f.referenceTo)||f.referenceTo.length>1)return unknown("Reference target is unavailable or polymorphic for "+f.name+".");
    return {kind:"instanceList",elementType:"Schema.SObjectType",items:f.referenceTo.map(objectApiName=>({kind:"schema",schemaType:"objectToken",objectApiName}))};
  }
  return unknown("Unsupported Schema field operation.");
}

/** Recognize schema-specific source types and explicit token/chain syntax. */
export function schemaReceiverEligible(expression:string,type?:string):boolean{
  return /^Schema\s*\.|\.SObjectType\b|\.getDescribe\s*\(|\.getReferenceTo\s*\(/i.test(expression)||
    /^schema\.(?:sobjecttype|sobjectfield|describesobjectresult|describefieldresult|displaytype)$/i.test(type??"")||
    /^list\s*<\s*schema\.sobjecttype\s*>$/i.test(type??"")||
    /^map\s*<\s*string\s*,\s*schema\.sobjectfield\s*>$/i.test(type??"");
}
const operations=new Set(["getdescribe","gettype","getname","getrelationshipname","getreferenceto","isnamefield","getsobjecttype","getsobjectfield","name"]);
export const isSchemaReadOperation=(operation:string)=>operations.has(operation.toLowerCase());
export interface SchemaExpressionContext {
  evaluate:(expression:string)=>ApexValue;
  resolveCall?:ApexCallResolver;
  shadowed?:(identifier:string)=>boolean;
  /** Backward traversal only probes a receiver that has a Schema source type
   * or explicit Schema syntax; do not intercept arbitrary helper calls. */
  receiverEligible?:(expression:string)=>boolean;
}
const globalDescribe=/^Schema\s*\.\s*getGlobalDescribe\s*\(\s*\)$/i;
const safeGlobalKey=/^(?:[A-Za-z_]\w*|'(?:\\.|[^'\\])*')$/s;
/** Pure direct global Describe membership. A failed/partial Describe is
 * unknown, never proof of absence. A provider may explicitly return null
 * only when it has authoritative absence evidence. */
function globalObjectRead(expr:string,ctx:SchemaExpressionContext,guardOnly=false):ApexValue|undefined{
  const call=readApexMemberOperation(expr,n=>/^(?:get|containsKey)$/i.test(n));
  if(!call||!globalDescribe.test(call.receiver))return undefined;
  if(ctx.shadowed?.("Schema")||call.args.length!==1||guardOnly&&!safeGlobalKey.test(call.args[0].trim()))
    return unknown("Schema global lookup receiver or argument is not proven.");
  const object=one(ctx.evaluate(call.args[0]));
  if(object===undefined||!name.test(object))return unknown("Schema object name is not known.");
  const result=ctx.resolveCall?.("Schema.objectSchema",[text(object)])??unknown("Schema metadata is unavailable.");
  if(result.kind==="unknown")return result;
  if(result.kind!=="null"&&!(result.kind==="schema"&&result.schemaType==="objectToken"))
    return unknown("Schema object identity is not proven.");
  return call.name.toLowerCase()==="containskey"?bool(result.kind!=="null"):result;
}
/** Recognize only direct, side-effect-free global Describe conditions.
 * Used by backward guard replay; forward comparisons use the same reads. */
export function evaluateSchemaGlobalGuard(condition:string,ctx:SchemaExpressionContext):ApexValue|undefined{
  const expr=condition.trim();
  const comparison=splitScalarOperator(expr,["==","!="]);
  if(comparison){
    const leftNull=/^null$/i.test(comparison.left),rightNull=/^null$/i.test(comparison.right);
    if(leftNull===rightNull)return undefined;
    const read=globalObjectRead(leftNull?comparison.right:comparison.left,ctx,true);
    if(read===undefined)return undefined;
    if(read.kind!=="null"&&read.kind!=="schema"&&read.kind!=="unknown")return undefined;
    return compareScalars(leftNull?{kind:"null"}:read,rightNull?{kind:"null"}:read,comparison.operator);
  }
  const negated=/^!\s*/.test(expr);
  const read=globalObjectRead(negated?expr.replace(/^!\s*/,""):expr,ctx,true);
  if(read===undefined)return undefined;
  if(read.kind==="unknown")return read;
  const truth=knownBoolean(read);
  return truth===undefined?undefined:bool(negated?!truth:truth);
}

/** Shared syntactic adapter. Only explicit compile-time tokens, direct
 * dynamic object lookup, inline field-map lookup, and typed Schema receiver
 * reads are supported. Never interpret application properties as metadata. */
export function evaluateSchemaExpression(expr:string,ctx:SchemaExpressionContext):ApexValue|undefined{
  const allowed=(root:string)=>!ctx.shadowed?.(root);
  // A typed local can lead to a field token through an inline Describe map,
  // or to an object token through an exact reference-list read. Preserve
  // normal helper dispatch: prove the base receiver before probing a chain.
  const eligible=(receiver:string):boolean=>{
    if(!ctx.receiverEligible||ctx.receiverEligible(receiver))return true;
    const indexed=/^([\s\S]+)\s*\[\s*\d+\s*\]$/.exec(receiver);
    if(indexed)return eligible(indexed[1].trim());
    const get=readApexMemberOperation(receiver,n=>/^get$/i.test(n));
    if(get&&get.args.length===1){
      const map=/^([\s\S]+)\.\s*fields\s*\.\s*getMap\s*\(\s*\)$/i.exec(get.receiver);
      return eligible(map?map[1].trim():get.receiver);
    }
    return false;
  };
  const referenceAt=(list:ApexValue,index:ApexValue):ApexValue|undefined=>{
    if(list.kind!=="instanceList"||list.elementType.toLowerCase()!=="schema.sobjecttype")return undefined;
    return list.items.length===1&&index.kind==="number"&&index.value===0&&
      list.items[0].kind==="schema"&&list.items[0].schemaType==="objectToken"
      ?list.items[0]:unknown("Schema reference target position is not proven.");
  };
  const lookup=(object:string,field?:string)=>ctx.resolveCall?.("Schema.objectSchema",[text(object),...(field===undefined?[]:[text(field)])])??unknown("Schema metadata is unavailable.");
  const enumToken=/^Schema\s*\.\s*DisplayType\s*\.\s*([A-Za-z_]\w*)$/i.exec(expr);
  if(enumToken){
    const value=displayType(enumToken[1]);
    return allowed("Schema")&&value?{kind:"schema",schemaType:"displayType",value}:unknown("Schema DisplayType is not proven.");
  }
  const explicitField=/^Schema\s*\.\s*SObjectType\s*\.\s*([A-Za-z_]\w*)\s*\.\s*fields\s*\.\s*([A-Za-z_]\w*)$/i.exec(expr);
  if(explicitField)return allowed("Schema")&&allowed(explicitField[1])?lookup(explicitField[1],explicitField[2]):unknown("Schema field token is shadowed.");
  const explicitObject=/^Schema\s*\.\s*SObjectType\s*\.\s*([A-Za-z_]\w*)$/i.exec(expr);
  if(explicitObject)return allowed("Schema")&&allowed(explicitObject[1])?lookup(explicitObject[1]):unknown("Schema object token is shadowed.");
  const objectToken=/^([A-Za-z_]\w*)\s*\.\s*SObjectType$/i.exec(expr);
  if(objectToken)return allowed(objectToken[1])?lookup(objectToken[1]):unknown("Schema object token is shadowed.");
  const direct=/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\.\s*getDescribe\s*\(\s*\)$/i.exec(expr);
  if(direct&&!/^SObjectType$/i.test(direct[2])){
    if(!allowed(direct[1]))return unknown("Schema field token is shadowed.");
    const token=lookup(direct[1],direct[2]);
    return evaluateSchemaRead(token,"getDescribe",[])??token;
  }
  const fieldMap=/^([\s\S]+)\.\s*fields\s*\.\s*getMap\s*\(\s*\)$/i.exec(expr);
  if(fieldMap&&eligible(fieldMap[1].trim())){
    const object=ctx.evaluate(fieldMap[1]);
    if(object.kind==="schema"&&(object.schemaType==="objectDescribe"||object.schemaType==="objectToken"))
      return ctx.resolveCall?.("Schema.fieldMap",[text(object.objectApiName)])??unknown("Typed Schema field map unavailable.");
    if(object.kind==="unknown")return object;
  }
  const globalRead=globalObjectRead(expr,ctx);
  if(globalRead!==undefined)return globalRead;
  const fieldLookup=readApexMemberOperation(expr,n=>/^get$/i.test(n));
  if(fieldLookup&&fieldLookup.args.length===1){
    const map=/^([\s\S]+)\.\s*fields\s*\.\s*getMap\s*\(\s*\)$/i.exec(fieldLookup.receiver);
    if(map){
      const object=ctx.evaluate(map[1]),field=one(ctx.evaluate(fieldLookup.args[0]));
      if(object.kind==="schema"&&(object.schemaType==="objectDescribe"||object.schemaType==="objectToken"))
        return field&&name.test(field)?lookup(object.objectApiName,field):unknown("Schema field name is not known.");
      if(object.kind==="unknown")return object;
    }
  }
  const targetIndex=/^([\s\S]+)\s*\[\s*(\d+)\s*\]$/.exec(expr);
  if(targetIndex&&eligible(targetIndex[1].trim())){
    const list=ctx.evaluate(targetIndex[1].trim());
    const result=referenceAt(list,{kind:"number",value:Number(targetIndex[2])});
    if(result!==undefined)return result;
    if(list.kind==="unknown"&&/\.getReferenceTo\s*\(\s*\)$/i.test(targetIndex[1].trim()))return list;
  }
  if(fieldLookup&&fieldLookup.args.length===1&&eligible(fieldLookup.receiver)){
    const result=referenceAt(ctx.evaluate(fieldLookup.receiver),ctx.evaluate(fieldLookup.args[0]));
    if(result!==undefined)return result;
  }
  const call=readApexMemberOperation(expr,isSchemaReadOperation);
  if(call&&eligible(call.receiver)){
    const receiver=ctx.evaluate(call.receiver);
    if(receiver.kind==="schema")return evaluateSchemaRead(receiver,call.name,call.args.map(ctx.evaluate));
    if(receiver.kind==="unknown"&&ctx.receiverEligible)return receiver;
  }
  return undefined;
}

/** Structural Schema argument compatibility shared by effect consumers.
 * No inferred application type, unknown token or legacy field-name inventory. */
export function schemaEffectArgument(value:ApexValue,type:string|undefined):boolean{
  const t=canonicalApexType(type);
  if(isSchemaFieldMap(value))return t==="map<string,schema.sobjectfield>"&&value.entries.every(([,v])=>v.kind==="schema"&&v.schemaType==="fieldToken");
  if(value.kind!=="schema")return false;
  return t===({objectToken:"schema.sobjecttype",objectDescribe:"schema.describesobjectresult",
    fieldToken:"schema.sobjectfield",fieldDescribe:"schema.describefieldresult",displayType:"schema.displaytype"} as const)[value.schemaType];
}
const schemaMapType="map<string,schema.sobjectfield>";
/** Syntax-only proof of read-only Schema chains. Input is already masked
 * (literals/comments cannot supply executable tokens). A typed root is
 * required. Do not treat an arbitrary method named getDescribe as pure. */
export function maskSchemaEffectReads(visible:string,types:ReadonlyMap<string,string>,schemaAllowed:boolean):string{
  let result=visible;
  if(schemaAllowed){
    result=result.replace(/\bSchema\s*\.\s*DisplayType\s*\.\s*([A-Za-z_]\w*)\b/gi,(all,kind:string)=>displayType(kind)?"0":all);
  }
  const roots=/\b(?:Schema\s*\.\s*getGlobalDescribe\s*\(\s*\)\s*\.\s*get\s*\(\s*(?:[A-Za-z_]\w*)?\s*\)|[A-Za-z_]\w*(?=\s*\.))/gi;
  const transitions:Record<string,Record<string,string>>={
    "schema.sobjecttype":{getdescribe:"schema.describesobjectresult"},
    "schema.describesobjectresult":{getname:"string",getsobjecttype:"schema.sobjecttype"},
    [schemaMapType]:{get:"schema.sobjectfield",containskey:"boolean",size:"integer",isempty:"boolean",values:"list<schema.sobjectfield>"},
    "schema.sobjectfield":{getdescribe:"schema.describefieldresult"},
    "schema.describefieldresult":{getname:"string",gettype:"schema.displaytype",getrelationshipname:"string",getreferenceto:"list<schema.sobjecttype>",isnamefield:"boolean",getsobjectfield:"schema.sobjectfield"},
    "schema.displaytype":{name:"string"},
    "list<schema.sobjecttype>":{get:"schema.sobjecttype",size:"integer",isempty:"boolean"}
  };
  // Process from left to right; replace only proven complete read prefixes.
  let out="",cursor=0;
  for(const hit of result.matchAll(roots)){
    const start=hit.index!;if(start<cursor)continue;
    const root=hit[0];
    // A bare match following a dot is a member, not a typed lexical root.
    if(/\.\s*$/.test(result.slice(0,start)))continue;
    let type=/^Schema\s*\./i.test(root)?(schemaAllowed?"schema.sobjecttype":undefined):canonicalApexType(types.get(root.toLowerCase()));
    if(!type||!transitions[type])continue;
    let end=start+root.length,read=/^Schema\s*\./i.test(root);
    for(;;){
      const rest=result.slice(end);
      const fieldMap=/^\s*\.\s*fields\s*\.\s*getMap\s*\(\s*\)/i.exec(rest);
      if(fieldMap&&type==="schema.describesobjectresult"){type=schemaMapType;end+=fieldMap[0].length;read=true;continue;}
      const index=/^\s*\[\s*0\s*\]/.exec(rest);
      if(index&&type==="list<schema.sobjecttype>"){type="schema.sobjecttype";end+=index[0].length;read=true;continue;}
      const operation=/^\s*\.\s*([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*|\d+)?\s*\)/i.exec(rest);
      if(!operation)break;
      const op=operation[1].toLowerCase(),next:string|undefined=transitions[type]?.[op];
      if(!next)break;
      if(op!=="get"&&op!=="containskey"&&operation[2]!==undefined)break;
      if(type==="list<schema.sobjecttype>"&&op==="get"&&operation[2]!=="0")break;
      type=next;end+=operation[0].length;read=true;
    }
    if(!read||/^\s*(?:\.|\[)/.test(result.slice(end)))continue;
    out+=result.slice(cursor,start)+"0";cursor=end;
  }
  return out+result.slice(cursor);
}

/** Recognize a unique name-field search, not arbitrary Map.values order.
 * Supports a local Describe binding and a direct return inside its guard. */
export function schemaNameFieldLoop(node:SourceNode,evaluate:(expression:string)=>ApexValue):ApexValue|undefined{
  if(node.kind!=="for"||canonicalApexType(node.loopVariableType)!=="schema.sobjectfield"||!node.loopVariable||!node.iterable)return undefined;
  const values=readApexMemberOperation(stripApexComments(node.iterable).trim(),n=>/^values$/i.test(n));
  if(!values||values.args.length)return undefined;
  const norm=(s:string)=>stripApexComments(s).replace(/\s+/g,"").toLowerCase();
  const variable=node.loopVariable.toLowerCase();
  const body=[...(node.body??[])];
  let describe=variable+".getdescribe()";
  if(body.length===2&&body[0].kind==="statement"){
    const declaration=/^schema\.describefieldresult([a-z_]\w*)=([a-z_]\w*\.getdescribe\(\));$/.exec(norm(body[0].text??""));
    if(!declaration||declaration[2]!==describe)return undefined;
    describe=declaration[1];body.shift();
  }
  const guard=body[0];
  if(body.length!==1||guard.kind!=="if"||guard.otherwise?.length||guard.body?.length!==1||
    guard.body[0].kind!=="statement"||norm(guard.condition??"")!==describe+".isnamefield()"||
    norm(guard.body[0].text??"")!=="return"+describe+".getname();")return undefined;
  const map=evaluate(values.receiver);
  if(!isSchemaFieldMap(map))return undefined;
  const fields=map.entries.map(([,v])=>v);
  if(fields.some(v=>v.kind!=="schema"||v.schemaType!=="fieldToken"||typeof v.field.nameField!=="boolean"))return undefined;
  const matches=fields.filter(v=>v.kind==="schema"&&v.schemaType==="fieldToken"&&v.field.nameField===true);
  if(!matches.length)return {kind:"null"}; // no iteration returns
  if(matches.length!==1)return undefined; // no proven first matching value
  const desc=evaluateSchemaRead(matches[0],"getDescribe",[]);
  return desc?evaluateSchemaRead(desc,"getName",[]):undefined;
}
