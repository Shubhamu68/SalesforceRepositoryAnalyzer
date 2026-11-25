import {maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,parseApexStatements,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {evaluateApexExpression,type ApexValue} from "./ApexValueEvaluator.js";
const clean=(s:string)=>stripApexComments(s).trim();
const literal=(s:string)=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))?evaluateApexExpression(clean(s),{values:new Map()}):undefined;
/** Return literal String alternatives from a private, same-owner helper.
 * All accepted arms must be source-proven returns; null is not a String
 * candidate. Consumers validate the meaning of returned strings. */
export function collectApexLiteralStringReturns(source:string,owner:IndexedApexMethod,expression:string,prefix:readonly SourceNode[],methods:readonly IndexedApexMethod[]):string[]{
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
        if(value?.kind!=="text"||value.values.length!==1)return {ok:false,stopped:false};
        result.add(value.values[0]);
        return {ok:true,stopped:true};
      }else return {ok:false,stopped:false};
    }
    return {ok:true,stopped:false};
  };
  const proof=walk(method.body);
  return proof.ok&&proof.stopped?[...result]:[];
}
