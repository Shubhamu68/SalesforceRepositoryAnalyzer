import {indexApexMethods,maskApexSource,matchingPair,stripApexComments,type IndexedApexMethod} from "../core/apex/ApexSourceModel.js";
import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import {evaluateApexExpression,listValue,type ApexValue} from "../core/apex/ApexValueEvaluator.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import type {ApexCallResolver} from "../core/apex/ApexTypeSystem.js";
import {directTemplate,proveCallerPermissionShapes} from "./soqlCallerStructuralEvidence.js";

const clean=(s:string)=>stripApexComments(s).trim();
const word=(name:string)=>new RegExp("\\b"+name+"\\b","gi");
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const statements=(m:IndexedApexMethod)=>m.body.map(n=>clean(n.text??""));
const scalarReturn=(s:string,name:string)=>new RegExp("^return\\s+"+name+"\\s*;$","i").test(s);

/** Proven read-only label-backed collection inventory. No simulated batch
 * transaction or assumption that static state survives between transactions.
 * Require every cache reference and getter alias to remain in a narrow
 * read-only source pattern; unknown callers/mutations are not ignored. */
export function proveLabelBackedPermissionShapes(source:string,site:ApexCallSite,resolveExternal?:ApexCallResolver,methods=indexApexMethods(source)):string[]{
  if(!resolveExternal)return [];
  const template=directTemplate(source,site,methods);
  if(!template)return [];
  const target=template.owner;
  if(target.visibility!=="private"||target.parameters.length!==1||
    target.parameterTypes?.[0]?.replace(/\s/g,"").toLowerCase()!=="list<string>"||
    target.body.length>2||target.body.some(n=>n.kind!=="statement")||
    !/^return\s/i.test(clean(target.body.at(-1)?.text??"")))return [];
  const parameter=target.parameters[0];
  // The sole incoming alias must be consumed only in the SELECT builder,
  // not returned, mutated or passed into a second helper.
  const joins=[...template.expression.matchAll(new RegExp("\\bString\\s*\\.\\s*join\\s*\\(\\s*"+parameter+"\\s*,\\s*'(?:\\\\.|[^'\\\\])*'\\s*\\)","gi"))];
  if(joins.length!==1||[...maskApexSource(source.slice(target.start,target.end)).matchAll(word(parameter))].length!==1)return [];
  const symbols=apexSymbols(source,methods);
  const masked=maskApexSource(source);
  const owner=symbols.ownerAt(target.start);
  if(!owner||methods.filter(m=>symbols.sameOwner(target,m)&&eq(m.name,target.name)).length!==1)return [];
  if(/\bclass\s+(?:String|List|Label)\b/i.test(masked))return [];
  const readLabel=(getter:IndexedApexMethod):string[]=>{
    if(!getter.isStatic||getter.visibility!=="private"||getter.parameters.length||
      getter.returnType?.replace(/\s/g,"").toLowerCase()!=="list<string>"||
      !symbols.sameOwner(target,getter)||
      methods.filter(m=>symbols.sameOwner(getter,m)&&eq(m.name,getter.name)).length!==1)return [];
    const [guard,initialize,blank,normalize,loop,ret]=getter.body;
    if(getter.body.length!==6||guard.kind!=="if"||guard.otherwise?.length||guard.body?.length!==1||
      initialize.kind!=="statement"||blank.kind!=="if"||blank.otherwise?.length||blank.body?.length!==1||
      normalize.kind!=="statement"||loop.kind!=="for"||loop.body?.length!==1||ret.kind!=="statement")return [];
    const cacheName=/^([A-Za-z_]\w*)\s*!=\s*null$/i.exec(clean(guard.condition??""))?.[1];
    if(!cacheName||!scalarReturn(clean(guard.body[0].text??""),cacheName)||!scalarReturn(clean(ret.text??""),cacheName)||
      !new RegExp("^"+cacheName+"\\s*=\\s*new\\s+List\\s*<\\s*String\\s*>\\s*\\(\\s*\\)\\s*;$","i").test(clean(initialize.text??"")))return [];
    const blankLabel=/^String\s*\.\s*isBlank\s*\(\s*((?:System\.)?Label\.[A-Za-z_]\w*)\s*\)$/i.exec(clean(blank.condition??""))?.[1];
    if(!blankLabel||!scalarReturn(clean(blank.body[0].text??""),cacheName))return [];
    const normalized=/^String\s+([A-Za-z_]\w*)\s*=\s*((?:System\.)?Label\.[A-Za-z_]\w*)\s*\.\s*replace\s*\(\s*';'\s*,\s*','\s*\)\s*;$/i.exec(clean(normalize.text??""));
    if(!normalized||!eq(normalized[2],blankLabel))return [];
    const variable=loop.loopVariable;
    if(!variable||!new RegExp("^"+normalized[1]+"\\s*\\.\\s*split\\s*\\(\\s*','\\s*\\)$","i").test(clean(loop.iterable??"")))return [];
    const append=loop.body[0];
    if(append.kind!=="if"||append.otherwise?.length||append.body?.length!==1||
      !new RegExp("^!\\s*String\\s*\\.\\s*isBlank\\s*\\(\\s*"+variable+"\\s*\\)$","i").test(clean(append.condition??""))||
      !new RegExp("^"+cacheName+"\\s*\\.\\s*add\\s*\\(\\s*"+variable+"\\s*\\.\\s*trim\\s*\\(\\s*\\)\\s*\\)\\s*;$","i").test(clean(append.body[0].text??"")))return [];
    // Private uninitialized field, with no references outside the getter and declaration.
    const declarations=[...masked.matchAll(new RegExp("\\bprivate\\s+static\\s+List\\s*<\\s*String\\s*>\\s+"+cacheName+"\\s*;","gi"))];
    if(declarations.length!==1||symbols.ownerAt(declarations[0].index!)!==owner)return [];
    const declaration=declarations[0];
    if([...masked.matchAll(word(cacheName))].some(hit=>{
      const i=hit.index!;
      return !(i>=getter.start&&i<getter.end)&&!(i>=declaration.index!&&i<declaration.index!+declaration[0].length);
    }))return [];
    if(["String","List","Label"].some(n=>symbols.lookup(getter,n,getter.start)))return [];
    // Every invocation must initialize a local alias in the same owning
    // class. Every alias occurrence must be an inert read or this one
    // selected read-only query helper. All other escapes reject the proof.
    let reachesTarget=false;
    const callRx=new RegExp("\\b"+getter.name+"\\s*\\(","gi");
    for(const hit of masked.matchAll(callRx)){
      const i=hit.index!,open=i+hit[0].length-1,end=matchingPair(masked,open);
      if(end<0)return [];
      const after=masked.slice(end+1).match(/^\s*\{/);
      if(after&&end+1+after[0].length===getter.start)continue;
      const method=methods.filter(m=>m.start<=i&&i<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
      if(!method||method===getter||!symbols.sameOwner(getter,method))return [];
      const node=method.body.find(n=>n.kind==="statement"&&n.start<=i&&i<n.end);
      if(!node)return [];
      const alias=new RegExp("^List\\s*<\\s*String\\s*>\\s+([A-Za-z_]\\w*)\\s*=\\s*"+getter.name+"\\s*\\(\\s*\\)\\s*;$","i").exec(clean(node.text??""))?.[1];
      if(!alias)return [];
      for(const use of masked.slice(method.start,method.end).matchAll(word(alias))){
        const pos=method.start+use.index!;
        if(pos>=node.start&&pos<node.end)continue;
        if(pos<node.end)return [];
        const before=masked.slice(Math.max(method.start,pos-200),pos);
        const suffix=masked.slice(pos+alias.length,Math.min(method.end,pos+200));
        if(/^\s*\.\s*(?:isEmpty|size)\s*\(\s*\)/i.test(suffix))continue;
        if(/\bfor\s*\(\s*String\s+[A-Za-z_]\w*\s*:\s*$/i.test(before)&&/^\s*\)/.test(suffix))continue;
        if(new RegExp("(?:^|[^.\\w])"+target.name+"\\s*\\(\\s*$","i").test(before)&&/^\s*\)/.test(suffix)){
          reachesTarget=true;continue;
        }
        return [];
      }
    }
    if(!reachesTarget)return [];
    // Read only authoritative metadata; reuse the existing Apex scalar
    // replace and split functions after proving the source shape.
    const normalizedValue=evaluateApexExpression(normalized[2]+".replace(';', ',')",{values:new Map(),resolveCall:resolveExternal});
    if(normalizedValue.kind!=="text"||normalizedValue.values.length!==1)return [];
    const split=evaluateApexExpression("normalized.split(',')",{values:new Map([["normalized",normalizedValue]])});
    if(split.kind!=="collection"||split.items.length>2000)return [];
    const fields=split.items.map(s=>s.trim()).filter(Boolean);
    if(!fields.length||fields.some(f=>!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(f)))return [];
    return fields;
  };
  const result=new Set<string>();
  for(const getter of methods){
    const fields=readLabel(getter);
    if(!fields.length)continue;
    for(const text of proveCallerPermissionShapes(source,site,[[listValue(fields)]],methods))result.add(text);
  }
  return [...result];
}
