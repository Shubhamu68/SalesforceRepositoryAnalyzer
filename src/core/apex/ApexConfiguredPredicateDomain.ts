import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType,type ApexCallResolver} from "./ApexTypeSystem.js";
import {maskApexSource,stripApexComments,matchingPair,splitApexTopLevel,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {recognizeSchemaHelper,evaluateSchemaHelper} from "./ApexSchemaHelperModel.js";
import {textValue,type ApexValue} from "./ApexValueEvaluator.js";

/** Source-proven finite predicate domain; never evaluates runtime JSON or
 * transfers a fabricated DTO or collection into the Apex value engine. */
export interface ApexConfiguredPredicateDomain {
  object:string;
  fields:string[];
  rawPredicates:string[];
  complete:boolean;
}
interface Context {source:string;methods:readonly IndexedApexMethod[];method:IndexedApexMethod;offset:number}
const identifier=/^[a-z_]\w*$/;
const fieldPath=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const clean=(s:string)=>stripApexComments(s).trim();
const reserved=new Set(["string","schema","json","list","set","map","integer","boolean","object","null","true","false","return","continue","for","if","new","this","super"]);
function tokens(source:string):string[]|undefined{
  const input=stripApexComments(source),result:string[]=[];let end=0;
  for(const hit of input.matchAll(/'(?:\\.|[^'\\])*'|\$[A-Za-z_]\w*|[A-Za-z_]\w*|\d+|==|!=|\+\+|--|<=|>=|&&|\|\||[{}()[\].,:;=<>?+!*/-]/g)){
    if(input.slice(end,hit.index).trim())return undefined;
    result.push(hit[0].startsWith("'")?hit[0]:hit[0].toLowerCase());
    end=hit.index!+hit[0].length;
  }
  return input.slice(end).trim()?undefined:result;
}
/** Whole-body token contracts, alpha-renamed and fail-closed. Refuse
 * collisions rather than attempting arbitrary lexical substitution. */
function match(source:string,template:string,initial:Record<string,string>={}):Map<string,string>|undefined{
  const actual=tokens(source),expected=tokens(template);
  if(!actual||!expected||actual.length!==expected.length)return undefined;
  const bindings=new Map(Object.entries(initial).map(([k,v])=>[k,v.toLowerCase()]));
  if(new Set(bindings.values()).size!==bindings.size||[...bindings.values()].some(v=>!identifier.test(v)||reserved.has(v)))return undefined;
  for(let i=0;i<expected.length;i++){
    const want=expected[i],got=actual[i];
    if(!want.startsWith("$")){if(want!==got)return undefined;continue;}
    const prior=bindings.get(want);
    if(prior!==undefined){if(prior!==got)return undefined;continue;}
    if(want==="$number"){if(!/^(?:0|[1-9]\d{0,3})$/.test(got))return undefined;}
    else if(!identifier.test(got)||reserved.has(got))return undefined;
    if([...bindings.values()].includes(got))return undefined;
    bindings.set(want,got);
  }
  return bindings;
}
const body=(c:Context,m:IndexedApexMethod)=>c.source.slice(m.start,m.end);
function helper(c:Context,name:string,types:readonly string[],result:string):IndexedApexMethod|undefined{
  const symbols=apexSymbols(c.source,c.methods);
  const candidates=c.methods.filter(m=>symbols.sameOwner(c.method,m)&&m.name.toLowerCase()===name.toLowerCase()&&m.parameters.length===types.length);
  if(candidates.length!==1)return undefined;
  const m=candidates[0];
  return m.isStatic&&m.visibility==="private"&&canonicalApexType(m.returnType)===result&&
    m.parameterTypes?.length===types.length&&m.parameterTypes.every((t,i)=>canonicalApexType(t)===types[i])?m:undefined;
}
function dtoFields(c:Context,type:string):string[]|undefined{
  if(!identifier.test(type))return undefined;
  const masked=maskApexSource(c.source),declarations=[...masked.matchAll(new RegExp("\\bclass\\s+"+type+"\\s*\\{","gi"))];
  if(declarations.length!==1)return undefined;
  const start=declarations[0].index!+declarations[0][0].length-1,end=matchingPair(masked,start,"{","}");
  const actual=end<0?undefined:tokens(c.source.slice(start+1,end));
  return actual?.at(-1)===";"?actual.join("").split(";").filter(Boolean):undefined;
}
function before(nodes:readonly SourceNode[],at:number):SourceNode[]|undefined{
  const result:SourceNode[]=[];
  for(const n of nodes){
    if(n.end<=at){result.push(n);continue;}
    if(n.start>=at)return result;
    if(n.kind==="statement")return result;
    if(n.kind!=="block"&&n.kind!=="if")return undefined;
    for(const branch of [n.body??[],n.otherwise??[]]){
      if(branch.some(x=>x.start<=at&&at<x.end)){
        const inner=before(branch,at);return inner?[...result,...inner]:undefined;
      }
    }
    return undefined;
  }
  return result;
}
const uses=(c:Context,n:SourceNode,name:string)=>new RegExp("\\b"+name+"\\b","i").test(maskApexSource(c.source.slice(n.start,n.end)));
const same=(a:string,b:string)=>a.trim().toLowerCase()===b.trim().toLowerCase();
function call(n:SourceNode):{name:string;args:string[]}|undefined{
  if(n.kind!=="statement")return undefined;
  const m=/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*;$/.exec(clean(n.text??""));
  return m?{name:m[1],args:m[2].trim()?splitApexTopLevel(m[2],","):[]}:undefined;
}
function text(v:ApexValue):string|undefined{return v.kind==="null"?"":v.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;}
function fresh(n:SourceNode,name:string,kind:"list"|"set"):boolean{
  return n.kind==="statement"&&new RegExp("^"+kind+"\\s*<\\s*String\\s*>\\s+"+name+"\\s*=\\s*new\\s+"+kind+"\\s*<\\s*String\\s*>\\s*\\(\\s*\\)\\s*;$","i").test(clean(n.text??""));
}
/** Project the requested String property, not auxiliary lookup columns. */
function configuredFields(c:Context,nodes:readonly SourceNode[],name:string,resolve:(expr:string,at:number)=>ApexValue):string[]|undefined{
  const relevant=nodes.filter(n=>uses(c,n,name));
  if(relevant.length!==2||!fresh(relevant[0],name,"set"))return undefined;
  const loop=relevant[1];
  if(loop.kind!=="for"||!loop.loopVariable||!loop.loopVariableType||loop.body?.length!==1)return undefined;
  const add=new RegExp("^"+name+"\\s*\\.\\s*add\\s*\\(\\s*"+loop.loopVariable+"\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\)\\s*;$","i").exec(clean(loop.body[0].text??""));
  const invocation=/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(clean(loop.iterable??"")),dto=canonicalApexType(loop.loopVariableType);
  if(!add||!invocation||!dto||!identifier.test(dto)||splitApexTopLevel(invocation[2],",").length!==1)return undefined;
  const parser=helper(c,invocation[1],["string"],"list<"+dto+">");
  if(!parser)return undefined;
  const m=match(body(c,parser),
    "List<$dto> $out=new List<$dto>();if(String.isBlank($raw)){return $out;}"+
    "for(String $segment:$raw.split(';')){String $trim=$segment.trim();if(String.isBlank($trim)||$out.size()>=$number){continue;}"+
    "$dto $item=new $dto();$item.$extras=new List<String>();$item.$flag=false;"+
    "if($trim.startsWith('*')){$item.$flag=true;$trim=$trim.substring(1).trim();}"+
    "if($trim.contains(':')){$item.$member=$trim.substringBefore(':').trim();"+
    "for(String $part:$trim.substringAfter(':').split(',')){if(String.isNotBlank($part.trim())){$item.$extras.add($part.trim());}}}"+
    "else{$item.$member=$trim;}if(String.isNotBlank($item.$member)){$out.add($item);}}return $out;",
    {$dto:dto,$raw:parser.parameters[0],$member:add[1]});
  const actual=dtoFields(c,dto);
  if(!m||!actual||JSON.stringify(actual.sort())!==JSON.stringify(["publicstring"+add[1].toLowerCase(),"publiclist<string>"+m.get("$extras"),"publicboolean"+m.get("$flag")].sort()))return undefined;
  const raw=text(resolve(invocation[2],loop.start));
  if(raw===undefined||raw.length>16000||raw.split(";").length>100)return undefined;
  const fields:string[]=[];
  for(let segment of raw.split(";")){
    segment=segment.trim();
    if(!segment||fields.length>=Number(m.get("$number")))continue;
    if(segment.startsWith("*"))segment=segment.slice(1).trim();
    const f=segment.split(":",1)[0].trim();
    if(f)fields.push(f);
  }
  return fields;
}
/** The accumulator and field parameter must occur only in bound
 * predicate additions. Bind names are constructed from fixed identifier
 * literals and the typed integer index, never runtime structural strings. */
function boundWriter(c:Context,name:string,input:string):boolean{
  const m=helper(c,name,["string","string","schema.describefieldresult",input,"integer","list<string>","map<string,object>"],"void");
  if(!m)return false;
  const parts=tokens(body(c,m));if(!parts)return false;
  const field=m.parameters[0].toLowerCase(),target=m.parameters[5].toLowerCase(),idx=m.parameters[4].toLowerCase();
  const bindNames=new Set<string>();let adds=0;
  for(let i=0;i<parts.length;i++){
    if(parts[i]===field)return false;
    if(parts[i]!==target)continue;
    const p=parts.slice(i,i+11);
    if(p[1]!=="."||p[2]!=="add"||p[3]!=="("||p[4]!==field||p[5]!=="+"||
      !/^' (?:=|!=|>=|<=|>|<|LIKE) :'$/i.test(p[6]??"")||p[7]!=="+"||
      !identifier.test(p[8]??"")||p[9]!==")"||p[10]!==";")return false;
    bindNames.add(p[8]);adds++;i+=10;
  }
  const visible=maskApexSource(body(c,m));
  const bindUses=[...visible.matchAll(new RegExp("\\b"+target+"\\s*\\.\\s*add\\s*\\(\\s*"+field+"\\s*\\+[\\s\\S]*?\\+\\s*([A-Za-z_]\\w*)\\s*\\)\\s*;","gi"))];
  if(bindUses.length!==adds||bindUses.some(hit=>!apexSymbols(c.source,c.methods).hasLocalBinding(m,hit[1],m.start+hit.index!)||
    apexSymbols(c.source,c.methods).lookup(m,hit[1],m.start+hit.index!)!=="string"))return false;
  for(const bind of bindNames){
    if(m.parameters.some(p=>same(p,bind)))return false;
    let declarations=0;
    for(let i=0;i<parts.length;i++){
      if(parts[i]!==bind)continue;
      if(parts[i-1]==="string"&&parts[i+1]==="="){
        const end=parts.indexOf(";",i+2),expr=parts.slice(i+2,end);
        if(end<0||!(expr.length===3||expr.length===5)||!/^'[A-Za-z_]\w*'$/.test(expr[0])||expr[1]!=="+"||expr[2]!==idx||
          expr.length===5&&(expr[3]!=="+"||!/^'[A-Za-z_]\w*'$/.test(expr[4])))return false;
        declarations++;
      }else if(parts[i-1]==="."||["=","++","--"].includes(parts[i+1])||["++","--"].includes(parts[i-1])||
        ["+","-","*","/"].includes(parts[i+1])&&parts[i+2]==="=")return false;
    }
    if(!declarations)return false;
  }
  return adds>0;
}
function rawClassifier(c:Context,name:string):boolean{
  const m=helper(c,name,["string"],"boolean");
  return !!m&&!!match(body(c,m),
    "String $upper=' '+$seg.toUpperCase()+' ';return $seg.contains('(')||$seg.contains('<')||$seg.contains('>')||$seg.contains('!=')||"+
    "$upper.contains(' IN ')||$upper.contains(' LIKE ')||$upper.contains(' NOT ')||$upper.contains(' AND ')||$upper.contains(' OR ');",
    {$seg:m.parameters[0]});
}
function isRaw(segment:string):boolean{
  return /\(|<|>|!=/.test(segment)||/ (?:IN|LIKE|NOT|AND|OR) /.test(" "+segment.toUpperCase()+" ");
}
function validField(c:Context,describe:string,object:string,field:string,resolveExternal?:ApexCallResolver):boolean|undefined{
  if(!fieldPath.test(field))return undefined;
  const m=helper(c,describe,["string","string"],"schema.describefieldresult"),contract=m&&recognizeSchemaHelper(c.source,m);
  if(!contract||contract.kind!=="fieldPath")return undefined;
  const value=evaluateSchemaHelper(contract,[textValue(object),textValue(field)],resolveExternal);
  return value.kind==="null"?false:value.kind==="schema"&&value.schemaType==="fieldDescribe"?true:undefined;
}
export function proveConfiguredPredicateDomain(c:Context,target:string,resolve:(expr:string,at:number)=>ApexValue,resolveExternal?:ApexCallResolver):ApexConfiguredPredicateDomain|undefined{
  const symbols=apexSymbols(c.source,c.methods);
  if(!identifier.test(target.toLowerCase())||symbols.lookup(c.method,target,c.offset)!=="list<string>"||
    /\bclass\s+(?:String|List|Set|Map|Schema|JSON)\b/i.test(maskApexSource(c.source)))return undefined;
  const nodes=before(c.method.body,c.offset);if(!nodes)return undefined;
  const relevant=nodes.filter(n=>uses(c,n,target));
  if(relevant.length<2||relevant.length>5||!fresh(relevant[0],target,"list"))return undefined;
  const fields=new Set<string>(),rawPredicates=new Set<string>();
  let complete=true,root:string|undefined;
  for(const node of relevant.slice(1)){
    const invocation=call(node);
    if(!invocation||invocation.args.length!==5||!same(invocation.args[3],target)||
      invocation.args.some((a,i)=>i!==3&&new RegExp("\\b"+target+"\\b","i").test(maskApexSource(a))))return undefined;
    const obj=text(resolve(invocation.args[0],node.start));
    if(!obj||!identifier.test(obj.toLowerCase())||root!==undefined&&!same(obj,root))return undefined;
    root=obj;
    const at=node.start,signature=symbols.argumentTypes(c.method,invocation.args,at);
    const user=helper(c,invocation.name,["string","set<string>","string","list<string>","map<string,object>"],"void");
    const defaults=helper(c,invocation.name,["string","string","set<string>","list<string>","map<string,object>"],"void");
    if(user&&signature.every((t,i)=>canonicalApexType(t)===canonicalApexType(user.parameterTypes?.[i]))){
      const p=user.parameters;
      const m=match(body(c,user),
        "if(String.isBlank($json)){return;}List<$input> $inputs=(List<$input>)JSON.deserialize($json,List<$input>.class);"+
        "if($inputs==null||$inputs.isEmpty()){return;}Integer $index=0;for($input $item:$inputs){"+
        "if($item==null||String.isBlank($item.$id)||!$allowed.contains($item.$id)){continue;}"+
        "Schema.DescribeFieldResult $desc=$describe($object,$item.$id);if($desc==null){continue;}"+
        "$write($item.$id,$type($desc),$desc,$item,$index,$clauses,$binds);$index++;}",
        {$object:p[0],$allowed:p[1],$json:p[2],$clauses:p[3],$binds:p[4]});
      if(!m||!boundWriter(c,m.get("$write")!,m.get("$input")!))return undefined;
      const dto=dtoFields(c,m.get("$input")!);
      if(!dto||dto.some(f=>!/^publicstring[a-z_]\w*$/.test(f))||!dto.includes("publicstring"+m.get("$id")))return undefined;
      const allowed=clean(invocation.args[1]);
      const candidates=identifier.test(allowed.toLowerCase())?configuredFields(c,nodes.filter(n=>n.end<=at),allowed,resolve):undefined;
      if(!candidates)return undefined;
      for(const f of candidates){
        const valid=validField(c,m.get("$describe")!,obj,f,resolveExternal);
        if(valid)fields.add(f);else if(valid===undefined)complete=false;
      }
    }else if(defaults&&signature.every((t,i)=>{
      if(canonicalApexType(t)===canonicalApexType(defaults.parameterTypes?.[i]))return true;
      // The lexical symbol table does not model Custom Metadata member
      // types. Admit only a direct member of a source-typed metadata record;
      // its selected-row value must subsequently be exact String/null.
      const member=i===1&&!t?/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(clean(invocation.args[i])):null;
      return !!member&&!!symbols.lookup(c.method,member[1],at)?.endsWith("__mdt");
    })){
      const p=defaults.parameters;
      const m=match(body(c,defaults),
        "if(String.isBlank($config)){return;}Integer $index=$number;for(String $segment:$config.split(';')){String $seg=$segment.trim();"+
        "if(String.isBlank($seg)){continue;}if($raw($seg)){$clauses.add('('+$seg+')');continue;}if(!$seg.contains('=')){continue;}"+
        "String $field=$seg.substringBefore('=').trim();if($overrides.contains($field)){continue;}"+
        "Schema.DescribeFieldResult $desc=$describe($object,$field);if($desc==null){continue;}"+
        "$input $item=new $input();$item.$value=$default($seg.substringAfter('=').trim());"+
        "$write($field,$type($desc),$desc,$item,$index,$clauses,$binds);$index++;}",
        {$object:p[0],$config:p[1],$overrides:p[2],$clauses:p[3],$binds:p[4]});
      if(!m||!boundWriter(c,m.get("$write")!,m.get("$input")!)||!rawClassifier(c,m.get("$raw")!))return undefined;
      const dto=dtoFields(c,m.get("$input")!);
      if(!dto||dto.some(f=>!/^publicstring[a-z_]\w*$/.test(f))||!dto.includes("publicstring"+m.get("$value")))return undefined;
      const config=text(resolve(invocation.args[1],at));
      if(config===undefined||config.length>16000||config.split(";").length>100){complete=false;continue;}
      for(let seg of config.split(";")){
        seg=seg.trim();if(!seg)continue;
        if(isRaw(seg)){rawPredicates.add(seg);continue;}
        if(!seg.includes("="))continue;
        const f=seg.split("=",1)[0].trim(),valid=validField(c,m.get("$describe")!,obj,f,resolveExternal);
        if(valid)fields.add(f);else if(valid===undefined)complete=false;
      }
    }else return undefined;
  }
  return root?{object:root,fields:[...fields],rawPredicates:[...rawPredicates],complete}:undefined;
}
