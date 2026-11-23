import { splitApexTopLevel } from "./ApexSourceModel.js";

/** Portable abstract Apex values: no Salesforce API calls and no eval(). */
export type ApexValue =
  | { kind: "text"; values: string[] }
  | { kind: "collection"; items: string[]; unique: boolean }
  | { kind: "number"; value: number }
  | { kind: "unknown"; reason: string };

export type ApexEnvironment = Map<string, ApexValue>;
export const unknown = (reason: string): ApexValue => ({kind:"unknown",reason});
export const textValue = (value: string): ApexValue => ({kind:"text",values:[value]});
export const listValue = (items: string[], unique = false): ApexValue => ({
  kind:"collection", items:unique?[...new Set(items)]:items, unique,
});
export const MAX_ALTERNATIVES = 32;
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
  if(left.kind==="collection"||right.kind==="collection")
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
  const expr=unwrap(expression);
  if(!expr)return unknown("Empty expression.");
  const literal=unescapeApex(expr);
  if(literal!==null)return textValue(literal);
  if(/^-?\d+(?:\.\d+)?$/.test(expr))return {kind:"number",value:Number(expr)};
  if(/^(true|false)$/i.test(expr))return textValue(expr.toLowerCase());
  if(expr==="null")return textValue("null");
  if(/^[A-Za-z_]\w*$/.test(expr))return context.values.get(expr)??unknown("Apex symbol "+expr+" has no proven value.");
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
      const a=onlyText(evaluateApexExpression(parts[0],context,depth+1));
      const b=onlyText(evaluateApexExpression(parts[1],context,depth+1));
      return a!==null&&b!==null?textValue(String(operator==="=="?a===b:a!==b))
        :unknown("Runtime conditional comparison "+expr);
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
  // Schema Describe is a metadata dependency, not a method to execute.
  // A caller-supplied read-only snapshot must prove the complete field list.
  const describe=/^Schema\\.getGlobalDescribe\\(\\)\\.get\\(([^)]*)\\)\\.getDescribe\\(\\)\\.fields\\.getMap\\(\\)$/i.exec(expr);
  if(describe){
    const object=evaluateApexExpression(describe[1],context,depth+1);
    return context.resolveCall?.("Schema.describeFields",[object]) ??
      unknown("Schema Describe fields are unavailable for the target object.");
  }
  const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/s.exec(expr);
  if(call){
    const name=call[1];
    const pieces=call[2].trim()?splitApexTopLevel(call[2],","):[];
    const args=pieces.map(x=>evaluateApexExpression(x,context,depth+1));
    const lname=name.toLowerCase();
    if(lname.endsWith(".keyset")&&args.length===0){
      const receiver=evaluateApexExpression(name.slice(0,-7),context,depth+1);
      return receiver.kind==="collection"?listValue(receiver.items,true):
        unknown("Map keySet() depends on unresolved metadata.");
    }
    if(lname==="string.join"&&args.length===2){
      if(args[0].kind!=="collection")return unknown("String.join collection is not known.");
      const sep=onlyText(args[1]);
      return sep!==null?textValue(args[0].items.join(sep)):unknown("String.join delimiter is unknown.");
    }
    if((lname==="string.isblank"||lname==="string.isnotblank")&&args.length===1){
      const text=onlyText(args[0]);if(text===null)return unknown("String blankness depends on runtime input.");
      const blank=text.trim().length===0;
      return textValue(String(lname==="string.isblank"?blank:!blank));
    }
    if(lname==="string.escapesinglequotes"&&args.length===1){
      if(args[0].kind!=="text")return unknown("escapeSingleQuotes input unknown.");
      return merged(args[0].values.map(x=>x.replace(/'/g,"\\'")));
    }
    const methods=["removeend","trim","tolowercase","touppercase","isempty","split","equalsignorecase","containsignorecase"];
    const dot=name.lastIndexOf(".");
    const operation=name.slice(dot+1).toLowerCase();
    if(dot>=0&&methods.includes(operation)){
      const receiver=evaluateApexExpression(name.slice(0,dot),context,depth+1);
      if(operation==="isempty"&&receiver.kind==="collection")return textValue(String(receiver.items.length===0));
      if(receiver.kind!=="text")return unknown("Receiver for "+operation+" not resolved.");
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
