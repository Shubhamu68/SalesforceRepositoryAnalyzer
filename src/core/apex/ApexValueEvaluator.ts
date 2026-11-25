import {lexicalValue,referenceMember} from "./ApexReferenceState.js";
import type {ApexArgumentTypes,ApexCallResolver} from "./ApexTypeSystem.js";
import { splitApexTopLevel, stripApexComments, maskApexSource, matchingPair } from "./ApexSourceModel.js";
import {compareScalars,integerArithmetic,knownBoolean,splitScalarOperator} from "./ApexScalarOperators.js";
import {findApexTernary} from "./ApexConditionalInvocation.js";
import { parseCustomMetadataQuery } from "./ApexCustomMetadataQueryModel.js";
import {evaluateBoundedStringOperation,isBoundedStringOperation} from "./ApexBoundedStringOperations.js";
import {readApexReadOperation} from "./ApexReadOperations.js";
import {evaluateSchemaExpression,evaluateSchemaRead,schemaReceiverEligible,type ApexSchemaValue} from "./ApexSchemaModel.js";

/** Portable abstract Apex values: no Salesforce API calls and no eval(). */
export type ApexValue =
  | ApexSchemaValue
  | { kind: "text"; values: string[]; scalarType?: "boolean" }
  | { kind: "collection"; items: string[]; unique: boolean }
  | { kind: "map"; entries: Array<[string,ApexValue]>; keyType?:"integer"|"string" }
  | { kind: "instance"; className:string; entries: Array<[string,ApexValue]> }
  | { kind: "instanceList"; elementType:string; items:ApexValue[] }
  | { kind: "record"; entries: Array<[string,ApexValue]>; metadataIdentity?:{type:string;developerName:string} }
  | { kind: "records"; items: Array<Array<[string,ApexValue]>> }
  | { kind: "fieldSet"; objectApiName:string; developerName:string }
  | { kind: "null" }
  | { kind: "number"; value: number }
  | { kind: "unknown"; reason: string; symbol?:ApexRuntimeSymbol; fragments?:ApexTextFragment[] };

export interface ApexRuntimeSymbol {name:string;type:string}
export type ApexTextFragment={kind:"literal";text:string}|{kind:"hole";symbol?:ApexRuntimeSymbol};

export type ApexEnvironment = Map<string, ApexValue>;
export const unknown = (reason: string): ApexValue => ({kind:"unknown",reason});
/** Retain source type and identity, never invent a runtime value. */
export function runtimeParameter(name:string,type:string|undefined,reason:string):ApexValue{
  const scalar=type?.toLowerCase();
  return scalar&&/^(?:integer|long|decimal|double|boolean|string|id|date|datetime)$/.test(scalar)
    ?{kind:"unknown",reason,symbol:{name,type:scalar}}:unknown(reason);
}

/** Bounded partial strings remain unknown to every complete-value consumer.
 * Literal fragments are internal evidence, not executable query templates. */
function partialConcatenation(left:ApexValue,right:ApexValue):ApexValue|undefined{
  const incomplete=left.kind==="unknown"?left:right.kind==="unknown"?right:undefined;
  if(!incomplete)return undefined;
  const parts=(v:ApexValue):ApexTextFragment[]|undefined=>{
    if(v.kind==="unknown")return v.fragments??[{kind:"hole",...(v.symbol?{symbol:v.symbol}:{})}];
    if(v.kind==="text"&&v.values.length===1)return [{kind:"literal",text:v.values[0]}];
    if(v.kind==="number")return [{kind:"literal",text:String(v.value)}];
    return undefined;
  };
  // Addition of two unknown numeric operands is not string concatenation.
  const textLike=(v:ApexValue)=>v.kind==="text"||v.kind==="unknown"&&(!!v.fragments||v.symbol?.type==="string");
  if(!textLike(left)&&!textLike(right))return incomplete;
  const a=parts(left),b=parts(right);
  if(!a||!b)return incomplete;
  const joined:ApexTextFragment[]=[];
  for(const part of [...a,...b]){
    const last=joined.at(-1);
    if(part.kind==="literal"&&last?.kind==="literal")joined[joined.length-1]={kind:"literal",text:last.text+part.text};
    else joined.push(part);
  }
  if(joined.length>32||joined.some(v=>v.kind==="literal"&&v.text.length>16000))return incomplete;
  return {kind:"unknown",reason:incomplete.reason,fragments:joined};
}

/** Deliberately excludes literal contents and runtime values from diagnostics. */
export function describePartialApexText(value:ApexValue):string{
  if(value.kind!=="unknown"||!value.fragments)return "";
  const holes=value.fragments.filter((v):v is Extract<ApexTextFragment,{kind:"hole"}>=>v.kind==="hole");
  const literals=value.fragments.length-holes.length;
  const types=[...new Set(holes.map(v=>v.symbol?.type??"untyped"))].sort();
  return " Partial expression evidence: "+literals+" known text fragment(s), "+holes.length+
    " unknown fragment(s) ("+types.join(", ")+"). Complete structure is not proven.";
}
export const textValue = (value: string): ApexValue => ({kind:"text",values:[value]});
export const booleanValue = (value:boolean):ApexValue => ({kind:"text",values:[String(value)],scalarType:"boolean"});
export const listValue = (items: string[], unique = false): ApexValue => ({
  kind:"collection", items:unique?[...new Set(items)]:items, unique,
});
export const MAX_ALTERNATIVES = 32;
const MAX_MAP_ENTRIES = 200;
const MAX_JSON_DEPTH = 6;

/** JSON only, with bounded values; never execute a label as source code. */
export function parseKnownJsonMap(source:string):ApexValue {
  if(source.length>100_000)return unknown("Custom Label JSON exceeds the size limit.");
  let decoded:unknown;
  try{decoded=JSON.parse(source);}catch{return unknown("Custom Label contains invalid JSON.");}
  const convert=(value:unknown,depth:number):ApexValue=>{
    if(depth>MAX_JSON_DEPTH)return unknown("JSON nesting depth exceeded.");
    if(typeof value==="string")return textValue(value);
    if(typeof value==="number"&&Number.isFinite(value))return {kind:"number",value};
    if(!value||typeof value!=="object"||Array.isArray(value))
      return unknown("Only JSON objects of scalar values are supported.");
    const data=value as Record<string,unknown>;
    const keys=Object.keys(data);
    if(keys.length>MAX_MAP_ENTRIES)return unknown("JSON map entry limit exceeded.");
    const entries:Array<[string,ApexValue]>=[];
    for(const key of keys) {
      const item=convert(data[key],depth+1);
      if(item.kind==="unknown")return item;
      entries.push([key,item]);
    }
    return {kind:"map",entries};
  };
  return convert(decoded,0);
}
const MAX_CHARS = 100_000;

export interface ApexExpressionContext {
  values: ReadonlyMap<string,ApexValue>;
  resolveCall?: ApexCallResolver;
  argumentTypes?: (expressions:readonly string[])=>ApexArgumentTypes;
  schemaShadowed?: (name:string)=>boolean;
}

function unescapeApex(token: string): string | null {
  if (!/^'(?:\\.|[^'\\])*'$/s.test(token)) return null;
  return token.slice(1,-1).replace(/\\([nrt'\\])/g,(_whole: string,v: string)=>
    v==="n"?"\n":v==="r"?"\r":v==="t"?"\t":v);
}
function merged(values: string[],scalarType?:"boolean"): ApexValue {
  const unique=[...new Set(values)];
  if(unique.length>MAX_ALTERNATIVES || unique.some(x=>x.length>MAX_CHARS))
    return unknown("Query expression exceeds the bounded alternative/length limit.");
  return {kind:"text",values:unique,...(scalarType?{scalarType}:{})};
}
export function addApexValues(left: ApexValue,right: ApexValue): ApexValue {
  if(left.kind==="unknown"||right.kind==="unknown")return partialConcatenation(left,right)??(left.kind==="unknown"?left:right);
  if(left.kind==="number"&&right.kind==="number")
    return integerArithmetic(left,right,"+");
  if(left.kind==="null"||right.kind==="null")return unknown("Null concatenation is not proven.");
  if(left.kind==="collection"||right.kind==="collection"||
     left.kind==="map"||right.kind==="map"||
     left.kind==="record"||right.kind==="record"||left.kind==="instance"||right.kind==="instance"||
     left.kind==="records"||right.kind==="records"||left.kind==="instanceList"||right.kind==="instanceList"||
     left.kind==="fieldSet"||right.kind==="fieldSet"||left.kind==="schema"||right.kind==="schema")
    return unknown("Cannot concatenate an Apex collection as text.");
  const from=(x:ApexValue):string[]=>
    x.kind==="text"?x.values:x.kind==="number"?[String(x.value)]:[];
  const joined:string[]=[];
  for(const a of from(left))for(const b of from(right)){
    if(joined.length>=MAX_ALTERNATIVES)return unknown("Too many query expression alternatives.");
    joined.push(a+b);
  }
  return merged(joined);
}
/** Legacy JSON maps remain string-keyed. Numeric keys are only accepted
 * for a source-declared Integer map. */
export function apexMapKey(map:Extract<ApexValue,{kind:"map"}>,value:ApexValue):string|null{
  if(map.keyType==="integer")return value.kind==="number"&&Number.isInteger(value.value)&&value.value>=-2147483648&&value.value<=2147483647?String(value.value):null;
  if(map.keyType==="string")return value.kind==="text"&&value.scalarType===undefined&&value.values.length===1?value.values[0]:null;
  return onlyText(value);
}
function onlyText(value: ApexValue): string | null {
  return value.kind==="text"&&value.values.length===1?value.values[0]:
    value.kind==="number"?String(value.value):null;
}
function unwrap(source: string): string {
  let value=source.trim();
  for(;;){
    if(!value.startsWith("(")||!value.endsWith(")"))return value;
    let depth=0, closing=-1, literal=false;
    for(let i=0;i<value.length;i++){
      const c=value[i];
      if(literal&&c==="\\"&&i+1<value.length){i++;continue;}
      if(c==="'")literal=!literal;
      if(literal)continue;
      if(c==="(")depth++;
      if(c===")"&&--depth===0){closing=i;break;}
    }
    if(closing!==value.length-1)return value;
    value=value.slice(1,-1).trim();
  }
}
export function evaluateApexExpression(
  expression: string, context: ApexExpressionContext, depth = 0,
): ApexValue {
  if(depth>32)return unknown("Expression nesting exceeded the limit.");
  const expr=unwrap(stripApexComments(expression));
  if(!expr)return unknown("Empty expression.");
  const literal=unescapeApex(expr);
  if(literal!==null)return textValue(literal);
  if(/^-?\d+(?:\.\d+)?$/.test(expr))return {kind:"number",value:Number(expr)};
  if(/^(true|false)$/i.test(expr))return booleanValue(expr.toLowerCase()==="true");
  if(/^null$/i.test(expr))return {kind:"null"};
  // Qualified member overrides are method-local abstract state, not changes
  // to the repository snapshot.
  const tracked=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(expr)?lexicalValue(context.values,expr):context.values.get(expr);
  if(tracked!==undefined)return tracked;
  if(/^[A-Za-z_]\w*$/.test(expr))return context.values.get(expr) ??
    context.resolveCall?.("Apex.unqualifiedField",[textValue(expr)]) ??
    unknown("Apex symbol "+expr+" has no proven value.");
  const thisField=/^this\.([A-Za-z_]\w*)$/i.exec(expr);
  if(thisField)return context.resolveCall?.("Apex.thisField",[textValue(thisField[1])]) ??
    unknown("Instance field "+thisField[1]+" has no proven object-specific value.");
  const label=/^(?:System\.)?Label\.([A-Za-z_]\w*)$/i.exec(expr);
  if(label)return context.resolveCall?.("System.Label",[textValue(label[1])]) ??
    unknown("Custom Label "+label[1]+" is not available from complete org metadata.");
  if(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,}$/.test(expr)){
    const member=referenceMember(context.values,expr);if(member!==undefined)return member;
  }
  const instanceMember=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
  if(instanceMember && lexicalValue(context.values,instanceMember[1])?.kind==="instance"){
    const instance=lexicalValue(context.values,instanceMember[1])!;
    if(instance.kind==="instance")return instance.entries.find(([key])=>key.toLowerCase()===instanceMember[2].toLowerCase())?.[1]??unknown("Instance member "+instanceMember[2]+" is not proven.");
  }
  if(instanceMember && lexicalValue(context.values,instanceMember[1])?.kind==="record"){
    const record=lexicalValue(context.values,instanceMember[1])!;
    if(record.kind==="record"&&record.metadataIdentity)
      return context.resolveCall?.("Apex.metadataGetInstance",[textValue(record.metadataIdentity.type),textValue(record.metadataIdentity.developerName),textValue(instanceMember[2])])??unknown("Custom Metadata record field is not available.");
    if(record.kind==="record")
      return record.entries.find(([key])=>key.toLowerCase()===instanceMember[2].toLowerCase())?.[1] ??
        unknown("Metadata row field "+instanceMember[2]+" was not completely retrieved.");
  }
  const schemaContext={
    evaluate:(part:string)=>evaluateApexExpression(part,context,depth+1),
    resolveCall:context.resolveCall,
    shadowed:(root:string)=>lexicalValue(context.values,root)!==undefined||!!context.schemaShadowed?.(root),
    receiverEligible:(part:string)=>lexicalValue(context.values,part)?.kind==="schema"||
      schemaReceiverEligible(part,context.argumentTypes?.([part])?.[0])
  };
  if(/^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+$/.test(expr)){
    const schema=evaluateSchemaExpression(expr,schemaContext);if(schema!==undefined)return schema;
  }
  const constant=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
  if(constant&&lexicalValue(context.values,constant[1])!==undefined)
    return unknown("Instance member expression "+expr+" depends on runtime object state.");
  if(constant)return context.resolveCall?.("Apex.constant",[textValue(expr)]) ??
    unknown(/^[a-z]/.test(constant[1])
      ?"Instance member expression "+expr+" depends on runtime object state."
      :"Repository Apex constant "+expr+" has no proven immutable literal value.");
  const ternary=findApexTernary(maskApexSource(expr));
  if(ternary){
    const condition=evaluateApexExpression(expr.slice(0,ternary.question),context,depth+1);
    const value=knownBoolean(condition);
    const yes=expr.slice(ternary.question+1,ternary.colon);
    const no=expr.slice(ternary.colon+1);
    if(value===true)return evaluateApexExpression(yes,context,depth+1);
    if(value===false)return evaluateApexExpression(no,context,depth+1);
    const a=evaluateApexExpression(yes,context,depth+1);
    const b=evaluateApexExpression(no,context,depth+1);
    return a.kind==="text"&&b.kind==="text"
      ?merged([...a.values,...b.values],a.scalarType==="boolean"&&b.scalarType==="boolean"?"boolean":undefined)
      :unknown("Unknown ternary expression alternatives.");
  }
  for(const operator of ["||","&&"]){
    const terms=splitApexTopLevel(expr,operator);
    if(terms.length>1){
      let unknownTerm=false;
      for(const term of terms){
        const check=knownBoolean(evaluateApexExpression(term,context,depth+1));
        if(check===undefined){unknownTerm=true;continue;}
        if((operator==="&&"&&!check)||(operator==="||"&&check))return booleanValue(check);
      }
      return unknownTerm?unknown("Boolean condition depends on runtime inputs."):booleanValue(operator==="&&");
    }
  }
  for(const operators of [["==","!="],["<",">","<=",">="],["+","-"],["*","/"]]){
    const operation=splitScalarOperator(expr,operators);
    if(!operation)continue;
    const left=evaluateApexExpression(operation.left,context,depth+1);
    const right=evaluateApexExpression(operation.right,context,depth+1);
    if(operation.operator==="+")return addApexValues(left,right);
    if(["-","*","/"].includes(operation.operator))return integerArithmetic(left,right,operation.operator);
    return compareScalars(left,right,operation.operator);
  }
  if(expr.startsWith("!")&&!expr.startsWith("!=")){
    const value=knownBoolean(evaluateApexExpression(expr.slice(1),context,depth+1));
    return value===undefined?unknown("Negated conditional depends on runtime input."):booleanValue(!value);
  }
  if(expr.startsWith("-")){
    return integerArithmetic({kind:"number",value:0},evaluateApexExpression(expr.slice(1),context,depth+1),"-");
  }
  // Keep custom-object allocations and their correlated member values separate.
  const instanceList=/^new\s+List\s*<\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*>\s*(?:\{([\s\S]*)\}|\(\s*\))$/i.exec(expr);
  if(instanceList&&!/^(?:String|Id|Integer|Long|Decimal|Double|Boolean|Date|Datetime|Time|Blob|Object|SObject)$/i.test(instanceList[1])){
    const items=instanceList[2]?.trim()?splitApexTopLevel(instanceList[2],",").map(item=>evaluateApexExpression(item,context,depth+1)):[];
    const type=instanceList[1].toLowerCase();
    if(items.length>100||items.some(item=>item.kind!=="instance"||!(item.className.toLowerCase()===type||item.className.toLowerCase().endsWith("."+type))))
      return unknown("Custom Apex list contains an unproven instance or exceeds the item bound.");
    return {kind:"instanceList",elementType:instanceList[1],items};
  }
  const create=/^new\s+(List|Set)\s*<[\w\s,.<>]+>\s*(?:\(([\s\S]*)\)|\{([\s\S]*)\})$/i.exec(expr);
  if(create){
    const unique=create[1].toLowerCase()==="set";
    if(create[3]!==undefined){
      const items=splitApexTopLevel(create[3],",");
      const values:string[]=[];
      for(const item of items){
        if(!item.trim())continue;
        const result=evaluateApexExpression(item,context,depth+1);
        const s=onlyText(result);
        if(s===null)return unknown("Collection initializer contains a runtime value: "+
          (result.kind==="unknown"?result.reason:item));
        values.push(s);
      }
      return listValue(values,unique);
    }
    if(!create[2]?.trim())return listValue([],unique);
    const argument=evaluateApexExpression(create[2],context,depth+1);
    return argument.kind==="collection"?listValue(argument.items,unique)
      :unknown("Collection constructor input is not resolved: "+
        (argument.kind==="unknown"?argument.reason:"input is not a collection."));
  }
  // Both source-level Field Set access forms refer to the same ordered
  // live-org metadata inventory. Neither reads business data.
  const fieldSet=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\(([^()]*)\)$/i.exec(expr)??
    /^Schema\.SObjectType\.([A-Za-z_]\w*)\.fieldSets\.getMap\(\)\.get\(([^()]*)\)$/i.exec(expr);
  if(fieldSet){
    const name=evaluateApexExpression(fieldSet[2],context,depth+1);
    if(name.kind!=="text"||name.values.length!==1)
      return unknown("Field Set name depends on unproven Apex runtime input.");
    return {kind:"fieldSet",objectApiName:fieldSet[1],developerName:name.values[0]};
  }
  const fieldSetChain=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\(([\s\S]+)\)\.getFields\(\)$/i.exec(expr)??
    /^Schema\.SObjectType\.([A-Za-z_]\w*)\.fieldSets\.getMap\(\)\.get\(([\s\S]+)\)\.getFields\(\)$/i.exec(expr);
  if(fieldSetChain){
    const name=evaluateApexExpression(fieldSetChain[2],context,depth+1);
    return name.kind==="text"&&name.values.length===1
      ?context.resolveCall?.("Schema.fieldSetFields",[textValue(fieldSetChain[1]),name]) ??
        unknown("Complete Field Set members not available from connected org.")
      :unknown("Field Set name not proven.");
  }
  // Resolve metadata binds in the current lexical environment (including
  // helper parameters and known member initializers), not at source discovery.
  if(/^\[\s*SELECT\b[\s\S]*\]$/i.test(expr)){
    const query=parseCustomMetadataQuery(expr);
    if(!query)return unknown("Static Custom Metadata WHERE or SELECT expression is unsupported.");
    const values:ApexValue[]=[];
    for(const predicate of query.predicates){
      const value=evaluateApexExpression(predicate.right,context,depth+1);
      if(value.kind==="unknown")return unknown("Custom Metadata "+query.type+
        " WHERE "+predicate.field+" has an unresolved runtime bind: "+value.reason);
      if(onlyText(value)===null)
        return unknown("Custom Metadata "+query.type+" WHERE "+predicate.field+
          " does not have one supported scalar value.");
      values.push(value);
    }
    return context.resolveCall?.("Apex.metadataRows",[textValue(query.expression),...values]) ??
      unknown("Complete Custom Metadata "+query.type+" rows have not been established.");
  }
  // Schema Describe is a metadata dependency, not a method to execute.
  // A caller-supplied read-only snapshot must prove the complete field list.
  const directDescribe=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fields\.getMap\(\)$/i.exec(expr);
  if(directDescribe)return context.resolveCall?.("Schema.describeFields",[textValue(directDescribe[1])]) ??
    unknown("Schema Describe fields are unavailable for "+directDescribe[1]+".");
  const describe=/^Schema\.getGlobalDescribe\(\)\.get\(([^)]*)\)\.getDescribe\(\)\.fields\.getMap\(\)$/i.exec(expr);
  if(describe){
    const object=evaluateApexExpression(describe[1],context,depth+1);
    return context.resolveCall?.("Schema.describeFields",[object]) ??
      unknown("Schema Describe fields are unavailable for the target object.");
  }
  // Rich Schema reads use the same metadata boundary as the legacy
  // field-name inventory above. No change to existing map/Field Set values.
  const schema=evaluateSchemaExpression(expr,schemaContext);
  if(schema!==undefined)return schema;
  // Apex allows a generic Map cast on JSON.deserialize results. Only remove
  // a type cast directly attached to a JSON call, never arbitrary expressions.
  const cast=/^\(Map\s*<[\w\s,.<>]+>\)\s*(JSON\.deserialize\([\s\S]*\))$/i.exec(expr);
  if(cast)return evaluateApexExpression(cast[1],context,depth+1);
  const emptyMap=/^new\s+Map\s*<\s*(Integer|String)\s*,[\w\s,.<>]+>\s*\(\s*\)$/i.exec(expr);
  if(emptyMap)return {kind:"map",entries:[],keyType:emptyMap[1].toLowerCase() as "integer"|"string"};
  if(/^new\s+Map\s*<[\w\s,.<>]+>\s*\(\s*\)$/i.test(expr))return {kind:"map",entries:[]};
  const mapLiteral=/^new\s+Map\s*<\s*([A-Za-z_]\w*)\s*,[\w\s,.<>]+>\s*\{([\s\S]*)\}$/i.exec(expr);
  if(mapLiteral){
    const keyType=mapLiteral[1].toLowerCase();
    const map:Extract<ApexValue,{kind:"map"}>={kind:"map",entries:[],...((keyType==="integer"||keyType==="string")?{keyType}: {})};
    const entries=map.entries;
    for(const item of splitApexTopLevel(mapLiteral[2],",")){
      if(!item.trim())continue;
      const pair=splitApexTopLevel(item,"=>");
      if(pair.length!==2)return unknown("Apex map initializer is malformed.");
      const keyValue=evaluateApexExpression(pair[0],context,depth+1);
      const key=apexMapKey(map,keyValue);
      const val=evaluateApexExpression(pair[1],context,depth+1);
      if(key===null)return unknown("Apex map initializer has an unproven key: "+
        pair[0].trim()+"; cause: "+
        (keyValue.kind==="unknown"?keyValue.reason:"Map key is not a single scalar."));
      if(val.kind==="unknown")
        return unknown("Apex map initializer for key "+key+" is unproven: "+val.reason);
      if(entries.some(([existing])=>existing===key))return unknown("Duplicate map initializer key is not proven.");
      entries.push([key,val]);
      if(entries.length>MAX_MAP_ENTRIES)return unknown("Apex map entry limit exceeded.");
    }
    return map;
  }
  const allocation=/^new\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/i.exec(expr);
  if(allocation){
    const pieces=allocation[2].trim()?splitApexTopLevel(allocation[2],","):[];
    const args=pieces.map(x=>evaluateApexExpression(x,context,depth+1));
    return context.resolveCall?.("Apex.construct",[textValue(allocation[1]),...args],[undefined,...(context.argumentTypes?.(pieces)??pieces.map(()=>undefined))])??
      unknown("Apex constructor "+allocation[1]+" is not proven.");
  }
  // Simple lexical list/index access. A metadata result without ORDER BY
  // has no proven positional identity unless exactly one row matched.
  const indexed=/^([A-Za-z_]\w*)\s*\[([\s\S]+)\]$/.exec(expr);
  if(indexed){
    const receiver=evaluateApexExpression(indexed[1],context,depth+1);
    const index=evaluateApexExpression(indexed[2],context,depth+1);
    if(index.kind==="number"&&Number.isInteger(index.value)&&index.value>=0){
      if(receiver.kind==="records"&&receiver.items.length===1&&index.value===0)
        return {kind:"record",entries:receiver.items[0]};
      if(receiver.kind==="collection"&&!receiver.unique&&index.value<receiver.items.length)
        return textValue(receiver.items[index.value]);
      if(receiver.kind==="instanceList"&&index.value<receiver.items.length)
        return receiver.items[index.value];
    }
    return unknown("Indexed Apex value or row ordering is not proven.");
  }
  // Shared read-operation syntax; preserve simple helper dispatch.
  const operation=readApexReadOperation(expr);
  if(operation){
    if(isBoundedStringOperation(operation.name)){
      return evaluateBoundedStringOperation(evaluateApexExpression(operation.receiver,context,depth+1),operation.name,
        operation.args.map(x=>evaluateApexExpression(x,context,depth+1)));
    }
    if(/\)$/.test(operation.receiver)){
      return evaluateApexReadOperation(evaluateApexExpression(operation.receiver,context,depth+1),operation.name,
        operation.args.map(x=>evaluateApexExpression(x,context,depth+1)));
    }
  }
  const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/s.exec(expr);
  if(call){
    const name=call[1];
    const pieces=call[2].trim()?splitApexTopLevel(call[2],","):[];
    const args=pieces.map(x=>evaluateApexExpression(x,context,depth+1));
    const lname=name.toLowerCase();
    const metadataInstance=/^([A-Za-z_]\w*__mdt)\.getInstance$/i.exec(name);
    if(metadataInstance&&args.length===1)
      return context.resolveCall?.("Apex.metadataGetInstance",[textValue(metadataInstance[1]),args[0]])??unknown("Custom Metadata getInstance identity is not proven.");
    if(lname.endsWith(".getfields")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-10),context,depth+1);
      if(receiver.kind==="fieldSet")
        return context.resolveCall?.("Schema.fieldSetFields",[
          textValue(receiver.objectApiName),textValue(receiver.developerName)]) ??
          unknown("Field Set members not proven from authoritative metadata.");
      if(receiver.kind==="unknown"){
        const qualifier=name.slice(0,-10);
        // getFields is also a legitimate repository static helper name.
        // A known lexical receiver must still use the Field Set semantics.
        if(/^[A-Za-z_]\w*$/.test(qualifier)&&!context.values.has(qualifier)){
          const helper=context.resolveCall?.(name,args,context.argumentTypes?.(pieces));
          if(helper!==undefined)return helper;
        }
        return receiver;
      }
    }
    if(lname.endsWith(".getfieldpath")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-13),context,depth+1);
      if(receiver.kind==="text")return receiver;
      if(receiver.kind==="unknown")return receiver;
    }
    if(lname==="json.deserialize") {
      // Apex .class type expressions contain generic commas, which are not
      // runtime arguments. Reconstitute and validate the type token instead
      // of relying on the generic comma splitter to parse angle brackets.
      const typeToken=pieces.slice(1).join(",").trim();
      if(pieces.length<2||
         !/^(?:Map|List|Set)<[\w\s,.<>]+>\.class$/i.test(typeToken))
        return unknown("JSON.deserialize target type is not a supported collection map.");
      const input=evaluateApexExpression(pieces[0],context,depth+1);
      if(input.kind!=="text"||input.values.length!==1)
        return unknown("JSON.deserialize input must be a single proven label value: "+
          (input.kind==="unknown"?input.reason:"input is not a single text value."));
      return parseKnownJsonMap(input.values[0]);
    }
    if(lname.endsWith(".keyset")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-7),context,depth+1);
      return receiver.kind==="map"?receiver.keyType==="integer"?unknown("Integer map keySet is not a String collection."):listValue(receiver.entries.map(([key])=>key),true):
        // Schema Describe maps are represented by a known field-name collection.
        receiver.kind==="collection"?listValue(receiver.items,true):
        unknown("Map keySet() receiver is unresolved: "+
          (receiver.kind==="unknown"?receiver.reason:"receiver is not a map."));
    }
    if(lname.endsWith(".containskey")&&args.length===1){
      const receiver=evaluateApexExpression(name.slice(0,-12),context,depth+1);
      const key=receiver.kind==="map"?apexMapKey(receiver,args[0]):onlyText(args[0]);
      if(key===null)return unknown("Map.containsKey depends on runtime or incompatible key.");
      if(receiver.kind==="map")return booleanValue(receiver.entries.some(([k])=>k===key));
      if(receiver.kind==="collection")return booleanValue(receiver.items.includes(key));
      if(receiver.kind==="unknown")return receiver;
      return unknown("Map.containsKey receiver is not proven as a map.");
    }
    if(lname.endsWith(".get")&&args.length===1){
      const receiver=evaluateApexExpression(name.slice(0,-4),context,depth+1);
      // Preserve the actual missing metadata/helper dependency instead of
      // reporting a misleading "unsupported map.get" error.
      if(receiver.kind==="unknown")return receiver;
      if(receiver.kind==="instanceList"){
        const index=args[0];
        return index.kind==="number"&&Number.isInteger(index.value)&&index.value>=0&&index.value<receiver.items.length
          ?receiver.items[index.value]:unknown("Custom Apex list index is not proven.");
      }
      if(receiver.kind==="map"){
        const key=apexMapKey(receiver,args[0]);
        if(key===null)return unknown("Map.get key depends on runtime or incompatible input: "+
          (args[0].kind==="unknown"?args[0].reason:"key is not a single scalar."));
        return receiver.entries.find(([item])=>item===key)?.[1] ??
          unknown("Map.get key "+key+" absent from proven configuration.");
      }
    }
    // Pure scalar conversions used by immutable static initializers and
    // dynamic SELECT fragments. Runtime/collection inputs remain unknown.
    if((lname==="math.min"||lname==="math.max")&&args.length===2&&args.every(v=>v.kind==="number"&&Number.isInteger(v.value)&&v.value>=-2147483648&&v.value<=2147483647)){
      const numbers=args.map(v=>v.kind==="number"?v.value:0);
      return {kind:"number",value:lname==="math.min"?Math.min(...numbers):Math.max(...numbers)};
    }
    if(lname==="string.valueof"&&args.length===1){
      if(args[0].kind==="text")return {kind:"text",values:args[0].values};
      if(args[0].kind==="number")return textValue(String(args[0].value));
      return unknown("String.valueOf argument has no proven scalar value.");
    }
    if((lname==="integer.valueof"||lname==="decimal.valueof"||
        lname==="long.valueof")&&args.length===1){
      const input=onlyText(args[0]);
      if(input===null||!/^-?\d+(?:\.\d+)?$/.test(input))
        return unknown(name+" requires a proven numeric scalar.");
      const value=Number(input);
      if(!Number.isFinite(value))
        return unknown(name+" numeric result is not finite.");
      if(lname==="integer.valueof"&&!Number.isInteger(value))
        return unknown("Integer.valueOf received a non-integer.");
      return {kind:"number",value};
    }
    if(lname==="string.join"&&args.length===2){
      if(args[0].kind!=="collection")return unknown("String.join collection is not known: "+
        (args[0].kind==="unknown"?args[0].reason:"input is not a collection."));
      const sep=onlyText(args[1]);
      return sep!==null?textValue(args[0].items.join(sep)):unknown("String.join delimiter is unknown.");
    }
    if(lname==="string.isempty"&&args.length===1){
      if(args[0].kind==="null")return booleanValue(true);
      const s=onlyText(args[0]);
      return s!==null?booleanValue(s.length===0):
        unknown("String.isEmpty input depends on runtime value.");
    }
    if((lname==="string.isblank"||lname==="string.isnotblank")&&args.length===1){
      if(args[0].kind==="null")return booleanValue(lname==="string.isblank");
      const text=onlyText(args[0]);if(text===null)return unknown("String blankness depends on runtime input.");
      const blank=text.trim().length===0;
      return booleanValue(lname==="string.isblank"?blank:!blank);
    }
    if(lname==="string.escapesinglequotes"&&args.length===1){
      if(args[0].kind==="unknown"&&args[0].fragments){
        return {...args[0],reason:"escapeSingleQuotes input unknown: "+args[0].reason,
          fragments:args[0].fragments.map(part=>part.kind==="literal"?{...part,text:part.text.replace(/'/g,"\\\'")}:part)};
      }
      if(args[0].kind!=="text")return unknown("escapeSingleQuotes input unknown: "+
        (args[0].kind==="unknown"?args[0].reason:"input is not text."));
      return merged(args[0].values.map(x=>x.replace(/'/g,"\\'")));
    }
    const methods=["removeend","trim","tolowercase","touppercase","isempty","split","equalsignorecase","containsignorecase","contains"];
    const dot=name.lastIndexOf(".");
    const operation=name.slice(dot+1).toLowerCase();
    if(dot>=0&&methods.includes(operation)){
      const receiver=evaluateApexExpression(name.slice(0,dot),context,depth+1);
      if(operation==="isempty"&&receiver.kind==="collection")return booleanValue(receiver.items.length===0);
      if(operation==="isempty"&&receiver.kind==="map")return booleanValue(receiver.entries.length===0);
      if(operation==="isempty"&&receiver.kind==="instanceList")return booleanValue(receiver.items.length===0);
      if(operation==="isempty"&&receiver.kind==="records")return booleanValue(receiver.items.length===0);
      if(operation==="contains"&&receiver.kind==="collection"){
        const item=args.length===1?args[0]:undefined;
        if(item?.kind!=="text"||item.values.length!==1||item.scalarType==="boolean")
          return unknown("Collection.contains requires one proven string element.");
        return booleanValue(receiver.items.includes(item.values[0]));
      }
      if(receiver.kind!=="text")return unknown("Receiver for "+operation+" not resolved: "+
        (receiver.kind==="unknown"?receiver.reason:"receiver is not text."));
      const argument=args.length?onlyText(args[0]):null;
      if(operation==="trim")return merged(receiver.values.map(x=>x.trim()));
      if(operation==="tolowercase")return merged(receiver.values.map(x=>x.toLowerCase()));
      if(operation==="touppercase")return merged(receiver.values.map(x=>x.toUpperCase()));
      if(operation==="isempty")return merged(receiver.values.map(x=>String(x.length===0)),"boolean");
      if(argument===null)return unknown("Argument for "+operation+" is not resolved.");
      if(operation==="removeend")return merged(receiver.values.map(x=>x.endsWith(argument)?x.slice(0,-argument.length):x));
      if(operation==="equalsignorecase")return merged(receiver.values.map(x=>String(x.toLowerCase()===argument.toLowerCase())),"boolean");
      if(operation==="contains"&&args.length===1)return merged(receiver.values.map(x=>String(x.includes(argument))),"boolean");
      if(operation==="containsignorecase")return merged(receiver.values.map(x=>String(x.toLowerCase().includes(argument.toLowerCase()))),"boolean");
      if(operation==="split"){
        const one=onlyText(receiver);
        return one!==null?listValue(one.split(argument)):unknown("Split has multiple possible inputs.");
      }
    }
    return context.resolveCall?.(name,args,context.argumentTypes?.(pieces))??unknown("Unsupported or external Apex method: "+name);
  }
  return unknown("Unsupported Apex expression: "+expr.slice(0,100));
}


/** Apply an existing built-in to already resolved values without inserting
 * synthetic bindings in an execution frame or consulting external helpers. */
export function evaluateApexReadOperation(receiver:ApexValue,name:string,args:readonly ApexValue[]):ApexValue{
  const schema=evaluateSchemaRead(receiver,name,args);if(schema!==undefined)return schema;
  if(isBoundedStringOperation(name))return evaluateBoundedStringOperation(receiver,name,args);
  const values=new Map<string,ApexValue>([["receiver",receiver]]);
  const names=args.map((value,i)=>{const key="arg"+i;values.set(key,value);return key;});
  return evaluateApexExpression("receiver."+name+"("+names.join(",")+")",{values});
}
