import type {ApexObjectSchema,ApexSchemaField,MetadataResult} from "../metadata/ApexMetadataProvider.js";
import type {ApexValue} from "./ApexValueEvaluator.js";
import type {ApexCallResolver} from "./ApexTypeSystem.js";
import {readApexMemberOperation} from "./ApexReadOperations.js";
import {maskApexSource,matchingPair} from "./ApexSourceModel.js";

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
  const details:ApexSchemaField={name:match.name,
    ...(typeof match.type==="string"?{type:match.type}:{}),
    ...(typeof match.relationshipName==="string"||match.relationshipName===null?{relationshipName:match.relationshipName}:{}),
    ...(Array.isArray(match.referenceTo)&&match.referenceTo.every(v=>typeof v==="string"&&name.test(v))?{referenceTo:[...match.referenceTo]}:{}),
    ...(typeof match.nameField==="boolean"?{nameField:match.nameField}:{})};
  return {kind:"schema",schemaType:"fieldToken",objectApiName:snapshot.name,field:details};
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
/** Shared syntactic adapter. Only explicit compile-time tokens, direct
 * dynamic object lookup, inline field-map lookup, and typed Schema receiver
 * reads are supported. Never interpret application properties as metadata. */
export function evaluateSchemaExpression(expr:string,ctx:SchemaExpressionContext):ApexValue|undefined{
  const allowed=(root:string)=>!ctx.shadowed?.(root);
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
  const global=/^Schema\s*\.\s*getGlobalDescribe\s*\(\s*\)\s*\.\s*get\s*\(([\s\S]*)\)$/i.exec(expr);
  if(global&&matchingPair(maskApexSource(expr),expr.lastIndexOf("(",expr.indexOf(global[1])))===expr.length-1){
    const object=one(ctx.evaluate(global[1]));
    return allowed("Schema")&&object&&name.test(object)?lookup(object):unknown("Schema object name is not known.");
  }
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
  const targetIndex=/^([\s\S]+\.getReferenceTo\s*\(\s*\))\s*\[\s*(\d+)\s*\]$/i.exec(expr);
  if(targetIndex){
    const list=ctx.evaluate(targetIndex[1]);
    return list.kind==="instanceList"&&list.elementType==="Schema.SObjectType"&&list.items.length===1&&Number(targetIndex[2])===0?
      list.items[0]:unknown("Schema reference target position is not proven.");
  }
  const call=readApexMemberOperation(expr,isSchemaReadOperation);
  if(call&&(!ctx.receiverEligible||ctx.receiverEligible(call.receiver))){
    const receiver=ctx.evaluate(call.receiver);
    if(receiver.kind==="schema")return evaluateSchemaRead(receiver,call.name,call.args.map(ctx.evaluate));
    if(receiver.kind==="unknown"&&ctx.receiverEligible)return receiver;
  }
  return undefined;
}
