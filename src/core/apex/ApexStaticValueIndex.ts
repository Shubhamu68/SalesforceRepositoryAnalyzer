import path from "node:path";
import {evaluateApexExpression, unknown, type ApexValue} from "./ApexValueEvaluator.js";
import {maskApexSource, matchingPair, parseApexStatements, stripApexComments, indexApexMethods} from "./ApexSourceModel.js";

export interface ApexStaticSource {filePath:string;source:string;}
interface Declaration {
  owner:string;
  field:string;
  initializer:string;
  isStatic:boolean;
  initializerPresent:boolean;
  declarationStart:number;
  declarationEnd:number;
  collection:boolean;
  filePath:string;
  laterWrite?:boolean;
  blockValue?:ApexValue;
}
type MetadataResolver=(name:string,args:ApexValue[])=>ApexValue|undefined;
const identifier=/^[A-Za-z_]\w*$/;
const MAX_CONSTANTS=10000;
const MAX_DEPTH=24;

/**
 * Repository-wide declared-initializer snapshot for Apex scalar and collection members.
 *
 * Analysis policy: a complete, evaluable class-level initializer is a
 * repository snapshot unless visible writes or direct collection aliases
 * invalidate it. Indirect effects remain outside this bounded model.
 * Scope, missing initializers, unsupported values, and dependency cycles
 * remain subject to the same bounded evaluation rules.
 */
export class ApexStaticValueIndex {
  private readonly declarations=new Map<string,Declaration[]>();
  private readonly classOwners=new Map<string,Set<string>>();
  private readonly cache=new Map<string,ApexValue>();
  private readonly lazyGetters=new Map<string,ApexValue>();
  private readonly metadataCaches=new WeakMap<MetadataResolver,Map<string,ApexValue>>();

  constructor(sources:readonly ApexStaticSource[]){
    let total=0;
    const blockCandidates:Array<{entry:Declaration;filePath:string;start:number;end:number;value:ApexValue}>=[];
    const lazyCandidates:Array<{entry:Declaration;filePath:string;start:number;end:number;value:ApexValue;getter:string}>=[];
    for(const file of sources){
      const masked=maskApexSource(file.source);
      const classMatch=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked);
      if(!classMatch)continue;
      const owner=classMatch[1];
      const ownerKey=owner.toLowerCase();
      const owners=this.classOwners.get(ownerKey)??new Set<string>();
      owners.add(path.resolve(file.filePath));
      this.classOwners.set(ownerKey,owners);
      const classBrace=masked.indexOf("{",classMatch.index+classMatch[0].length);
      if(classBrace<0)continue;
      const depth=new Int16Array(masked.length);
      let current=0;
      for(let i=classBrace;i<masked.length;i++){
        depth[i]=current;
        if(masked[i]==="{")current++;
        else if(masked[i]==="}")current=Math.max(0,current-1);
      }
      const classEnd=matchingPair(masked,classBrace,"{","}");
      if(classEnd<0)continue;
      const ownFields=new Map<string,Declaration>();
      const declaration=/\b((?:(?:public|private|protected|global|static|final|transient)\s+)*)(String|Integer|Long|Decimal|Double|Boolean|Id|(?:List|Set|Map)\s*<[\w\s,.<>]+>)\s+([A-Za-z_]\w*)\s*(=|;)/gi;
      let hit:RegExpExecArray|null;
      while((hit=declaration.exec(masked))!==null){
        if(depth[hit.index]!==1)continue;
        const modifiers=hit[1].trim().split(/\s+/).map(s=>s.toLowerCase());
        if(total++>=MAX_CONSTANTS)continue;
        const field=hit[3];
        if(!identifier.test(field))continue;
        const initialized=hit[4]==="=";
        const begin=hit.index+hit[0].length;
        const semi=initialized?masked.indexOf(";",begin):hit.index+hit[0].length-1;
        if(semi<0||depth[semi]!==1)continue;
        const expr=initialized?file.source.slice(begin,semi).trim():"";
        if(expr.length>16000)continue;
        const entry:Declaration={
          owner,field,initializer:expr,
          isStatic:modifiers.includes("static"),
          initializerPresent:initialized&&expr.length>0,
          declarationStart:hit.index,declarationEnd:semi+1,
          collection:/^(?:List|Set|Map)\s*</i.test(hit[2]),filePath:path.resolve(file.filePath),
        };
        const key=(owner+"."+field).toLowerCase();
        this.declarations.set(key,[...(this.declarations.get(key)??[]),entry]);
        ownFields.set(field.toLowerCase(),entry);
        declaration.lastIndex=semi+1;
      }
      for(const candidate of staticBlockCandidates(file.source,masked,depth,classBrace,classEnd,ownFields))
        blockCandidates.push({...candidate,filePath:path.resolve(file.filePath)});
      for(const candidate of lazyGetterCandidates(file.source,masked,depth,classBrace,classEnd,ownFields))
        lazyCandidates.push({...candidate,filePath:path.resolve(file.filePath)});
    }
    // Direct writes and simple collection escapes are repository evidence,
    // not a proof of runtime immutability. Exclude each declaration and
    // explicitly supported initialization assignment from its own write set.
    const candidates=[...this.declarations.values()].flat().filter(e=>e.isStatic);
    if(candidates.length){
      const byKey=new Map(candidates.map(e=>[(e.owner+"."+e.field).toLowerCase(),e]));
      const names=new Set(candidates.map(e=>e.field.toLowerCase()));
      const writes=new Map<string,Array<{filePath:string;offset:number}>>();
      for(const file of sources){
        const masked=maskApexSource(file.source);
        const owner=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked)?.[1];
        if(!owner)continue;
        const token=/\b[A-Za-z_]\w*\b/g;
        let hit:RegExpExecArray|null;
        while((hit=token.exec(masked))!==null){
          if(!names.has(hit[0].toLowerCase()))continue;
          const before=masked.slice(Math.max(0,hit.index-256),hit.index);
          const qualified=/\b([A-Za-z_]\w*)\s*\.\s*$/.exec(before);
          const key=((qualified?.[1]??owner)+"."+hit[0]).toLowerCase();
          const entry=byKey.get(key);
          if(!entry)continue;
          const after=masked.slice(token.lastIndex,token.lastIndex+256);
          const prefix=qualified?before.slice(0,qualified.index):before;
          const direct=/^(?:\s*(?:=(?!=|>)|[+\-*/%&|^]=|\+\+|--)|\s*\[[^\];]*\]\s*(?:=(?!=|>)|[+\-*/%&|^]=|\+\+|--)|\s*\.\s*(?:add|addAll|remove|removeAll|retainAll|clear|put|putAll|set|sort|reverse)\s*\()/i.test(after)||/(?:\+\+|--)\s*$/.test(prefix);
          // A direct reference assignment can create an untracked mutable
          // alias. Treat it as an escape even if later writes are not found.
          const alias=entry.collection&&/^\s*;/.test(after)&&((/=\s*$/.test(prefix)&&!/==\s*$/.test(prefix))||/\breturn\s*$/i.test(prefix));
          if(!direct&&!alias)continue;
          const found=writes.get(key)??[];
          found.push({filePath:path.resolve(file.filePath),offset:hit.index});
          writes.set(key,found);
        }
      }
      const conflict=(entry:Declaration,allowed?:{filePath:string;start:number;end:number})=>{
        const key=(entry.owner+"."+entry.field).toLowerCase();
        return (writes.get(key)??[]).some(w=>{
          if(w.filePath===entry.filePath&&w.offset>=entry.declarationStart&&w.offset<entry.declarationEnd)return false;
          return !allowed||w.filePath!==allowed.filePath||w.offset<allowed.start||w.offset>=allowed.end;
        });
      };
      for(const entry of candidates)if(entry.initializerPresent)entry.laterWrite=conflict(entry);
      for(const candidate of blockCandidates){
        const key=(candidate.entry.owner+"."+candidate.entry.field).toLowerCase();
        candidate.entry.blockValue=conflict(candidate.entry,candidate)
          ?unknown("Apex static-block field "+key+" has additional repository-visible writes."):candidate.value;
      }
      for(const candidate of lazyCandidates){
        const key=(candidate.entry.owner+"."+candidate.getter).toLowerCase();
        if(!conflict(candidate.entry,candidate)&&this.classOwners.get(candidate.entry.owner.toLowerCase())?.size===1&&
          !this.lazyGetters.has(key))this.lazyGetters.set(key,candidate.value);
      }
    }
  }

  /** Only invocation of the proven getter initializes this value. A bare
   * read of its backing field is still unknown. */
  resolveLazyGetter(owner:string,method:string):ApexValue|undefined{
    const value=this.lazyGetters.get((owner+"."+method).toLowerCase());
    // Defensive-copy getters must allocate an independent abstract collection
    // on every call, not share the cached reference identity.
    return value?.kind==="collection"?{...value,items:[...value.items]}:value;
  }

  hasClass(name:string):boolean{
    return this.classOwners.has(name.toLowerCase());
  }

  resolve(name:string,metadata?:MetadataResolver):ApexValue {
    return this.compute(name.toLowerCase(),new Set<string>(),0,false,metadata);
  }

  /**
   * An instance field is not a class constant. In a valid owning-instance
   * scope use its declared initializer under the same snapshot assumption.
   * Constructor-only and blank fields still require object-flow analysis.
   */
  resolveUnqualified(owner:string,field:string,insideStaticMethod:boolean,metadata?:MetadataResolver):ApexValue|undefined {
    const entry=this.declarations.get((owner+"."+field).toLowerCase());
    if(!entry?.length)return undefined;
    if(entry.length!==1)
      return unknown("Apex member "+owner+"."+field+" has ambiguous declarations.");
    if(entry[0].isStatic)return this.resolve(owner+"."+field,metadata);
    if(insideStaticMethod)
      return unknown("Instance member "+owner+"."+field+
        " cannot be referenced as a static field.");
    return this.resolveInstance(owner,field,metadata);
  }

  resolveInstance(owner:string,field:string,metadata?:MetadataResolver):ApexValue {
    return this.compute((owner+"."+field).toLowerCase(),new Set<string>(),0,true,metadata,true);
  }

  private compute(key:string,active:Set<string>,depth:number,allowInstance:boolean,
    metadata?:MetadataResolver,requireInstance=false):ApexValue{
    if(active.has(key))return unknown("Cyclic Apex member initializer: "+key);
    if(depth>=MAX_DEPTH)return unknown("Apex initializer dependency depth exceeded: "+key);
    const dot=key.lastIndexOf(".");
    if(dot<1)return unknown("Malformed Apex class-qualified constant: "+key);
    const className=key.slice(0,dot);
    const owners=this.classOwners.get(className);
    if(!owners?.size)return unknown("Apex class "+className+" is missing from the indexed repository.");
    if(owners.size!==1)return unknown("Apex class "+className+" has ambiguous repository definitions.");
    const entries=this.declarations.get(key)??[];
    if(entries.length!==1)return unknown(entries.length
      ?"Apex field "+key+" has ambiguous declarations."
      :"Apex field "+key+" has no supported static scalar initializer or collection initializer declaration.");
    const entry=entries[0];
    if(requireInstance&&entry.isStatic)
      return unknown("Field "+key+" is static, not an instance member.");
    if(!allowInstance&&!entry.isStatic)
      return unknown("Apex member "+key+" is an instance field (not static); class-qualified references cannot prove its value without a specific instance.");
    if(entry.blockValue!==undefined)return entry.blockValue;
    if(entry.laterWrite)return unknown("Apex static field "+key+" has additional repository-visible writes or an untracked collection alias.");
    if(!entry.initializerPresent)
      return unknown(entry.isStatic?"Apex static field "+key+" has no declaration initializer; static initialization is not proven.":
        "Instance field "+key+" requires constructor or initializer-block tracking.");
    // Metadata-dependent values must not leak across scans or discovery passes.
    let cache=this.cache;
    if(metadata){
      let scoped=this.metadataCaches.get(metadata);
      if(!scoped){scoped=new Map();this.metadataCaches.set(metadata,scoped);}
      cache=scoped;
    }
    const cached=cache.get(key);
    if(cached)return cached;
    active.add(key);
    let result:ApexValue;
    try {
      const values=new Map<string,ApexValue>();
      const expressionMasked=maskApexSource(entry.initializer);
      const candidate=/\b[A-Za-z_]\w*\b/g;
      let token:RegExpExecArray|null;
      while((token=candidate.exec(expressionMasked))!==null){
        if(token.index>0&&expressionMasked[token.index-1]===".")continue;
        const localName=token[0];
        // A class-qualified reference must not create a false local alias
        // when a field happens to share the class name (case-insensitively).
        if(this.hasClass(localName)&&/^\s*\./.test(expressionMasked.slice(candidate.lastIndex)))continue;
        const localKey=(entry.owner+"."+localName).toLowerCase();
        if(!this.declarations.has(localKey))continue;
        values.set(localName,this.compute(localKey,active,depth+1,!entry.isStatic,metadata));
      }
      result=evaluateApexExpression(entry.initializer,{
        values,
        resolveCall:(method,args)=>{
          if(method==="Apex.constant"&&args.length===1&&
            args[0].kind==="text"&&args[0].values.length===1)
            return this.compute(args[0].values[0].toLowerCase(),active,depth+1,false,metadata);
          if(method==="System.Label")return metadata?.(method,args);
          return undefined;
        },
      });
      if(/^null$/i.test(entry.initializer.trim()))
        result=unknown("Apex field "+key+" has a null initializer.");
      if(!completeInitializer(result))
        result=unknown("Apex field "+key+" does not have a complete supported scalar or collection initializer.");
    }finally{active.delete(key);}
    cache.set(key,result);
    return result;
  }
}

/**
 * Bounded static-block slice: accept only direct, single assignments to
 * previously declared, uninitialized static members. All static blocks in
 * this class must have this supported shape. No local variables, helper
 * calls, control flow or cross-field dependencies are assumed.
 */
function staticBlockCandidates(source:string,masked:string,depth:Int16Array,
  classBrace:number,classEnd:number,fields:ReadonlyMap<string,Declaration>):
  Array<{entry:Declaration;start:number;end:number;value:ApexValue}>{
  const result:Array<{entry:Declaration;start:number;end:number;value:ApexValue}>=[];
  const assigned=new Set<string>();
  const blocks=/\bstatic\s*\{/gi;
  blocks.lastIndex=classBrace+1;
  let hit:RegExpExecArray|null;
  while((hit=blocks.exec(masked))!==null&&hit.index<classEnd){
    if(depth[hit.index]!==1)continue;
    const open=blocks.lastIndex-1;
    const close=matchingPair(masked,open,"{","}");
    if(close<0||close>classEnd)return [];
    const nodes=parseApexStatements(source,open+1,close,masked);
    if(masked.slice(nodes[nodes.length-1]?.end??open+1,close).trim())return [];
    for(const node of nodes){
      if(node.kind!=="statement"||!node.text)return [];
      const clean=stripApexComments(node.text);
      const assignment=/^\s*([A-Za-z_]\w*)\s*=(?!=|>)\s*([\s\S]+);\s*$/.exec(clean);
      if(!assignment)return [];
      const field=assignment[1].toLowerCase();
      const entry=fields.get(field);
      if(!entry?.isStatic||entry.initializerPresent||entry.declarationEnd>open||assigned.has(field))return [];
      // No external call resolver or field environment: only independently
      // evaluable scalar/collection expressions can establish a value.
      const value=evaluateApexExpression(assignment[2],{values:new Map()});
      if(value.kind==="unknown"||value.kind==="null"||!completeInitializer(value))return [];
      assigned.add(field);
      result.push({entry,start:node.start,end:node.end,value});
    }
    blocks.lastIndex=close+1;
  }
  return result;
}

/** Canonical lazy getter: if (field == null) { field = literal; } return field;
 * or return a defensive List/Set copy. No arbitrary helpers or side effects.
 * The backing declaration must be blank or explicitly null. */
function lazyGetterCandidates(source:string,masked:string,depth:Int16Array,
  classBrace:number,classEnd:number,fields:ReadonlyMap<string,Declaration>):
  Array<{entry:Declaration;start:number;end:number;value:ApexValue;getter:string}>{
  const result:Array<{entry:Declaration;start:number;end:number;value:ApexValue;getter:string}>=[];
  const methods=indexApexMethods(source);
  for(const method of methods){
    if(!method.isStatic||method.parameters.length||method.start<=classBrace||method.end>=classEnd||
      depth[method.start-1]!==1||methods.filter(m=>m.name.toLowerCase()===method.name.toLowerCase()&&m.parameters.length===0).length!==1)continue;
    const [guard,ret]=method.body;
    if(method.body.length!==2||guard?.kind!=="if"||guard.otherwise?.length||guard.body?.length!==1||
      guard.body[0].kind!=="statement"||ret?.kind!=="statement")continue;
    const test=/^\s*([A-Za-z_]\w*)\s*==\s*null\s*$/i.exec(stripApexComments(guard.condition??""));
    if(!test)continue;
    const entry=fields.get(test[1].toLowerCase());
    if(!entry?.isStatic||entry.initializerPresent&&!/^null$/i.test(entry.initializer.trim()))continue;
    const node=guard.body[0];
    const assignment=/^\s*([A-Za-z_]\w*)\s*=(?!=|>)\s*([\s\S]+);\s*$/.exec(stripApexComments(node.text??""));
    if(!assignment||assignment[1].toLowerCase()!==entry.field.toLowerCase())continue;
    const initial=evaluateApexExpression(assignment[2],{values:new Map()});
    if(initial.kind==="unknown"||initial.kind==="null"||!completeInitializer(initial))continue;
    const returned=/^\s*return\s+([\s\S]+);\s*$/i.exec(stripApexComments(ret.text??""))?.[1].trim();
    if(!returned)continue;
    if(entry.collection){
      // Returning the mutable reference itself is an unproven escape.
      const copy=/^new\s+(?:List|Set)\s*<[\w\s,.<>]+>\s*\(\s*([A-Za-z_]\w*)\s*\)$/i.exec(returned);
      if(!copy||copy[1].toLowerCase()!==entry.field.toLowerCase())continue;
    }else if(returned.toLowerCase()!==entry.field.toLowerCase())continue;
    const value=evaluateApexExpression(returned,{values:new Map([[entry.field,initial],[test[1],initial]])});
    if(value.kind==="unknown"||!completeInitializer(value))continue;
    result.push({entry,start:node.start,end:node.end,value,getter:method.name});
  }
  return result;
}

/** Snapshot values are immutable abstract values. Only bounded, completely
 * evaluated scalar leaves, string collections and nested maps qualify. */
function completeInitializer(value:ApexValue,depth=0):boolean{
  if(depth>12)return false;
  switch(value.kind){
    case "unknown": return depth===0;
    case "text": return value.values.length===1;
    case "number": return Number.isFinite(value.value);
    case "collection": return value.items.length<=2000;
    case "map": return value.entries.length<=200&&value.entries.every(([,v])=>completeInitializer(v,depth+1));
    default: return false;
  }
}
