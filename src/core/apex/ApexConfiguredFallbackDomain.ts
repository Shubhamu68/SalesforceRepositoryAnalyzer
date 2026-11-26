import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType} from "./ApexTypeSystem.js";
import {maskApexSource,stripApexComments,matchingPair,type SourceNode,type IndexedApexMethod} from "./ApexSourceModel.js";
import {matchApexTokenContract,apexPrefixBefore} from "./ApexSourceContract.js";
import {configuredAggregateLoopPrefix} from "./ApexConfiguredAggregateDomain.js";
import type {ApexValue} from "./ApexValueEvaluator.js";

interface Context {source:string;methods:readonly IndexedApexMethod[];method:IndexedApexMethod;expression:string;offset:number}
const identifier=/^[A-Za-z_]\w*$/;
const clean=(s:string)=>stripApexComments(s).trim();
const platforms=["String","List","Set","Map","Schema","Pattern","Matcher","Database","AccessLevel","AggregateResult"];
const producer=configuredAggregateLoopPrefix+
 "Map<String,Object> $meta=new Map<String,Object>{'label'=>String.isNotBlank($label)?$label:($func+' of '+$fieldLabel),'type'=>($func=='COUNT')?'number':($desc!=null?$simplify($desc.getType()):'number')};"+
 "if($alias!=null){$meta.put('alias',$alias);}if(String.isNotBlank($fallback)){$meta.put('fallbackQuery',$fallback);}$metas.add($meta);$index++;}";
/** Complete source prefix of the selected lexical loop, including the sink
 * itself. Only a fresh map of bind values and generated names may reach it.
 * A runtime filter value cannot become query text. Alpha-renamed identifiers
 * and exact token contracts prevent guessing about an arbitrary regex or
 * collection transformation. */
const consumer="for(Map<String,Object> $entry:$metas){"+
 "$cardType $card=new $cardType();$card.label=(String)$entry.get('label');$card.type=(String)$entry.get('type');"+
 "String $alias=(String)$entry.get('alias');Object $value=null;if($alias!=null&&$aggregate!=null){$value=$aggregate.get($alias);}"+
 "String $template=(String)$entry.get('fallbackQuery');if($value==null&&String.isNotBlank($template)){"+
 "Map<String,Object> $binds=new Map<String,Object>();String $query=$template;Integer $counter=0;"+
 "Pattern $pattern=Pattern.compile('\\\\{([^}]+)\\\\}');Matcher $matcher=$pattern.matcher($template);Boolean $canRun=true;"+
 "Set<String> $placeholders=new Set<String>();while($matcher.find()){$placeholders.add($matcher.group(0));}"+
 "for(String $placeholder:$placeholders){String $key=$placeholder.substring(1,$placeholder.length()-1);"+
 "if($values.containsKey($key)){String $bind='fb'+$counter++;$query=$query.replace($placeholder,':'+$bind);$binds.put($bind,$values.get($key));}else{$canRun=false;break;}}"+
 "if($canRun&&!$binds.isEmpty()){try{List<AggregateResult> $results=Database.queryWithBinds($query,$binds,AccessLevel.$mode)";
/** Source-proven finite templates, not runtime values or executed queries.
 * The primary aggregate's Schema guard does NOT guard fallback storage.
 * Keep the producer's actual blank and function checks, including labels
 * that need not be valid Salesforce field paths. */
export function proveConfiguredFallbackDomain(c:Context,resolveAt:(expr:string,at:number)=>ApexValue):{templates:string[];complete:boolean}|undefined{
  if(!identifier.test(c.expression)||!c.method.isStatic||c.method.visibility!=="private")return undefined;
  const masked=maskApexSource(c.source),symbols=apexSymbols(c.source,c.methods);
  if(platforms.some(p=>new RegExp("\\bclass\\s+"+p+"\\b","i").test(masked)))return undefined;
  const loop=c.method.body.find(n=>n.kind==="for"&&n.start<c.offset&&c.offset<n.end);
  if(!loop||canonicalApexType(loop.loopVariableType)!=="map<string,object>"||!loop.loopVariable||!identifier.test(clean(loop.iterable??"")))return undefined;
  const collection=clean(loop.iterable!);
  // Do not permit shadowed platform names, including local variables that
  // are only visible in a nested producer/consumer scope.
  const points=[loop.start,c.offset];
  const collect=(nodes:readonly SourceNode[])=>{for(const n of nodes){points.push(n.start,n.end-1);collect(n.body??[]);collect(n.otherwise??[]);}};
  collect(c.method.body);
  // Type positions (e.g. Matcher matcher) do not resolve through a
  // same-named local. Static receivers do; reject those shadows.
  if(["String","Pattern","Database","AccessLevel"].some(p=>points.some(at=>symbols.hasLocalBinding(c.method,p,at)||!!symbols.lookup(c.method,p,at))))return undefined;
  const open=masked.indexOf("(",c.offset),close=open>=0?matchingPair(masked,open):-1;
  if(close<0||close>=loop.end)return undefined;
  const read=matchApexTokenContract(c.source.slice(loop.start,close+1),consumer,
    {$entry:loop.loopVariable,$metas:collection,$query:c.expression});
  if(!read||!["user_mode","system_mode"].includes(read.get("$mode")??"")||
     symbols.lookup(c.method,read.get("$values")!,loop.start)!=="map<string,string>")return undefined;
  const prior=apexPrefixBefore(c.method.body,loop.start);
  if(!prior||prior.some(n=>n.kind==="opaque")||symbols.lookup(c.method,collection,loop.start)!=="list<map<string,object>>")return undefined;
  const relevant=prior.filter(n=>new RegExp("\\b"+collection+"\\b","i").test(maskApexSource(c.source.slice(n.start,n.end))));
  if(relevant.length!==2||relevant[0].kind!=="statement"||relevant[1].kind!=="for")return undefined;
  if(!matchApexTokenContract(relevant[0].text??"","List<Map<String,Object>> $metas=new List<Map<String,Object>>();",{$metas:collection}))return undefined;
  const build=relevant[1];
  const write=matchApexTokenContract(c.source.slice(build.start,build.end),producer,{$metas:collection});
  if(!write)return undefined;
  const config=write.get("$config")!;
  if(symbols.lookup(c.method,config,build.start)!=="string")return undefined;
  const resolved=resolveAt(config,build.start);
  if(resolved.kind==="null")return {templates:[],complete:true};
  if(resolved.kind!=="text"||resolved.scalarType||resolved.values.length!==1)return {templates:[],complete:false};
  const raw=resolved.values[0];
  if(raw.length>16000||raw.split(",").length>100)return {templates:[],complete:false};
  const templates:string[]=[];
  for(const segment of raw.split(",")){
    const sep=segment.indexOf("##");
    if(sep<0)continue;
    const main=segment.slice(0,sep).trim(),template=segment.slice(sep+2).trim();
    const parts=main.split(":");
    if(!parts[0].trim()||!template)continue;
    const fn=parts.length>1?parts[1].trim().toUpperCase():"SUM";
    if(!["SUM","AVG","MIN","MAX","COUNT"].includes(fn))continue;
    templates.push(template);
  }
  return {templates:[...new Set(templates)],complete:true};
}
