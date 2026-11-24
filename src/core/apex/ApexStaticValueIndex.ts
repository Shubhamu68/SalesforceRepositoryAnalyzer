import path from "node:path";
import {evaluateApexExpression, unknown, type ApexValue} from "./ApexValueEvaluator.js";
import {maskApexSource} from "./ApexSourceModel.js";

export interface ApexStaticSource {filePath:string;source:string;}
interface Declaration {
  owner:string;
  field:string;
  initializer:string;
  isStatic:boolean;
  initializerPresent:boolean;
}
type MetadataResolver=(name:string,args:ApexValue[])=>ApexValue|undefined;
const identifier=/^[A-Za-z_]\w*$/;
const MAX_CONSTANTS=10000;
const MAX_DEPTH=24;

/**
 * Repository-wide declared-initializer snapshot for Apex scalar and collection members.
 *
 * Analysis policy: a complete, evaluable class-level initializer is the
 * assumed value, independent of visibility, final, annotations, or possible
 * reassignment elsewhere. This is repository-based query reconstruction,
 * not proof that every runtime execution sees the initializer.
 * Scope, missing initializers, unsupported values, and dependency cycles
 * remain subject to the same bounded evaluation rules.
 */
export class ApexStaticValueIndex {
  private readonly declarations=new Map<string,Declaration[]>();
  private readonly classOwners=new Map<string,Set<string>>();
  private readonly cache=new Map<string,ApexValue>();
  private readonly metadataCaches=new WeakMap<MetadataResolver,Map<string,ApexValue>>();

  constructor(sources:readonly ApexStaticSource[]){
    let total=0;
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
        };
        const key=(owner+"."+field).toLowerCase();
        this.declarations.set(key,[...(this.declarations.get(key)??[]),entry]);
        declaration.lastIndex=semi+1;
      }
    }
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
