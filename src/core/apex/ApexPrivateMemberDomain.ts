import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType} from "./ApexTypeSystem.js";
import {maskApexSource,stripApexComments,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexPrefixBefore} from "./ApexSourceContract.js";
import {findApexTernary} from "./ApexConditionalInvocation.js";
import {evaluateApexExpression,type ApexValue} from "./ApexValueEvaluator.js";

interface Context {source:string;methods:readonly IndexedApexMethod[];method:IndexedApexMethod;offset:number}
type Write={method:IndexedApexMethod;node:SourceNode;parents:SourceNode[];operator:string;rhs:string};
type Member={type:string;isStatic:boolean;initializer?:string;writes:Write[]};
const clean=(s:string)=>stripApexComments(s).trim();
const ident=/^[A-Za-z_]\w*$/;
const literal=/^'(?:\\.|[^'\\])*'$/s;
const text=(expr:string):string|undefined=>{
  if(!literal.test(expr))return undefined;
  const v=evaluateApexExpression(expr,{values:new Map()});
  return v.kind==="text"&&v.values.length===1&&!v.scalarType?v.values[0]:undefined;
};
const one=(v:ApexValue)=>v.kind==="text"&&!v.scalarType&&v.values.length===1?v.values[0]:undefined;
const word=(name:string)=>new RegExp("\\b"+name+"\\b","i");
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function containing(nodes:readonly SourceNode[],offset:number,parents:SourceNode[]=[]):{node:SourceNode;parents:SourceNode[]}|undefined{
  for(const n of nodes){
    if(n.start<=offset&&offset<n.end){
      if(n.kind==="statement")return {node:n,parents};
      return containing(n.body??[],offset,[...parents,n])??containing(n.otherwise??[],offset,[...parents,n]);
    }
  }
  return undefined;
}
/** A bounded, private source-member write inventory, not an instance or
 * transaction snapshot. Every occurrence must have a supported lexical
 * role. No public fields, TestVisible escape, hidden initializer blocks,
 * arbitrary collection alias, qualified access or shadowed declarations. */
function member(c:Context,name:string):Member|undefined{
  if(!ident.test(name))return undefined;
  const symbols=apexSymbols(c.source,c.methods),owner=symbols.ownerAt(c.method.start),masked=maskApexSource(c.source);
  if(!owner||symbols.hasLocalBinding(c.method,name,c.offset)||/\bclass\s+(?:String|Schema|List|Set)\b/i.test(masked))return undefined;
  const declaration=new RegExp("\\bprivate\\s+(?:(static)\\s+)?(String|List\\s*<\\s*String\\s*>)\\s+("+name+")\\s*(=|;)","gi");
  const candidates=[...masked.matchAll(declaration)].filter(m=>symbols.ownerAt(m.index!)===owner&&!c.methods.some(x=>x.start<=m.index!&&m.index!<x.end));
  if(candidates.length!==1)return undefined;
  const d=candidates[0],start=d.index!,type=canonicalApexType(d[2])!,isStatic=!!d[1];
  if(/@TestVisible\s*$/i.test(masked.slice(Math.max(0,start-256),start)))return undefined;
  const end=d[4]==="="?masked.indexOf(";",start+d[0].length):start+d[0].length-1;
  if(end<start)return undefined;
  const initializer=d[4]==="="?clean(c.source.slice(start+d[0].length,end)):undefined;
  if(initializer!==undefined&&!literal.test(initializer)&&initializer.toLowerCase()!=="null")return undefined;
  const writes:Write[]=[];
  for(const hit of masked.matchAll(new RegExp("\\b"+name+"\\b","gi"))){
    const at=hit.index!;
    if(start<=at&&at<=end)continue;
    const method=c.methods.filter(m=>m.start<=at&&at<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    if(!method||!symbols.sameOwner(c.method,method)||symbols.hasLocalBinding(method,name,at))return undefined;
    const found=containing(method.body,at);
    if(!found)return undefined;
    const statement=clean(found.node.text??"");
    const assignment=new RegExp("^"+name+"\\s*(\\+=|=(?!=|>))\\s*([\\s\\S]+);$","i").exec(statement);
    if(assignment){
      if(word(name).test(maskApexSource(assignment[2]))||writes.some(w=>w.node===found.node))return undefined;
      writes.push({method,node:found.node,parents:found.parents,operator:assignment[1],rhs:assignment[2].trim()});
      continue;
    }
    const before=masked.slice(found.node.start,at),after=masked.slice(at+hit[0].length,found.node.end);
    if(/\.\s*$/.test(before)||/^\s*(?:=(?!=|>)|[+\-*/%&|^]=|\+\+|--|\[|\.)/.test(after)||/(?:\+\+|--)\s*$/.test(before))return undefined;
    if(type==="list<string>"&&(!/\bString\s*\.\s*join\s*\(\s*$/i.test(before)||!/^\s*,/.test(after)||
      symbols.hasLocalBinding(method,"String",at)||symbols.lookup(method,"String",at)))return undefined;
  }
  return writes.length>0&&writes.length<=8?{type,isStatic,initializer,writes}:undefined;
}

/** Candidate domain for a private instance field with one direct write.
 * Read the actual assignment in its lexical method; do not run an entire
 * batch constructor or assume success of unrelated initialization effects.
 * The empty/null initial state is retained separately. */
export function provePrivateAssignedMemberDomain(c:Context,name:string,resolve:(method:IndexedApexMethod,expr:string,at:number)=>ApexValue):ApexValue[]|undefined{
  if(c.method.isStatic)return undefined;
  const proof=member(c,name);
  if(!proof||proof.isStatic||proof.writes.length!==1)return undefined;
  const write=proof.writes[0];
  if(write.operator!=="="||write.method.isStatic||write.method.visibility!=="private"||write.parents.some(p=>p.kind==="for"||p.kind==="opaque"))return undefined;
  const result:ApexValue[]=[];
  if(proof.initializer!==undefined)result.push(evaluateApexExpression(proof.initializer,{values:new Map()}));
  else result.push({kind:"null"});
  const ternary=findApexTernary(maskApexSource(write.rhs));
  if(ternary){
    // Apex commonly wraps the simple null comparison in parentheses.
    const condition=clean(write.rhs.slice(0,ternary.question)).replace(/^\(\s*([A-Za-z_]\w*\s*(?:!=|==)\s*null)\s*\)$/i,"$1");
    if(proof.type!=="string"||!/^[A-Za-z_]\w*\s*(?:!=|==)\s*null$/i.test(condition))return undefined;
    const yes=clean(write.rhs.slice(ternary.question+1,ternary.colon)),no=clean(write.rhs.slice(ternary.colon+1));
    if(!literal.test(yes)||!literal.test(no))return undefined;
    result.push(evaluateApexExpression(yes,{values:new Map()}),evaluateApexExpression(no,{values:new Map()}));
  }else{
    const value=resolve(write.method,write.rhs,write.node.start);
    if(proof.type==="list<string>"&&value.kind!=="collection"&&value.kind!=="unknown"||proof.type==="string"&&one(value)===undefined&&value.kind!=="unknown")return undefined;
    result.push(value);
  }
  return [...new Map(result.map(v=>[JSON.stringify(v),v])).values()];
}
export const fieldSetMemberTailType="apex-fieldset-member-additions:";
/** Bounded append-only static String projection. A prior invocation can
 * have appended other fields, so return known pieces plus an explicit
 * unknown tail, never a complete mutable member value. The current
 * invocation's field-set identity is kept separate from other entry points. */
export function proveFieldSetStringMemberProjection(c:Context,name:string,resolve:(expr:string,at:number)=>ApexValue):ApexValue|undefined{
  if(!c.method.isStatic)return undefined;
  const proof=member(c,name),symbols=apexSymbols(c.source,c.methods);
  if(!proof?.isStatic||proof.type!=="string"||proof.initializer===undefined||proof.writes.some(w=>w.operator!=="+="))return undefined;
  const seed=text(proof.initializer);
  if(seed===undefined)return undefined;
  const dynamic=proof.writes.filter(w=>text(w.rhs)===undefined);
  if(dynamic.length!==1)return undefined;
  const write=dynamic[0],helper=write.method,loop=write.parents[0];
  if(!helper.isStatic||helper.visibility!=="private"||helper.parameters.length!==1||
    canonicalApexType(helper.parameterTypes?.[0])!=="list<schema.fieldsetmember>"||
    write.parents.length!==1||loop?.kind!=="for"||canonicalApexType(loop.loopVariableType)!=="schema.fieldsetmember"||
    !loop.loopVariable||!same(clean(loop.iterable??""),helper.parameters[0]))return undefined;
  const append=/^('(?:\\.|[^'\\])*')\s*\+\s*([A-Za-z_]\w*)$/.exec(write.rhs);
  if(!append)return undefined;
  const delimiter=text(append[1]);
  if(delimiter===undefined)return undefined;
  const prior=apexPrefixBefore(loop.body??[],write.node.start);
  if(!prior)return undefined;
  const relevant=prior.filter(n=>word(append[2]).test(maskApexSource(c.source.slice(n.start,n.end))));
  if(relevant.length!==1||relevant[0].kind!=="statement"||
    !new RegExp("^String\\s+"+append[2]+"\\s*=\\s*"+loop.loopVariable+"\\s*\\.\\s*getFieldPath\\s*\\(\\s*\\)\\s*;$","i").test(clean(relevant[0].text??"")))return undefined;
  const body=maskApexSource(c.source.slice(loop.start,loop.end));
  if(/\b(?:return|throw|break|continue)\b/i.test(body)||
    (body.match(new RegExp("\\b"+helper.parameters[0]+"\\b","gi"))?.length??0)!==1||
    (maskApexSource(c.source.slice(helper.body[0]?.start??helper.start,helper.end)).match(new RegExp("\\b"+helper.parameters[0]+"\\b","gi"))?.length??0)!==1||
    symbols.hasLocalBinding(helper,"Schema",loop.start))return undefined;
  if(c.methods.filter(m=>symbols.sameOwner(c.method,m)&&same(m.name,helper.name)).length!==1)return undefined;
  const prefix=apexPrefixBefore(c.method.body,c.offset);
  if(!prefix)return undefined;
  const helperUses=prefix.filter(n=>word(helper.name).test(maskApexSource(c.source.slice(n.start,n.end))));
  if(helperUses.length!==1||helperUses[0].kind!=="statement")return undefined;
  const invocation=helperUses[0],call=new RegExp("(?:^|=\\s*)"+helper.name+"\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)\\s*;$","i").exec(clean(invocation.text??""));
  if(!call||symbols.lookup(c.method,call[1],invocation.start)!=="list<schema.fieldsetmember>"||symbols.hasLocalBinding(c.method,helper.name,invocation.start))return undefined;
  const inputUses=prefix.filter(n=>n.start<invocation.start&&word(call[1]).test(maskApexSource(c.source.slice(n.start,n.end))));
  if(inputUses.length!==1||inputUses[0].kind!=="statement")return undefined;
  const input=new RegExp("^List\\s*<\\s*Schema\\s*\\.\\s*FieldSetMember\\s*>\\s+"+call[1]+"\\s*=\\s*(Schema\\s*\\.\\s*SObjectType\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\.\\s*fieldSets\\s*\\.\\s*getMap\\s*\\(\\s*\\)\\s*\\.\\s*get\\s*\\(\\s*'(?:\\\\.|[^'\\\\])*'\\s*\\)\\s*\\.\\s*getFields\\s*\\(\\s*\\))\\s*;$","i").exec(clean(inputUses[0].text??""));
  if(!input||symbols.hasLocalBinding(c.method,"Schema",inputUses[0].start)||symbols.lookup(c.method,"Schema",inputUses[0].start))return undefined;
  const fields=resolve(input[1],inputUses[0].start);
  if(fields.kind!=="collection"||fields.items.length>2000)return undefined;
  let known=seed;
  for(const node of prefix){
    if(node===invocation){for(const f of fields.items)known+=delimiter+f;continue;}
    const direct=proof.writes.find(w=>w.method===c.method&&w.node===node);
    if(direct){const value=text(direct.rhs);if(value===undefined)return undefined;known+=value;}
  }
  if(known.length>16000)return undefined;
  return {kind:"unknown",reason:"Known append-only member fragments; earlier transaction-local writes are unverified",
    fragments:[{kind:"literal",text:known},{kind:"hole",symbol:{name,type:fieldSetMemberTailType+input[2]}}]};
}
