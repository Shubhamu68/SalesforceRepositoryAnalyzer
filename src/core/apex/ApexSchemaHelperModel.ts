import {stripApexComments,maskApexSource,type IndexedApexMethod} from "./ApexSourceModel.js";
import {canonicalApexType,type ApexCallResolver} from "./ApexTypeSystem.js";
import {evaluateSchemaRead,isSchemaFieldMap} from "./ApexSchemaModel.js";
import {evaluateApexExpression,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";

/** Exact source contracts for common order-independent Describe traversal
 * idioms. These are optimizations of the source program, not method-name
 * conventions. Unsupported bodies retain ordinary interpreter behavior.
 * Match every token, including null guards, loop bounds, break and return.
 * Alpha-renamed locals/parameters are accepted; no partial body matches. */
type Contract={kind:"fieldPath"|"relationshipPath"|"nameField"}|
  {kind:"enumSwitch";values:ReadonlyMap<string,string>;fallback:string};
const identifier=/^[a-z_]\w*$/;
function tokens(source:string):string[]|undefined{
  const input=stripApexComments(source);
  const result:string[]=[];let end=0;
  for(const hit of input.matchAll(/'(?:\\.|[^'\\])*'|\$[A-Za-z_]\w*|[A-Za-z_]\w*|\d+|==|!=|\+\+|--|<=|>=|&&|\|\||[{}()[\].,:;=<>?+!*/-]/g)){
    if(input.slice(end,hit.index).trim())return undefined;
    const token=hit[0];result.push(token.startsWith("'")?token:token.toLowerCase());
    end=hit.index!+token.length;
  }
  return input.slice(end).trim()?undefined:result;
}
const fieldPathTemplate=tokens(
  "Schema.SObjectType $current=Schema.getGlobalDescribe().get($object);"+
  "if($current==null){return null;}"+
  "List<String> $parts=$path.split('\\\\.');"+
  "for(Integer $i=0;$i<$parts.size();$i++){"+
  "Map<String,Schema.SObjectField> $fields=$current.getDescribe().fields.getMap();"+
  "String $segment=$parts[$i];"+
  "if($i==$parts.size()-1){Schema.SObjectField $leaf=$fields.get($segment.toLowerCase());return $leaf==null?null:$leaf.getDescribe();}"+
  "Schema.SObjectType $next=null;"+
  "for(Schema.SObjectField $field:$fields.values()){Schema.DescribeFieldResult $desc=$field.getDescribe();"+
  "if($segment.equalsIgnoreCase($desc.getRelationshipName())){if(!$desc.getReferenceTo().isEmpty()){$next=$desc.getReferenceTo()[0];}break;}}"+
  "if($next==null){return null;}$current=$next;}return null;")!;
const relationshipPathTemplate=tokens(
  "Schema.SObjectType $current=Schema.getGlobalDescribe().get($object);"+
  "if($current==null){return null;}"+
  "List<String> $parts=$path.split('\\\\.');Schema.DescribeFieldResult $result;"+
  "for(Integer $i=0;$i<$parts.size();$i++){"+
  "Map<String,Schema.SObjectField> $fields=$current.getDescribe().fields.getMap();"+
  "String $segment=$parts[$i];Schema.DescribeFieldResult $match=null;"+
  "for(Schema.SObjectField $field:$fields.values()){Schema.DescribeFieldResult $desc=$field.getDescribe();"+
  "if($segment.equalsIgnoreCase($desc.getRelationshipName())){$match=$desc;break;}}"+
  "if($match==null){return null;}$result=$match;"+
  "if($i<$parts.size()-1){if($match.getReferenceTo().isEmpty()){return null;}$current=$match.getReferenceTo()[0];}}return $result;")!;
const nameTemplate=tokens(
  "for(Schema.SObjectField $field:$object.fields.getMap().values()){"+
  "Schema.DescribeFieldResult $desc=$field.getDescribe();if($desc.isNameField()){return $desc.getName();}}return null;")!;
const reserved=new Set(["schema","string","list","map","set","integer","boolean","null","true","false","for","if","return","break","new","switch","on","when","else"]);
interface TemplateScope {start:number;end:number}
/** The exact templates contain braced blocks and braced for loops. Include
 * the for header in its body's scope, so its declaration does not escape
 * the loop. Compute scopes from the trusted template, not the candidate;
 * every non-placeholder token must still match exactly. */
function templateScopes(expected:readonly string[]):TemplateScope[]|undefined{
  const root={start:0,end:expected.length};
  const scopes:TemplateScope[]=[root],blocks:TemplateScope[]=[],parens:number[]=[];
  const forHeaders=new Map<number,number>();
  for(let i=0;i<expected.length;i++){
    switch(expected[i]){
      case "(":parens.push(i);break;
      case ")":{
        const open=parens.pop();if(open===undefined)return undefined;
        if(expected[open-1]==="for"){
          if(expected[i+1]!=="{")return undefined;
          forHeaders.set(i+1,open+1);
        }
        break;
      }
      case "{":{
        const scope={start:forHeaders.get(i)??i+1,end:expected.length};
        scopes.push(scope);blocks.push(scope);break;
      }
      case "}":{
        const scope=blocks.pop();if(!scope)return undefined;
        scope.end=i;break;
      }
    }
  }
  return blocks.length||parens.length?undefined:scopes;
}
function matches(actual:readonly string[],expected:readonly string[],parameters:Map<string,string>):boolean{
  if(actual.length!==expected.length||new Set(parameters.values()).size!==parameters.size||
    [...parameters.values()].some(v=>!identifier.test(v)||reserved.has(v)))return false;
  const scopes=templateScopes(expected);if(!scopes)return false;
  // All template placeholders are parameters or have their first occurrence
  // at a declaration. Later occurrences must refer to that same binding.
  const bindings=new Map<string,{name:string;scope:TemplateScope}>();
  for(const [placeholder,name] of parameters)bindings.set(placeholder,{name,scope:scopes[0]});
  const contains=(scope:TemplateScope,i:number)=>scope.start<=i&&i<scope.end;
  const overlaps=(a:TemplateScope,b:TemplateScope)=>a.start<b.end&&b.start<a.end;
  for(let i=0;i<actual.length;i++){
    const want=expected[i],got=actual[i];
    if(!want.startsWith("$")){if(want!==got)return false;continue;}
    const prior=bindings.get(want);
    if(prior!==undefined){
      if(prior.name!==got||!contains(prior.scope,i))return false;
      continue;
    }
    if(!identifier.test(got)||reserved.has(got))return false;
    // Scopes are emitted in lexical nesting order. Use the innermost
    // enclosing scope and refuse any overlapping same-name declaration,
    // including parameter collisions and nested shadowing. Only disjoint
    // scopes may reuse a spelling (Apex identifiers are case-insensitive).
    const scope=[...scopes].reverse().find(s=>contains(s,i));if(!scope)return false;
    if([...bindings.values()].some(b=>b.name===got&&overlaps(b.scope,scope)))return false;
    bindings.set(want,{name:got,scope});
  }
  return true;
}
export function recognizeSchemaHelper(source:string,method:IndexedApexMethod):Contract|undefined{
  if(!method.isStatic||method.visibility!=="private"||/\bclass\s+(?:Schema|String|List|Map)\b/i.test(maskApexSource(source)))return undefined;
  const body=tokens(source.slice(method.start,method.end));if(!body)return undefined;
  const types=(method.parameterTypes??[]).map(canonicalApexType);
  const params=method.parameters.map(p=>p.toLowerCase());
  const result=canonicalApexType(method.returnType);
  if(result==="schema.describefieldresult"&&types.join(",")==="string,string"){
    const bindings=()=>new Map([["$object",params[0]],["$path",params[1]]]);
    if(matches(body,fieldPathTemplate,bindings()))return {kind:"fieldPath"};
    if(matches(body,relationshipPathTemplate,bindings()))return {kind:"relationshipPath"};
  }
  if(result==="string"&&types.join(",")==="schema.describesobjectresult"&&matches(body,nameTemplate,new Map([["$object",params[0]]])))
    return {kind:"nameField"};
  // A return-only enum switch is pure, independent of its application name
  // and labels. Refuse nonliteral branches and duplicate cases.
  if(result==="string"&&types.join(",")==="schema.displaytype"&&
    body[0]==="switch"&&body[1]==="on"&&body[2]===params[0]&&body[3]==="{"&&body.at(-1)==="}"){
    let i=4;const values=new Map<string,string>();let fallback:string|undefined;
    while(i<body.length-1){
      if(body[i++]!=="when"||fallback!==undefined)return undefined;
      const cases:string[]=[body[i++]];
      while(body[i]===","){i++;cases.push(body[i++]);}
      if(body[i++]!=="{"||body[i++]!=="return")return undefined;
      const literal=body[i++]??"";
      if(!/^'(?:\\.|[^'\\])*'$/.test(literal))return undefined;
      const value=evaluateApexExpression(literal,{values:new Map()});
      if(value.kind!=="text"||value.values.length!==1||body[i++]!==";"||body[i++]!=="}")return undefined;
      if(cases.length===1&&cases[0]==="else")fallback=value.values[0];
      else for(const item of cases){
        if(!identifier.test(item)||item==="else"||values.has(item.toUpperCase()))return undefined;
        values.set(item.toUpperCase(),value.values[0]);
      }
    }
    if(i===body.length-1&&fallback!==undefined)return {kind:"enumSwitch",values,fallback};
  }
  return undefined;
}
const nul:ApexValue={kind:"null"};
const one=(value:ApexValue|undefined)=>value?.kind==="text"&&!value.scalarType&&value.values.length===1?value.values[0]:undefined;
export function evaluateSchemaHelper(contract:Contract,args:readonly ApexValue[],resolve?:ApexCallResolver):ApexValue{
  if(contract.kind==="enumSwitch"){
    const v=args[0];return v?.kind==="schema"&&v.schemaType==="displayType"?
      textValue(contract.values.get(v.value)??contract.fallback):unknown("Enum switch input is not a proven DisplayType.");
  }
  const map=(object:string)=>resolve?.("Schema.fieldMap",[textValue(object)])??unknown("Authoritative Schema field map unavailable.");
  if(contract.kind==="nameField"){
    const object=args[0];if(object?.kind!=="schema"||object.schemaType!=="objectDescribe")return unknown("Name-field owner is not proven.");
    const fields=map(object.objectApiName);if(!isSchemaFieldMap(fields))return unknown("Complete name-field inventory unavailable.");
    const matches:ApexValue[]=[];
    for(const [,field] of fields.entries){
      if(field.kind!=="schema"||field.schemaType!=="fieldToken"||typeof field.field.nameField!=="boolean")return unknown("Name-field flags are incomplete.");
      if(field.field.nameField)matches.push(textValue(field.field.name));
    }
    return matches.length===1?matches[0]:matches.length===0?nul:unknown("Multiple name fields; Describe iteration order is not established.");
  }
  const root=one(args[0]),path=one(args[1]);
  if(!root||!path||!identifier.test(root.toLowerCase())||!path.split(".").every(p=>identifier.test(p.toLowerCase()))||path.split(".").length>10)
    return unknown("Schema traversal requires an exact bounded object and path.");
  let object=root;const segments=path.split(".");
  for(let i=0;i<segments.length;i++){
    const fields=map(object);if(!isSchemaFieldMap(fields))return unknown("Complete field map unavailable for "+object+".");
    const segment=segments[i].toLowerCase(),last=i===segments.length-1;
    if(last&&contract.kind==="fieldPath"){
      const token=fields.entries.find(([key])=>key===segment)?.[1];
      return token?evaluateSchemaRead(token,"getDescribe",[])??unknown("Field token unavailable."):nul;
    }
    // The source uses a first matching relationship from an unordered
    // map. Prove uniqueness, not a particular map order.
    const matches:ApexValue[]=[];
    for(const [,token] of fields.entries){
      if(token.kind!=="schema"||token.schemaType!=="fieldToken"||token.field.relationshipName===undefined)
        return unknown("Relationship names are incomplete for "+object+".");
      if(token.field.relationshipName?.toLowerCase()===segment)matches.push(token);
    }
    if(!matches.length)return nul;
    if(matches.length!==1)return unknown("Ambiguous relationship "+segment+".");
    const token=matches[0],desc=evaluateSchemaRead(token,"getDescribe",[]);
    if(!desc)return unknown("Relationship Describe unavailable.");
    if(last)return desc;
    const targets=evaluateSchemaRead(desc,"getReferenceTo",[]);
    if(targets?.kind!=="instanceList")return unknown("Relationship target is polymorphic or unproven.");
    if(!targets.items.length)return nul;
    const next=targets.items[0];if(targets.items.length!==1||next.kind!=="schema"||next.schemaType!=="objectToken")return unknown("Relationship target is not unique.");
    object=next.objectApiName;
  }
  return unknown("Incomplete Schema traversal.");
}
