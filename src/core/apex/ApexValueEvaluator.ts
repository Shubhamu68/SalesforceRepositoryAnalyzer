import { splitApexTopLevel, stripApexComments } from "./ApexSourceModel.js";

/** Portable abstract Apex values: no Salesforce API calls and no eval(). */
export type ApexValue =
  | { kind: "text"; values: string[] }
  | { kind: "collection"; items: string[]; unique: boolean }
  | { kind: "map"; entries: Array<[string,ApexValue]> }
  | { kind: "record"; entries: Array<[string,ApexValue]> }
  | { kind: "records"; items: Array<Array<[string,ApexValue]>> }
  | { kind: "fieldSet"; objectApiName:string; developerName:string }
  | { kind: "number"; value: number }
  | { kind: "unknown"; reason: string };

export type ApexEnvironment = Map<string, ApexValue>;
export const unknown = (reason: string): ApexValue => ({kind:"unknown",reason});
export const textValue = (value: string): ApexValue => ({kind:"text",values:[value]});
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
  resolveCall?: (name: string, args: ApexValue[]) => ApexValue | undefined;
}

function unescapeApex(token: string): string | null {
  if (!/^'(?:\\.|[^'\\])*'$/s.test(token)) return null;
  return token.slice(1,-1).replace(/\\([nrt'\\])/g,(_whole: string,v: string)=>
    v==="n"?"\n":v==="r"?"\r":v==="t"?"\t":v);
}
function merged(values: string[]): ApexValue {
  const unique=[...new Set(values)];
  if(unique.length>MAX_ALTERNATIVES || unique.some(x=>x.length>MAX_CHARS))
    return unknown("Query expression exceeds the bounded alternative/length limit.");
  return {kind:"text",values:unique};
}
function combinations(left: ApexValue,right: ApexValue): ApexValue {
  if(left.kind==="unknown")return left;
  if(right.kind==="unknown")return right;
  if(left.kind==="number"&&right.kind==="number")
    return {kind:"number",value:left.value+right.value};
  if(left.kind==="collection"||right.kind==="collection"||
     left.kind==="map"||right.kind==="map"||
     left.kind==="record"||right.kind==="record"||
     left.kind==="records"||right.kind==="records"||
     left.kind==="fieldSet"||right.kind==="fieldSet")
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
  if(/^(true|false)$/i.test(expr))return textValue(expr.toLowerCase());
  if(expr==="null")return textValue("null");
  if(/^[A-Za-z_]\w*$/.test(expr))return context.values.get(expr)??unknown("Apex symbol "+expr+" has no proven value.");
  const label=/^System\.Label\.([A-Za-z_]\w*)$/i.exec(expr);
  if(label)return context.resolveCall?.("System.Label",[textValue(label[1])]) ??
    unknown("Custom Label "+label[1]+" is not available from complete org metadata.");
  const instanceMember=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
  if(instanceMember && context.values.get(instanceMember[1])?.kind==="record"){
    const record=context.values.get(instanceMember[1])!;
    if(record.kind==="record")
      return record.entries.find(([key])=>key.toLowerCase()===instanceMember[2].toLowerCase())?.[1] ??
        unknown("Metadata row field "+instanceMember[2]+" was not completely retrieved.");
  }
  const constant=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
  if(constant)return context.resolveCall?.("Apex.constant",[textValue(expr)]) ??
    unknown(/^[a-z]/.test(constant[1])
      ?"Instance member expression "+expr+" depends on runtime object state."
      :"Repository Apex constant "+expr+" has no proven immutable literal value.");
  if(expr.startsWith("!") && !expr.startsWith("!=")){
    const result=evaluateApexExpression(expr.slice(1),context,depth+1);
    const simple=onlyText(result);
    return simple==="true"?textValue("false"):simple==="false"?textValue("true"):
      unknown("Negated conditional depends on runtime input.");
  }
  for(const operator of ["||","&&"]){
    const terms=splitApexTopLevel(expr,operator);
    if(terms.length>1){
      const checks=terms.map(term=>onlyText(evaluateApexExpression(term,context,depth+1)));
      if(operator==="&&"&&checks.includes("false"))return textValue("false");
      if(operator==="||"&&checks.includes("true"))return textValue("true");
      if(checks.every(c=>c==="true"||c==="false"))
        return textValue(String(operator==="&&"?checks.every(c=>c==="true"):checks.some(c=>c==="true")));
      return unknown("Boolean condition depends on runtime inputs.");
    }
  }
  const alternatives=splitApexTopLevel(expr,"?");
  if(alternatives.length===2){
    const branch=splitApexTopLevel(alternatives[1],":");
    if(branch.length===2){
      const condition=evaluateApexExpression(alternatives[0],context,depth+1);
      const value=onlyText(condition);
      if(value==="true")return evaluateApexExpression(branch[0],context,depth+1);
      if(value==="false")return evaluateApexExpression(branch[1],context,depth+1);
      const a=evaluateApexExpression(branch[0],context,depth+1);
      const b=evaluateApexExpression(branch[1],context,depth+1);
      return a.kind==="text"&&b.kind==="text"
        ?merged([...a.values,...b.values])
        :unknown("Unknown ternary expression alternatives.");
    }
  }
  for(const operator of ["==","!="]){
    const parts=splitApexTopLevel(expr,operator);
    if(parts.length===2){
      const left=evaluateApexExpression(parts[0],context,depth+1);
      const right=evaluateApexExpression(parts[1],context,depth+1);
      const a=onlyText(left),b=onlyText(right);
      if(a!==null&&b!==null)
        return textValue(String(operator==="=="?a===b:a!==b));
      const cause=left.kind==="unknown"?left.reason:
        right.kind==="unknown"?right.reason:
        "Both operands must have one complete scalar value.";
      return unknown("Runtime conditional comparison "+expr+" is unproven: "+cause);
    }
  }
  const plus=splitApexTopLevel(expr,"+");
  if(plus.length>1){
    const parts=plus.map(item=>evaluateApexExpression(item,context,depth+1));
    return parts.slice(1).reduce<ApexValue>((a,b)=>combinations(a,b),parts[0]);
  }
  const create=/^new\s+(List|Set)<[\w\s,.<>]+>\s*(?:\(([\s\S]*)\)|\{([\s\S]*)\})$/i.exec(expr);
  if(create){
    const unique=create[1].toLowerCase()==="set";
    if(create[3]!==undefined){
      const items=splitApexTopLevel(create[3],",");
      const values:string[]=[];
      for(const item of items){
        if(!item.trim())continue;
        const result=evaluateApexExpression(item,context,depth+1);
        const s=onlyText(result);
        if(s===null)return unknown("Collection initializer contains a runtime value.");
        values.push(s);
      }
      return listValue(values,unique);
    }
    if(!create[2]?.trim())return listValue([],unique);
    const argument=evaluateApexExpression(create[2],context,depth+1);
    return argument.kind==="collection"?listValue(argument.items,unique)
      :unknown("Collection constructor input is not resolved.");
  }
  const fieldSet=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\(([^()]*)\)$/i.exec(expr);
  if(fieldSet){
    const name=evaluateApexExpression(fieldSet[2],context,depth+1);
    if(name.kind!=="text"||name.values.length!==1)
      return unknown("Field Set name depends on unproven Apex runtime input.");
    return {kind:"fieldSet",objectApiName:fieldSet[1],developerName:name.values[0]};
  }
  const fieldSetChain=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\(([\s\S]+)\)\.getFields\(\)$/i.exec(expr);
  if(fieldSetChain){
    const name=evaluateApexExpression(fieldSetChain[2],context,depth+1);
    return name.kind==="text"&&name.values.length===1
      ?context.resolveCall?.("Schema.fieldSetFields",[textValue(fieldSetChain[1]),name]) ??
        unknown("Complete Field Set members not available from connected org.")
      :unknown("Field Set name not proven.");
  }
  // Only custom-metadata SOQL used in a for-each iterable can be supplied as
  // a complete row set; ordinary bracketed SOQL is not a scalar expression.
  if(/^\[\s*SELECT\b[\s\S]*\]$/i.test(expr))
    return context.resolveCall?.("Apex.metadataRows",[textValue(expr)]) ??
      unknown("Static metadata query rows have not been completely established.");
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
  // Apex allows a generic Map cast on JSON.deserialize results. Only remove
  // a type cast directly attached to a JSON call, never arbitrary expressions.
  const cast=/^\(Map\s*<[\w\s,.<>]+>\)\s*(JSON\.deserialize\([\s\S]*\))$/i.exec(expr);
  if(cast)return evaluateApexExpression(cast[1],context,depth+1);
  if(/^new\s+Map\s*<[\w\s,.<>]+>\s*\(\s*\)$/i.test(expr))
    return {kind:"map",entries:[]};
  const mapLiteral=/^new\s+Map\s*<[\w\s,.<>]+>\s*\{([\s\S]*)\}$/i.exec(expr);
  if(mapLiteral){
    const entries:Array<[string,ApexValue]>=[];
    for(const item of splitApexTopLevel(mapLiteral[1],",")){
      if(!item.trim())continue;
      const pair=splitApexTopLevel(item,"=>");
      if(pair.length!==2)return unknown("Apex map initializer is malformed.");
      const keyValue=evaluateApexExpression(pair[0],context,depth+1);
      const key=onlyText(keyValue);
      const val=evaluateApexExpression(pair[1],context,depth+1);
      if(key===null)return unknown("Apex map initializer has an unproven key: "+
        pair[0].trim()+"; cause: "+
        (keyValue.kind==="unknown"?keyValue.reason:"Map key is not a single scalar."));
      if(val.kind==="unknown")
        return unknown("Apex map initializer for key "+key+" is unproven: "+val.reason);
      entries.push([key,val]);
      if(entries.length>MAX_MAP_ENTRIES)return unknown("Apex map entry limit exceeded.");
    }
    return {kind:"map",entries};
  }
  const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/s.exec(expr);
  if(call){
    const name=call[1];
    const pieces=call[2].trim()?splitApexTopLevel(call[2],","):[];
    const args=pieces.map(x=>evaluateApexExpression(x,context,depth+1));
    const lname=name.toLowerCase();
    if(lname.endsWith(".getfields")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-10),context,depth+1);
      if(receiver.kind==="fieldSet")
        return context.resolveCall?.("Schema.fieldSetFields",[
          textValue(receiver.objectApiName),textValue(receiver.developerName)]) ??
          unknown("Field Set members not proven from authoritative metadata.");
      if(receiver.kind==="unknown")return receiver;
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
        return unknown("JSON.deserialize input must be a single proven label value.");
      return parseKnownJsonMap(input.values[0]);
    }
    if(lname.endsWith(".keyset")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-7),context,depth+1);
      return receiver.kind==="map"?listValue(receiver.entries.map(([key])=>key),true):
        receiver.kind==="collection"?listValue(receiver.items,true):
        unknown("Map keySet() depends on unresolved metadata.");
    }
    if(lname.endsWith(".containskey")&&args.length===1){
      const receiver=evaluateApexExpression(name.slice(0,-12),context,depth+1);
      const key=onlyText(args[0]);
      if(key===null)return unknown("Map.containsKey depends on runtime key.");
      if(receiver.kind==="map")return textValue(String(receiver.entries.some(([k])=>k===key)));
      if(receiver.kind==="collection")return textValue(String(receiver.items.includes(key)));
      if(receiver.kind==="unknown")return receiver;
      return unknown("Map.containsKey receiver is not proven as a map.");
    }
    if(lname.endsWith(".get")&&args.length===1){
      const receiver=evaluateApexExpression(name.slice(0,-4),context,depth+1);
      // Preserve the actual missing metadata/helper dependency instead of
      // reporting a misleading "unsupported map.get" error.
      if(receiver.kind==="unknown")return receiver;
      if(receiver.kind==="map"){
        const key=onlyText(args[0]);
        if(key===null)return unknown("Map.get key depends on runtime input.");
        return receiver.entries.find(([item])=>item===key)?.[1] ??
          unknown("Map.get key "+key+" absent from proven configuration.");
      }
    }
    // Pure scalar conversions used by immutable static initializers and
    // dynamic SELECT fragments. Runtime/collection inputs remain unknown.
    if(lname==="string.valueof"&&args.length===1){
      if(args[0].kind==="text")return args[0];
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
      const s=onlyText(args[0]);
      return s!==null?textValue(String(s.length===0)):
        unknown("String.isEmpty input depends on runtime value.");
    }
    if((lname==="string.isblank"||lname==="string.isnotblank")&&args.length===1){
      const text=onlyText(args[0]);if(text===null)return unknown("String blankness depends on runtime input.");
      const blank=text.trim().length===0;
      return textValue(String(lname==="string.isblank"?blank:!blank));
    }
    if(lname==="string.escapesinglequotes"&&args.length===1){
      if(args[0].kind!=="text")return unknown("escapeSingleQuotes input unknown: "+
        (args[0].kind==="unknown"?args[0].reason:"input is not text."));
      return merged(args[0].values.map(x=>x.replace(/'/g,"\\'")));
    }
    const methods=["removeend","trim","tolowercase","touppercase","isempty","split","equalsignorecase","containsignorecase"];
    const dot=name.lastIndexOf(".");
    const operation=name.slice(dot+1).toLowerCase();
    if(dot>=0&&methods.includes(operation)){
      const receiver=evaluateApexExpression(name.slice(0,dot),context,depth+1);
      if(operation==="isempty"&&receiver.kind==="collection")return textValue(String(receiver.items.length===0));
      if(operation==="isempty"&&receiver.kind==="map")return textValue(String(receiver.entries.length===0));
      if(operation==="isempty"&&receiver.kind==="records")return textValue(String(receiver.items.length===0));
      if(receiver.kind!=="text")return unknown("Receiver for "+operation+" not resolved: "+
        (receiver.kind==="unknown"?receiver.reason:"receiver is not text."));
      const argument=args.length?onlyText(args[0]):null;
      if(operation==="trim")return merged(receiver.values.map(x=>x.trim()));
      if(operation==="tolowercase")return merged(receiver.values.map(x=>x.toLowerCase()));
      if(operation==="touppercase")return merged(receiver.values.map(x=>x.toUpperCase()));
      if(operation==="isempty")return merged(receiver.values.map(x=>String(x.length===0)));
      if(argument===null)return unknown("Argument for "+operation+" is not resolved.");
      if(operation==="removeend")return merged(receiver.values.map(x=>x.endsWith(argument)?x.slice(0,-argument.length):x));
      if(operation==="equalsignorecase")return merged(receiver.values.map(x=>String(x.toLowerCase()===argument.toLowerCase())));
      if(operation==="containsignorecase")return merged(receiver.values.map(x=>String(x.toLowerCase().includes(argument.toLowerCase()))));
      if(operation==="split"){
        const one=onlyText(receiver);
        return one!==null?listValue(one.split(argument)):unknown("Split has multiple possible inputs.");
      }
    }
    return context.resolveCall?.(name,args)??unknown("Unsupported or external Apex method: "+name);
  }
  return unknown("Unsupported Apex expression: "+expr.slice(0,100));
}
