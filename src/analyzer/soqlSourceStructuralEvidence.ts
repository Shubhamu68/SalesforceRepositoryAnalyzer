import {indexApexMethods,maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod,type SourceNode} from "../core/apex/ApexSourceModel.js";
import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import {resolveApexWrapperMemberType} from "../core/apex/ApexSourceValueProofs.js";
import {findApexTernary} from "../core/apex/ApexConditionalInvocation.js";
import {evaluateApexExpression,addApexValues,runtimeParameter,textValue,type ApexValue} from "../core/apex/ApexValueEvaluator.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import {provePartialSoql} from "./soqlPartialStructure.js";
import {simplePermissionShape,aggregatePermissionShapes,type SoqlPermissionShape} from "./soqlPermissionAggregation.js";
import {maskSoqlStringsAndComments} from "./soqlExecutionMode.js";

const scalar=/^(?:integer|long|decimal|double|boolean|date|datetime|id)$/i;
const clean=(s:string)=>stripApexComments(s).trim();
const one=(v:ApexValue):string|undefined=>v.kind==="text"&&v.values.length===1?v.values[0]:undefined;
const literal=(s:string)=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))?one(evaluateApexExpression(clean(s),{values:new Map()})):undefined;
const MAX_PIECES=64;
const MAX_NODES=160;

function removeTrailingAnd(text:string):string{
  const visible=maskSoqlStringsAndComments(text);
  const match=/\bAND\s*$/i.exec(visible);
  return match?text.slice(0,match.index).trimEnd():text.trimEnd();
}

/** Permission-only fallback over an already indexed local String builder.
 * It never interprets Apex, explores combinations, or assumes UI-provided
 * structural strings. Each optional clause/ternary arm is parser-validated
 * independently and then aggregated. It is supplementary source evidence,
 * not a claim that the full query or any particular branch executed. */
export function proveLocalSoqlPermissionShape(source:string,site:ApexCallSite,methods=indexApexMethods(source)):string[]{
  const name=site.argument.trim();
  if(!/^[A-Za-z_]\w*$/.test(name))return [];
  const owner=methods.filter(m=>m.start<=site.offset&&site.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!owner)return [];
  const target=owner.body.find(n=>n.kind==="statement"&&n.start<=site.offset&&site.offset<n.end);
  if(!target)return []; // initially only a direct top-level invocation
  const nameRx=new RegExp("\\b"+name+"\\b","i");
  const declaration=new RegExp("^String\\s+"+name+"\\s*=(?!=|>)\\s*([\\s\\S]+);$","i");
  const append=new RegExp("^"+name+"\\s*\\+=\\s*([\\s\\S]+);$","i");
  const prior=owner.body.filter(n=>n.end<=target.start);
  const defs=prior.map((n,i)=>({n,i,m:n.kind==="statement"?declaration.exec(clean(n.text??"")):null})).filter(x=>x.m);
  if(defs.length!==1)return [];
  const def=defs[0];
  const symbols=apexSymbols(source,methods);
  const typeOf=(expression:string,offset:number):string|undefined=>{
    const expr=clean(expression);
    if(/^[A-Za-z_]\w*$/.test(expr))return symbols.lookup(owner,expr,offset);
    const member=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
    const type=member?symbols.lookup(owner,member[1],offset):undefined;
    return type&&member?resolveApexWrapperMemberType(source,type,member[2]):undefined;
  };
  // No shadowed platform String or ambiguous class declaration.
  if(symbols.lookup(owner,"String",def.n.start)||/\bclass\s+String\b/i.test(maskApexSource(source)))return [];
  const evalPiece=(expr:string):ApexValue|undefined=>{
    const value=literal(expr);
    if(value!==undefined)return textValue(value);
    const date=/^String\s*\.\s*valueOf\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\)\s*\.\s*substring\s*\(\s*0\s*,\s*10\s*\)$/i.exec(clean(expr));
    if(date&&/^(?:date|datetime)$/i.test(typeOf(date[1],def.n.start)??""))return runtimeParameter(date[1],"date","Typed date value used for parser evidence.");
    const type=typeOf(expr,def.n.start);
    return type&&scalar.test(type)?runtimeParameter(expr,type,"Typed scalar value used for parser evidence."):undefined;
  };
  const pieces=splitApexTopLevel(clean(def.m![1]),"+");
  if(!pieces.length||pieces.length>MAX_PIECES)return [];
  const options:ApexValue[][]=[];
  for(const raw of pieces){
    let expr=clean(raw);
    if(expr.startsWith("(")&&matchingPair(maskApexSource(expr),0)===expr.length-1)expr=clean(expr.slice(1,-1));
    const ternary=findApexTernary(maskApexSource(expr));
    if(ternary){
      const condition=clean(expr.slice(0,ternary.question));
      // Only literal arms; no invocation side effects or nested alternatives.
      if(nameRx.test(maskApexSource(condition)))return [];
      const a=literal(expr.slice(ternary.question+1,ternary.colon)),b=literal(expr.slice(ternary.colon+1));
      if(a===undefined||b===undefined)return [];
      options.push(/^true$/i.test(condition)?[textValue(a)]:/^false$/i.test(condition)?[textValue(b)]:[textValue(a),textValue(b)]);
    }else{
      const value=evalPiece(expr);
      if(!value)return [];
      options.push([value]);
    }
  }
  // Baseline plus one changed arm at a time, never a Cartesian product.
  const render=(changed=-1):string|undefined=>{
    let value:ApexValue=textValue("");
    for(let i=0;i<options.length;i++)value=addApexValues(value,options[i][i===changed?1:0]);
    const text=value.kind==="text"?one(value):provePartialSoql(value)?.text;
    return text===undefined?undefined:removeTrailingAnd(text);
  };
  const baseline=render();
  if(!baseline)return [];
  const base=simplePermissionShape(baseline,site.line);
  if(!base)return [];
  const shapes:SoqlPermissionShape[]=[base];
  for(let i=0;i<options.length;i++)if(options[i].length>1){
    const text=render(i),shape=text===undefined?undefined:simplePermissionShape(text,site.line);
    if(!shape||shape.object.toLowerCase()!==base.object.toLowerCase()||shape.mode!==base.mode)return [];
    shapes.push(shape);
  }
  const anchor=base.fields.find(f=>f.context==="SELECT")?.fieldPath;
  if(!anchor)return [];
  // Changing one arm at a time is safe only for independent complete field
  // list or predicate fragments. Correlated partial identifier pieces could
  // otherwise manufacture combinations such as ShippingStreet from two
  // branches that only ever produce BillingStreet or ShippingCity.
  const key=(f:SoqlPermissionShape["fields"][number])=>f.context+"|"+f.fieldPath.toLowerCase();
  const baseKeys=new Set(base.fields.map(key));
  for(let i=0,j=1;i<options.length;i++)if(options[i].length>1){
    const allowed=new Set<string>();
    let kind:string|undefined;
    for(const arm of options[i]){
      const text=one(arm);
      if(text===undefined)return [];
      if(!text.trim())continue;
      let category:string;
      if(/^(?:\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*,)+\s*$/.test(text)){
        category="SELECT";
        for(const field of text.split(",").map(s=>s.trim()).filter(Boolean))allowed.add("SELECT|"+field.toLowerCase());
      }else if(/\bAND\s*$/i.test(maskSoqlStringsAndComments(text))){
        category="WHERE";
        const shape=simplePermissionShape("SELECT "+anchor+" FROM "+base.object+" WHERE "+removeTrailingAnd(text),site.line);
        if(!shape||shape.mode!=="UNSPECIFIED"||!shape.fields.some(f=>f.context==="WHERE")||
          shape.fields.some(f=>!["SELECT","WHERE"].includes(f.context)))return [];
        for(const field of shape.fields.filter(f=>f.context==="WHERE"))allowed.add(key(field));
      }else return [];
      if(kind&&kind!==category)return [];
      kind=category;
    }
    const changed=new Set(shapes[j++].fields.map(key));
    if([...baseKeys].some(k=>!changed.has(k)&&!allowed.has(k))||
      [...changed].some(k=>!baseKeys.has(k)&&!allowed.has(k)))return [];
  }
  let count=0;
  const appendShape=(raw:string):boolean=>{
    const value=literal(raw);
    if(value===undefined)return false;
    const trimmed=removeTrailingAnd(value).trim();
    if(!trimmed)return true;
    // Validate optional predicate/order independently. An arbitrary full
    // query or WITH clause is not an append-only permission fragment.
    if(/\bWITH\b/i.test(maskSoqlStringsAndComments(trimmed)))return false;
    const order=/^ORDER\s+BY\s+/i.test(trimmed);
    const predicate=trimmed.replace(/^(?:AND|OR|WHERE)\s+/i,"");
    const text="SELECT "+anchor+" FROM "+base.object+(order?" "+trimmed:" WHERE "+predicate);
    const shape=simplePermissionShape(text,site.line);
    if(!shape||shape.mode!=="UNSPECIFIED"||shape.object.toLowerCase()!==base.object.toLowerCase()||
      !shape.fields.some(f=>f.context===(order?"ORDER_BY":"WHERE")))return false;
    // Do not accept a fragment that adds additional SELECT or ORDER syntax
    // in the wrong context; the anchor is only a parser scaffold.
    if(shape.fields.some(f=>f.context!=="SELECT"&&f.context!==(order?"ORDER_BY":"WHERE")))return false;
    shapes.push({...shape,mode:base.mode,fields:shape.fields.filter(f=>f.context!=="SELECT")});
    return true;
  };
  const trimGuard=(node:SourceNode):boolean=>{
    const guard=new RegExp("^"+name+"\\s*\\.\\s*endsWith\\s*\\(\\s*'AND '\\s*\\)$","i");
    const write=new RegExp("^"+name+"\\s*=\\s*"+name+"\\s*\\.\\s*substring\\s*\\(\\s*0\\s*,\\s*"+name+"\\s*\\.\\s*length\\s*\\(\\s*\\)\\s*-\\s*4\\s*\\)\\s*;$","i");
    return guard.test(clean(node.condition??""))&&!node.otherwise?.length&&node.body?.length===1&&
      node.body[0].kind==="statement"&&write.test(clean(node.body[0].text??""));
  };
  const walk=(nodes:readonly SourceNode[]):boolean=>{
    for(const node of nodes){
      if(++count>MAX_NODES)return false;
      if(node.kind==="if"){
        if(trimGuard(node))continue;
        const condition=clean(node.condition??"");
        if(nameRx.test(maskApexSource(condition)))return false;
        if(!/^false$/i.test(condition)&&!walk(node.body??[]))return false;
        if(!/^true$/i.test(condition)&&!walk(node.otherwise??[]))return false;
      }else if(node.kind==="block"){
        if(!walk(node.body??[]))return false;
      }else if(node.kind==="statement"){
        const statement=clean(node.text??"");
        if(!nameRx.test(maskApexSource(statement)))continue;
        const match=append.exec(statement);
        if(!match||!appendShape(match[1]))return false;
      }else return false;
    }
    return true;
  };
  if(!walk(prior.slice(def.i+1)))return [];
  // Require no other reference in the target statement, which prevents a
  // nested callback from being mistaken for the selected query argument.
  const visible=maskApexSource(target.text??"");
  const invocationStart=site.offset-target.start;
  const opening=visible.indexOf("(",invocationStart);
  if(opening<0)return [];
  // The invocation name can itself be 'query', also a common local variable
  // name. Exclude only that exact indexed name, not any operand/reference.
  const withoutMethod=visible.slice(0,invocationStart)+visible.slice(opening);
  const refs=[...withoutMethod.matchAll(new RegExp("\\b"+name+"\\b","gi"))];
  if(refs.length!==1)return [];
  return aggregatePermissionShapes(shapes);
}
