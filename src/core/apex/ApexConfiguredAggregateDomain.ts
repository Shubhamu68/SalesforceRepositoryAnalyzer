import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType,type ApexCallResolver} from "./ApexTypeSystem.js";
import {maskApexSource,stripApexComments,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexContractTokens,matchApexTokenContract,apexPrefixBefore} from "./ApexSourceContract.js";
import {recognizeSchemaHelper,evaluateSchemaHelper} from "./ApexSchemaHelperModel.js";
import {textValue,type ApexValue} from "./ApexValueEvaluator.js";

interface Context {source:string;methods:readonly IndexedApexMethod[];method:IndexedApexMethod;offset:number}
export interface ApexConfiguredAggregateDomain {
  object:string;
  expressions: Array<{functionName:string;fieldPath:string}>;
  complete:boolean;
}
const clean=(s:string)=>stripApexComments(s).trim();
const identifier=/^[A-Za-z_]\w*$/;
const fieldPath=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const scalarText=(v:ApexValue)=>v.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export const configuredAggregateLoopPrefix="for(String $def:$config.split(',')){if(String.isBlank($def))continue;"+
    "String $main;String $fallback=null;if($def.contains('##')){$main=$def.substringBefore('##').trim();$fallback=$def.substringAfter('##').trim();}else{$main=$def.trim();}"+
    "List<String> $parts=$main.split(':');if($parts.isEmpty())continue;"+
    "String $field=$parts[0].trim();String $func=$parts.size()>1?$parts[1].trim().toUpperCase():'SUM';"+
    "String $label=$parts.size()>2?$parts[2].trim():null;if(String.isBlank($field)){continue;}"+
    "Set<String> $allowed=new Set<String>{'SUM','AVG','MIN','MAX','COUNT'};if(!$allowed.contains($func)){continue;}"+
    "Schema.DescribeFieldResult $desc=$describe($root,$field);String $fieldLabel=$desc!=null?$desc.getLabel():$field;String $alias=null;"+
    "if($desc!=null){$alias='agg'+$index;String $expr=($func=='COUNT')?'COUNT(Id)':($func+'('+$field+')');$target.add($expr+' '+$alias);}";
const uses=(c:Context,n:SourceNode,name:string)=>new RegExp("\\b"+name+"\\b","i").test(maskApexSource(c.source.slice(n.start,n.end)));
/** Bounded source contract for a delimited, Schema-guarded aggregate
 * builder. Only the permission-bearing append is projected; label maps
 * and fallback strings are not interpreted. No application names or
 * configured field values are assumed. Unknown shapes fail closed. */
export function proveConfiguredAggregateDomain(c:Context,target:string,resolve:(expr:string,at:number)=>ApexValue,resolveExternal?:ApexCallResolver):ApexConfiguredAggregateDomain|undefined{
  const symbols=apexSymbols(c.source,c.methods);
  if(!identifier.test(target)||symbols.lookup(c.method,target,c.offset)!=="list<string>"||
    /\bclass\s+(?:String|List|Set|Map|Schema)\b/i.test(maskApexSource(c.source))||
    ["String","List","Set","Map","Schema"].some(n=>symbols.hasLocalBinding(c.method,n,c.offset)))return undefined;
  const nodes=apexPrefixBefore(c.method.body,c.offset);if(!nodes)return undefined;
  const relevant=nodes.filter(n=>uses(c,n,target));
  // A fresh list, one completed append-only configuration loop, no escape.
  if(relevant.length!==2||relevant[0].kind!=="statement"||
    !new RegExp("^List\\s*<\\s*String\\s*>\\s+"+target+"\\s*=\\s*new\\s+List\\s*<\\s*String\\s*>\\s*\\(\\s*\\)\\s*;$","i").test(clean(relevant[0].text??"")))return undefined;
  const loop=relevant[1];
  if(loop.kind!=="for"||canonicalApexType(loop.loopVariableType)!=="string"||!loop.loopVariable)return undefined;
  const iterable=/^([A-Za-z_]\w*)\s*\.\s*split\s*\(\s*','\s*\)$/i.exec(clean(loop.iterable??""));
  if(!iterable||symbols.lookup(c.method,iterable[1],loop.start)!=="string")return undefined;
  const contents=clean(c.source.slice(loop.start,loop.end));
  const tokens=apexContractTokens(contents);
  if(!tokens)return undefined;
  // The complete prefix through the append proves the split, guards,
  // function whitelist, Schema check, COUNT(Id) semantics and alias shape.
  // The suffix is permitted only if it cannot read/escape the accumulator
  // or modify the configuration/root or bypass subsequent iterations.
  const template=configuredAggregateLoopPrefix;
  const expected=apexContractTokens(template);if(!expected||tokens.length<expected.length+1)return undefined;
  // Token joining must preserve token boundaries and quoted literals.
  const match=matchApexTokenContract(tokens.slice(0,expected.length).join(" "),template,
    {$def:loop.loopVariable,$config:iterable[1],$target:target});
  if(!match)return undefined;
  const root=match.get("$root")!,index=match.get("$index")!;
  // A local typed integer controls only the syntactic alias. Its source
  // initializer and increment are proven; never use it as a field name.
  const initial=nodes.filter(n=>n.end<=loop.start&&uses(c,n,index));
  if(initial.length!==1||initial[0].kind!=="statement"||
    !new RegExp("^Integer\\s+"+index+"\\s*=\\s*0\\s*;$","i").test(clean(initial[0].text??"")))return undefined;
  if(symbols.lookup(c.method,root,loop.start)!=="string")return undefined;
  const tail=tokens.slice(expected.length);
  if(tail.at(-1)!=="}")return undefined;
  const forbidden=new Set([target.toLowerCase(),iterable[1].toLowerCase(),root,"return","throw","break","continue","for","while","do","try","catch","switch"]);
  if(tail.some(v=>forbidden.has(v)))return undefined;
  const indexUses=tail.flatMap((v,i)=>v===index?[i]:[]);
  if(indexUses.length!==1||tail[indexUses[0]+1]!=="++"||tail[indexUses[0]+2]!==";")return undefined;
  // Require a unique same-owner private Schema traversal, not an
  // overload guessed from method names.
  const helpers=c.methods.filter(m=>symbols.sameOwner(c.method,m)&&same(m.name,match.get("$describe")!)&&m.parameters.length===2);
  if(helpers.length!==1)return undefined;
  const contract=recognizeSchemaHelper(c.source,helpers[0]);
  if(contract?.kind!=="fieldPath")return undefined;
  const object=scalarText(resolve(root,loop.start)),config=resolve(iterable[1],loop.start);
  if(!object||!identifier.test(object))return undefined;
  const raw=scalarText(config);
  if(raw===undefined||raw.length>16000||raw.split(",").length>100)return undefined;
  const expressions:ApexConfiguredAggregateDomain["expressions"]=[];
  let complete=true;
  for(const segment of raw.split(",")){
    if(!segment.trim())continue;
    const main=segment.split("##",1)[0].trim(),parts=main.split(":");
    const field=parts[0].trim(),func=parts.length>1?parts[1].trim().toUpperCase():"SUM";
    if(!field||!["SUM","AVG","MIN","MAX","COUNT"].includes(func))continue;
    if(!fieldPath.test(field)){complete=false;continue;}
    const result=evaluateSchemaHelper(contract,[textValue(object),textValue(field)],resolveExternal);
    if(result.kind==="null")continue;
    if(result.kind!=="schema"||result.schemaType!=="fieldDescribe"){complete=false;continue;}
    expressions.push({functionName:func,fieldPath:func==="COUNT"?"Id":field});
  }
  return {object,expressions,complete};
}
