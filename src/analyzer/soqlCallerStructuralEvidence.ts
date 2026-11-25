import {indexApexMethods,maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,parseApexStatements,type IndexedApexMethod,type SourceNode} from "../core/apex/ApexSourceModel.js";
import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import {addApexValues,evaluateApexExpression,textValue,runtimeParameter,type ApexValue} from "../core/apex/ApexValueEvaluator.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {provePartialSoql} from "./soqlPartialStructure.js";
import {simplePermissionShape} from "./soqlPermissionAggregation.js";

const clean=(s:string)=>stripApexComments(s).trim();
const literal=(s:string)=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))?evaluateApexExpression(clean(s),{values:new Map()}):undefined;
const word=(name:string)=>new RegExp("\\b"+name+"\\b","i");
const MAX_SEEDS=64;
const MAX_PARTS=64;

interface Template {owner:IndexedApexMethod;expression:string;prefix:SourceNode[]}
export function directTemplate(source:string,site:ApexCallSite,methods:IndexedApexMethod[]):Template|undefined{
  const owner=methods.filter(m=>m.start<=site.offset&&site.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!owner)return undefined;
  const target=owner.body.find(n=>n.kind==="statement"&&n.start<=site.offset&&site.offset<n.end);
  if(!target)return undefined;
  const prior=owner.body.filter(n=>n.end<=target.start);
  const argument=clean(site.argument);
  // Require a direct invocation statement, not an expression with additional
  // side effects or an argument evaluated after a mutating nested call.
  const raw=clean(target.text??"");
  const invocation=/^(?:return\s+(?:\([\w\s<>,.\[\]]+\)\s*)?|[\w\s<>,.\[\]]+\s+[A-Za-z_]\w*\s*=\s*)?Database\s*\.\s*(?:query|countQuery|getQueryLocator)\s*\(/i.exec(raw);
  if(!invocation)return undefined;
  const opening=invocation[0].length-1,close=matchingPair(maskApexSource(raw),opening);
  if(close<0||raw.slice(close+1).trim()!==";")return undefined;
  if(/^[A-Za-z_]\w*$/.test(argument)&&!owner.parameters.some(p=>p.toLowerCase()===argument.toLowerCase())){
    const def=new RegExp("^String\\s+"+argument+"\\s*=\\s*([\\s\\S]+);$","i");
    const matches=prior.flatMap((n,i)=>{
      const hit=n.kind==="statement"?def.exec(clean(n.text??"")):null;
      return hit?[{expression:hit[1],i}]:[];
    });
    if(matches.length!==1)return undefined;
    const match=matches[0];
    // No reassignments or aliasing of the query after its declaration.
    if(prior.slice(match.i+1).some(n=>word(argument).test(maskApexSource(source.slice(n.start,n.end)))))return undefined;
    return {owner,expression:match.expression,prefix:prior.filter((_,i)=>i!==match.i)};
  }
  return {owner,expression:argument,prefix:prior};
}

/** Only the fixed ISO GMT formatter of a source-typed Date is abstracted.
 * Its output cannot contain a field name or a security clause. */
function dateFormatterSlot(source:string,owner:IndexedApexMethod,expression:string,methods:IndexedApexMethod[]):ApexValue|undefined{
  const call=/^([A-Za-z_]\w*)\s*\(\s*\)$/.exec(clean(expression));
  if(!call)return undefined;
  const symbols=apexSymbols(source,methods);
  const matches=methods.filter(m=>m.name.toLowerCase()===call[1].toLowerCase()&&!m.parameters.length&&symbols.sameOwner(owner,m));
  if(matches.length!==1)return undefined;
  const helper=matches[0];
  if(helper.visibility!=="private"||helper.returnType?.toLowerCase()!=="string"||helper===owner||(!helper.isStatic&&owner.isStatic)||
    helper.body.length!==2||helper.body.some(n=>n.kind!=="statement"))return undefined;
  if(/\bclass\s+(?:DateTime|Time)\b/i.test(maskApexSource(source))||["DateTime","Time"].some(n=>symbols.lookup(helper,n,helper.start)))return undefined;
  const init=/^DateTime\s+([A-Za-z_]\w*)\s*=\s*DateTime\s*\.\s*newInstance\s*\(\s*([A-Za-z_]\w*)\s*,\s*Time\s*\.\s*newInstance\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)\s*\)\s*;$/i.exec(clean(helper.body[0].text??""));
  if(!init||symbols.lookup(helper,init[2],helper.body[0].start)?.toLowerCase()!=="date")return undefined;
  const ret=new RegExp("^return\\s+"+init[1]+"\\s*\\.\\s*formatGMT\\s*\\(\\s*('(?:\\\\.|[^'\\\\])*')\\s*\\)\\s*;$","i").exec(clean(helper.body[1].text??""));
  const format=ret?literal(ret[1]):undefined;
  if(format?.kind!=="text"||format.values.length!==1||format.values[0]!=="yyyy-MM-dd'T'HH:mm:ss'Z'")return undefined;
  return runtimeParameter(call[1],"datetime","Fixed ISO GMT date formatter; parser-only value slot.");
}

/** Consume already collected exact caller vectors without re-running Apex or
 * raising its eight-seed execution budget. Only straight-line templates made
 * of literals, unmodified incoming parameters and String.join(parameter)
 * are supported. No cross-product of unrelated argument alternatives. */
export function proveCallerPermissionShapes(source:string,site:ApexCallSite,seeds:readonly ApexValue[][],methods=indexApexMethods(source)):string[]{
  const template=directTemplate(source,site,methods);
  if(!template||!template.owner.parameters.length||seeds.length>MAX_SEEDS)return [];
  const {owner,expression,prefix}=template;
  const symbols=apexSymbols(source,methods);
  if(symbols.lookup(owner,"String",site.offset)||/\bclass\s+String\b/i.test(maskApexSource(source)))return [];
  const parameters=new Map(owner.parameters.map((p,i)=>[p.toLowerCase(),i]));
  const pieces=splitApexTopLevel(clean(expression),"+");
  if(!pieces.length||pieces.length>MAX_PARTS)return [];
  const used=new Set<number>();
  const terms=pieces.map(piece=>{
    const expr=clean(piece);
    const value=literal(expr);
    if(value)return {value};
    const slot=dateFormatterSlot(source,owner,expr,methods);
    if(slot)return {value:slot};
    const i=parameters.get(expr.toLowerCase());
    if(i!==undefined){used.add(i);return {parameter:i};}
    const join=/^String\s*\.\s*join\s*\(\s*([A-Za-z_]\w*)\s*,\s*('(?:\\.|[^'\\])*')\s*\)$/i.exec(expr);
    const j=join?parameters.get(join[1].toLowerCase()):undefined;
    const separator=join?literal(join[2]):undefined;
    if(j===undefined||separator?.kind!=="text"||separator.values.length!==1)return undefined;
    used.add(j);return {parameter:j,separator:separator.values[0]};
  });
  if(!used.size||terms.some(t=>!t))return [];
  // Only unchanged parameters may be substituted. Reject loops/opaque
  // control flow and any prefix reference to relevant inputs, including
  // calls that might mutate a collection or reassign the parameter.
  if(prefix.some(n=>n.kind!=="statement"||[...used].some(i=>word(owner.parameters[i]).test(maskApexSource(source.slice(n.start,n.end))))))return [];
  const result=new Set<string>();
  for(const seed of seeds){
    if(seed.length!==owner.parameters.length)continue;
    let value:ApexValue=textValue("");
    let valid=true;
    for(const term of terms){
      if(!term){valid=false;break;}
      if(term.value){value=addApexValues(value,term.value);continue;}
      if(term.parameter===undefined){valid=false;break;}
      const input=seed[term.parameter];
      if(term.separator!==undefined){
        if(input?.kind!=="collection"||input.items.length>2000){valid=false;break;}
        value=addApexValues(value,textValue(input.items.join(term.separator)));
      }else{
        if(!input||!["text","number","unknown"].includes(input.kind)||(input.kind==="text"&&input.values.length!==1)){valid=false;break;}
        value=addApexValues(value,input);
      }
    }
    if(!valid)continue;
    const texts=value.kind==="text"?value.values:[provePartialSoql(value)?.text];
    for(const text of texts)if(text&&simplePermissionShape(text,site.line))result.add(text.trim());
  }
  return [...result];
}

/** A small, source-only return inventory for same-owner private String helpers.
 * Only literal query/null returns, pure scalar guards and complete literal
 * switch cases. Never execute the helper or replace an arbitrary unknown return. */
export function proveLiteralHelperPermissionShapes(source:string,site:ApexCallSite,methods=indexApexMethods(source)):string[]{
  const template=directTemplate(source,site,methods);
  if(!template)return [];
  const {owner,expression,prefix}=template;
  const call=/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(clean(expression));
  if(!call||prefix.some(n=>n.kind!=="statement"))return [];
  const symbols=apexSymbols(source,methods);
  const args=call[2].trim()?splitApexTopLevel(call[2],","):[];
  const matches=methods.filter(m=>m.name.toLowerCase()===call[1].toLowerCase()&&m.parameters.length===args.length&&symbols.sameOwner(owner,m));
  if(matches.length!==1)return [];
  const method=matches[0];
  if(method.visibility!=="private"||method.returnType?.toLowerCase()!=="string"||method===owner||(!method.isStatic&&owner.isStatic))return [];
  // A call with a side effect in the argument or an unknown dispatch is
  // outside this proof. Scalar args select branches, not their literal text.
  if(args.some(arg=>!(/^[A-Za-z_]\w*$|^-?\d+$|^'(?:\\.|[^'\\])*'$/s.test(clean(arg)))))return [];
  const names=new Set(method.parameters.map(n=>n.toLowerCase()));
  const pureGuard=(s:string):boolean=>{
    const text=clean(s);
    if(/^(?:true|false)$/i.test(text))return true;
    const simple=/^!?\s*([A-Za-z_]\w*)$/i.exec(text);
    if(simple)return names.has(simple[1].toLowerCase());
    const compare=/^([A-Za-z_]\w*)\s*(?:==|!=|<=|>=|<|>)\s*(?:null|true|false|-?\d+|'(?:\\.|[^'\\])*')$/i.exec(text);
    return !!compare&&names.has(compare[1].toLowerCase());
  };
  let count=0;
  const result=new Set<string>();
  const walk=(nodes:readonly SourceNode[]):{ok:boolean;stopped:boolean}=>{
    for(const node of nodes){
      if(++count>128)return {ok:false,stopped:false};
      if(node.kind==="if"){
        const condition=clean(node.condition??"");
        if(!pureGuard(condition))return {ok:false,stopped:false};
        const yes=/^false$/i.test(condition)?{ok:true,stopped:false}:walk(node.body??[]);
        const no=/^true$/i.test(condition)?{ok:true,stopped:false}:walk(node.otherwise??[]);
        if(!yes.ok||!no.ok)return {ok:false,stopped:false};
        if(/^true$/i.test(condition)?yes.stopped:/^false$/i.test(condition)?no.stopped:yes.stopped&&no.stopped)return {ok:true,stopped:true};
      }else if(node.kind==="block"){
        const block=walk(node.body??[]);if(!block.ok||block.stopped)return block;
      }else if(node.kind==="opaque"){
        // Shared syntax index conservatively marks switch opaque. Consume
        // only a complete local scalar switch with literal case labels and
        // explicit returning arms; no fall-through or unknown case effects.
        const raw=source.slice(node.start,node.end),masked=maskApexSource(raw);
        const head=/^\s*switch\s+on\s+([A-Za-z_]\w*)\s*\{/i.exec(masked);
        if(!head||!names.has(head[1].toLowerCase()))return {ok:false,stopped:false};
        const open=head[0].length-1,end=matchingPair(masked,open,"{","}");
        if(end<0)return {ok:false,stopped:false};
        const type=symbols.lookup(method,head[1],node.start);
        if(!type||!/^(?:integer|long|string)$/i.test(type))return {ok:false,stopped:false};
        let cursor=open+1,seenElse=false,arms=0,allStopped=true;
        while(cursor<end){
          while(cursor<end&&/\s/.test(masked[cursor]))cursor++;
          if(cursor>=end)break;
          const when=/^when\b/i.exec(masked.slice(cursor));
          if(!when||seenElse||++arms>32)return {ok:false,stopped:false};
          const brace=masked.indexOf("{",cursor+when[0].length);
          if(brace<0||brace>=end)return {ok:false,stopped:false};
          const labels=clean(raw.slice(cursor+when[0].length,brace));
          const isElse=/^else$/i.test(labels);
          if(isElse)seenElse=true;
          else if(splitApexTopLevel(labels,",").some(label=>!(/^(?:-?\d+|null|'(?:\\.|[^'\\])*')$/i.test(clean(label)))))return {ok:false,stopped:false};
          const close=matchingPair(masked,brace,"{","}");
          if(close<0||close>=end)return {ok:false,stopped:false};
          const branch=walk(parseApexStatements(source,node.start+brace+1,node.start+close));
          if(!branch.ok||!branch.stopped)return {ok:false,stopped:false};
          allStopped=allStopped&&branch.stopped;
          cursor=close+1;
        }
        if(!arms||!allStopped)return {ok:false,stopped:false};
        const trailing=clean(raw.slice(end+1));
        if(seenElse)return trailing?{ok:false,stopped:false}:{ok:true,stopped:true};
        if(!trailing)return {ok:false,stopped:false};
        return walk(parseApexStatements(source,node.start+end+1,node.end));
      }else if(node.kind==="statement"){
        const ret=/^return\s+([\s\S]+);$/i.exec(clean(node.text??""));
        if(!ret)return {ok:false,stopped:false};
        if(/^null$/i.test(ret[1].trim()))return {ok:true,stopped:true};
        const value=literal(ret[1]);
        if(value?.kind!=="text"||value.values.length!==1||!simplePermissionShape(value.values[0],site.line))return {ok:false,stopped:false};
        result.add(value.values[0]);
        return {ok:true,stopped:true};
      }else return {ok:false,stopped:false};
    }
    return {ok:true,stopped:false};
  };
  const proof=walk(method.body);
  return proof.ok&&proof.stopped?[...result]:[];
}
