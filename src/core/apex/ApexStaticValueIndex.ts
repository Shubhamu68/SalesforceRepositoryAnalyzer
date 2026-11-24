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
const identifier=/^[A-Za-z_]\w*$/;
const MAX_CONSTANTS=10000;
const MAX_DEPTH=24;

/**
 * Repository-wide declared-initializer snapshot for Apex scalar members.
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

  constructor(sources:readonly ApexStaticSource[]){
    let total=0;
    for(const file of sources){
      const masked=maskApexSource(file.source);
      const classMatch=/\bclass\s+([A-Za-z_]\w*)\b/.exec(masked);
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
      const declaration=/\b((?:(?:public|private|protected|global|static|final|transient)\s+)*)(String|Integer|Long|Decimal|Double|Boolean|Id)\s+([A-Za-z_]\w*)\s*(=|;)/gi;
      let hit:RegExpExecArray|null;
      while((hit=declaration.exec(masked))!==null){
        if(depth[hit.index]!==1)continue;
        const modifiers=hit[1].trim().split(/\s+/).map(s=>s.toLowerCase());
        if(total++>MAX_CONSTANTS)continue;
        const field=hit[3];
        if(!identifier.test(field))continue;
        const initialized=hit[4]==="=";
        const begin=hit.index+hit[0].length;
        const semi=initialized?masked.indexOf(";",begin):hit.index+hit[0].length-1;
        if(semi<0||depth[semi]!==1)continue;
        const expr=initialized?file.source.slice(begin,semi).trim():"";
        if(expr.length>4000)continue;
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

  resolve(name:string):ApexValue {
    return this.compute(name.toLowerCase(),new Set<string>(),0);
  }

  /**
   * An instance field is not a class constant. In a valid owning-instance
   * scope use its declared initializer under the same snapshot assumption.
   * Constructor-only and blank fields still require object-flow analysis.
   */
  resolveUnqualified(owner:string,field:string,insideStaticMethod:boolean):ApexValue|undefined {
    const entry=this.declarations.get((owner+"."+field).toLowerCase());
    if(!entry?.length)return undefined;
    if(entry.length!==1)
      return unknown("Apex member "+owner+"."+field+" has ambiguous declarations.");
    if(entry[0].isStatic)return this.resolve(owner+"."+field);
    if(insideStaticMethod)
      return unknown("Instance member "+owner+"."+field+
        " cannot be referenced as a static field.");
    return this.resolveInstance(owner,field);
  }

  resolveInstance(owner:string,field:string):ApexValue {
    const key=(owner+"."+field).toLowerCase();
    if(this.classOwners.get(owner.toLowerCase())?.size!==1)
      return unknown("Instance field owner "+owner+" is missing or ambiguous.");
    const matches=this.declarations.get(key)??[];
    if(matches.length!==1)
      return unknown("Instance field "+key+" has no single proven declaration.");
    if(matches[0].isStatic)
      return unknown("Field "+key+" is static, not an instance member.");
    if(!matches[0].initializerPresent)
      return unknown("Instance field "+key+
        " requires constructor or initializer-block tracking.");
    return this.evaluateInstanceInitializer(matches[0],new Set<string>(),0);
  }

  private evaluateInstanceInitializer(
    declaration:Declaration,active:Set<string>,depth:number,
  ):ApexValue {
    const key=(declaration.owner+"."+declaration.field).toLowerCase();
    if(depth>=MAX_DEPTH||active.has(key))
      return unknown("Cyclic or oversized instance field initializer: "+key);
    active.add(key);
    try {
      const value=evaluateApexExpression(declaration.initializer,{
        values:new Map(),
        resolveCall:(method,args)=>{
          if(method!=="Apex.constant"||args.length!==1||
            args[0].kind!=="text"||args[0].values.length!==1)return undefined;
          return this.compute(args[0].values[0].toLowerCase(),active,depth+1);
        },
      });
      if(/^null$/i.test(declaration.initializer.trim()))
        return unknown("Apex instance field "+key+" has a null initializer.");
      if(value.kind==="unknown")return value;
      return value.kind==="text"&&value.values.length===1||
        value.kind==="number"&&Number.isFinite(value.value)?value:unknown(
          "Instance field "+key+" initializer is not a supported scalar.");
    }finally{active.delete(key);}
  }

  private compute(key:string,active:Set<string>,depth:number):ApexValue{
    const cached=this.cache.get(key);
    if(cached)return cached;
    if(active.has(key))return unknown("Cyclic Apex static initializer: "+key);
    if(depth>=MAX_DEPTH)return unknown("Apex static initializer dependency depth exceeded: "+key);
    const dot=key.lastIndexOf(".");
    if(dot<1)return unknown("Malformed Apex class-qualified constant: "+key);
    const className=key.slice(0,dot);
    const owners=this.classOwners.get(className);
    if(!owners?.size)return unknown(
      "Apex class "+className+" is missing from the indexed repository.");
    if(owners.size!==1)return unknown(
      "Apex class "+className+" has ambiguous repository definitions.");
    const entries=this.declarations.get(key)??[];
    if(entries.length!==1)return unknown(entries.length
      ?"Apex field "+key+" has ambiguous declarations."
      :"Apex field "+key+" has no supported static scalar initializer declaration.");
    const entry=entries[0];
    if(!entry.isStatic)
      return unknown("Apex member "+key+
        " is an instance field (not static); class-qualified references "+
        "cannot prove its value without a specific instance.");
    if(!entry.initializerPresent)
      return unknown("Apex static field "+key+
        " has no declaration initializer; static initialization is not proven.");
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
        if(localKey===key||!this.declarations.has(localKey))continue;
        values.set(localName,this.compute(localKey,active,depth+1));
      }
      result=evaluateApexExpression(entry.initializer,{
        values,
        resolveCall:(method,args)=>{
          if(method!=="Apex.constant"||args.length!==1||
            args[0].kind!=="text"||args[0].values.length!==1)return undefined;
          return this.compute(args[0].values[0].toLowerCase(),active,depth+1);
        },
      });
      if(/^null$/i.test(entry.initializer.trim()))
        result=unknown("Apex static field "+key+" has a null initializer.");
      if(result.kind==="text"&&result.values.length!==1)
        result=unknown("Static field "+key+" has multiple possible initializer values.");
      if(result.kind!=="text"&&result.kind!=="number"&&result.kind!=="unknown")
        result=unknown("Static field "+key+" does not have a proven scalar initializer.");
      if(result.kind==="number"&&!Number.isFinite(result.value))
        result=unknown("Static field "+key+" initializer is not finite.");
    }finally{active.delete(key);}
    this.cache.set(key,result);
    return result;
  }
}
