import path from "node:path";
import {evaluateApexExpression, unknown, type ApexValue} from "./ApexValueEvaluator.js";
import {maskApexSource} from "./ApexSourceModel.js";

export interface ApexStaticSource {filePath:string;source:string;}
interface Declaration {
  owner:string;
  field:string;
  initializer:string;
  type:string;
  visibility:"private"|"public"|"global"|"protected"|"unspecified";
  isFinal:boolean;
  isMutablePrivate:boolean;
  unsafeWrite:boolean;
}
const identifier=/^[A-Za-z_]\w*$/;
const MAX_CONSTANTS=10000;
const MAX_DEPTH=24;

/**
 * Repository-wide source proof of Apex scalar static initializers.
 *
 * Public/protected/global non-final static fields may change in any Apex
 * entry point. Only final fields and private fields without writes qualify.
 * Cross-class dependencies and cycles are evaluated recursively and bounded.
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
      const declaration=/\b((?:(?:public|private|protected|global|static|final|transient)\s+)+)(String|Integer|Long|Decimal|Double|Boolean|Id)\s+([A-Za-z_]\w*)\s*=/g;
      let hit:RegExpExecArray|null;
      while((hit=declaration.exec(masked))!==null){
        if(depth[hit.index]!==1)continue;
        const modifiers=hit[1].trim().split(/\s+/).map(s=>s.toLowerCase());
        if(!modifiers.includes("static")||total++>MAX_CONSTANTS)continue;
        const field=hit[3];
        if(!identifier.test(field))continue;
        const begin=hit.index+hit[0].length;
        const semi=masked.indexOf(";",begin);
        if(semi<0||depth[semi]!==1)continue;
        const expr=file.source.slice(begin,semi).trim();
        if(!expr||expr.length>4000)continue;
        const visibility=modifiers.includes("private")?"private":
          modifiers.includes("global")?"global":
          modifiers.includes("protected")?"protected":
          modifiers.includes("public")?"public":"unspecified";
        const isFinal=modifiers.includes("final");
        const privateCandidate=!isFinal&&visibility==="private";
        const rest=masked.slice(semi+1);
        const escaped=field.replace(/[.*+?^$()|[\]{}\\]/g,"\\$&");
        const write=new RegExp("\\b"+escaped+
          "\\s*(?:(?:\\+\\+|--|(?:[+\\-*\\/%&|^])?=(?!=)))","m");
        const pre=masked.slice(classBrace+1,hit.index);
        const unsafeWrite=privateCandidate&&(write.test(pre)||write.test(rest));
        const entry:Declaration={
          owner,field,initializer:expr,type:hit[2],visibility,isFinal,
          isMutablePrivate:privateCandidate,unsafeWrite,
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
    if(!entry.isFinal && !entry.isMutablePrivate)
      return unknown("Apex static field "+key+
        " is externally mutable (not final); its initializer is not a proven runtime value.");
    if(entry.unsafeWrite)
      return unknown("Private Apex static field "+key+
        " is assigned after initialization; it is not a proven constant.");
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
