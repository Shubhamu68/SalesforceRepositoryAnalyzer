import path from "node:path";
import { ApexDataFlowEngine } from "./ApexDataFlowEngine.js";
import { indexApexMethods, maskApexSource, matchingPair, splitApexTopLevel,
  type IndexedApexMethod } from "./ApexSourceModel.js";
import { unknown, type ApexValue } from "./ApexValueEvaluator.js";
import { ApexStaticValueIndex } from "./ApexStaticValueIndex.js";

/** Shared repository evidence, independent of SOQL and persona permissions. */
export interface ApexRepositorySource {
  filePath: string;
  source: string;
}
interface IndexedSource extends ApexRepositorySource {
  className: string;
  methods: IndexedApexMethod[];
}
interface IndexedMethod {
  owner: IndexedSource;
  method: IndexedApexMethod;
}
interface Caller {
  caller: IndexedSource;
  method: IndexedApexMethod;
  offset: number;
  expressions: string[];
}
export interface ApexCallerEvidence {
  knownCalls: number;
  unknownCalls: number;
  candidateCalls: number;
  /** Public/protected/global methods remain open to callers outside this repo. */
  externallyCallable: boolean;
}
const MAX_METHOD_DEPTH = 6;
const MAX_CALL_CONTEXTS = 64;
const MAX_CACHED_SUMMARIES = 1024;

/**
 * Immutable, repository-scoped class/method/caller index.
 * Explicit ClassName.method(...) calls only: never infer polymorphic dispatch,
 * dynamic strings, package-external code, UI inputs, or inaccessible methods.
 *
 * Summaries are cached per analysis resolver identity and argument values.
 * All unknown or unbounded paths fail closed.
 */
export class ApexRepositoryMethodIndex {
  private readonly classes=new Map<string,IndexedSource[]>();
  private readonly callers=new Map<string,Caller[]>();
  private readonly paths=new Map<string,IndexedSource>();
  private readonly staticValues:ApexStaticValueIndex;
  private readonly callerEvidence=new Map<string,ApexCallerEvidence>();
  private readonly privateContexts=new Map<string,ApexValue[][] | null>();
  private readonly privateContextStack=new Set<string>();
  private readonly active=new Set<string>();
  private readonly summaries=new Map<string,ApexValue>();
  private readonly scopes=new WeakMap<Function,number>();
  private nextScope=1;

  constructor(files:readonly ApexRepositorySource[]) {
    this.staticValues=new ApexStaticValueIndex(files);
    const indexed:IndexedSource[]=[];
    for(const file of files) {
      const masked=maskApexSource(file.source);
      const className=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked)?.[1] ??
        path.basename(file.filePath).replace(/\.cls$/i,"");
      const owner={...file,className,methods:indexApexMethods(file.source)};
      const key=className.toLowerCase();
      this.classes.set(key,[...(this.classes.get(key)??[]),owner]);
      indexed.push(owner);
      this.paths.set(path.resolve(file.filePath),owner);

    }
    for(const owner of indexed) {
      const masked=maskApexSource(owner.source);
      const expression=/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
      let match:RegExpExecArray|null;
      while((match=expression.exec(masked))!==null) {
        const candidate=this.classes.get(match[1].toLowerCase());
        if(!candidate || candidate.length!==1)continue;
        // Class-qualified calls cannot be nested under an instance/member.
        if(/\.\s*$/.test(masked.slice(Math.max(0,match.index-3),match.index)))continue;
        const opening=masked.indexOf("(",match.index);
        const close=matchingPair(masked,opening);
        if(close<0)continue;
        const sourceMethods=owner.methods.filter(m=>m.start<=match!.index&&match!.index<m.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start));
        if(!sourceMethods.length)continue;
        const expressions=owner.source.slice(opening+1,close).trim();
        const args=expressions?splitApexTopLevel(expressions,","):[];
        const key=this.methodKey(candidate[0].className,match[2],args.length);
        const callers=this.callers.get(key)??[];
        callers.push({caller:owner,method:sourceMethods[0],offset:match.index,expressions:args});
        this.callers.set(key,callers);
      }
    }
  }

  /** Source-backed scalar initializers; unresolved/mutable values fail closed. */
  evaluateConstant(name:string):ApexValue|undefined {
    const cls=name.split(".")[0];
    if(!this.staticValues.hasClass(cls) && /^[a-z]/.test(cls))return undefined;
    return this.staticValues.resolve(name);
  }

  private methodKey(cls:string,name:string,arity:number):string {
    return cls.toLowerCase()+"|"+name.toLowerCase()+"|"+arity;
  }

  private findMethods(cls:string,name:string,arity:number):IndexedMethod[] {
    return (this.classes.get(cls.toLowerCase())??[]).flatMap(owner=>
      owner.methods.filter(method=>method.name.toLowerCase()===name.toLowerCase() &&
        method.parameters.length===arity).map(method=>({owner,method})));
  }

  private scopeId(resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined):number {
    if(!resolveExternal)return 0;
    const previous=this.scopes.get(resolveExternal);
    if(previous)return previous;
    const id=this.nextScope++;
    this.scopes.set(resolveExternal,id);
    return id;
  }

  /**
   * A complete cross-class helper return is safe to inline only when its
   * declared body, parameters and all feasible return values are proven.
   */
  evaluateReturn(fromFilePath:string,name:string,args:ApexValue[],
    resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined):ApexValue|undefined {
    const match=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(name.trim());
    if(!match)return undefined;
    const [,cls,methodName]=match;
    const owners=this.classes.get(cls.toLowerCase());
    if(!owners)return undefined;
    const matches=this.findMethods(cls,methodName,args.length);
    if(matches.length!==1)return unknown("Ambiguous or missing indexed Apex method: "+name);
    const {owner,method}=matches[0];
    const crossClass=path.resolve(fromFilePath)!==path.resolve(owner.filePath);
    if(crossClass && (method.visibility==="private" || method.visibility==="unspecified"))
      return unknown("Cross-class Apex method is not provably accessible: "+name);
    const id=owner.filePath+"|"+method.start+"|"+JSON.stringify(args)+"|"+
      this.scopeId(resolveExternal);
    if(this.active.has(id))return unknown("Recursive repository helper call: "+name);
    if(this.active.size>=MAX_METHOD_DEPTH)return unknown("Cross-class helper depth exceeded: "+name);
    const cached=this.summaries.get(id);
    if(cached)return cached;
    this.active.add(id);
    let result:ApexValue;
    try {
      const engine=new ApexDataFlowEngine(owner.source,{
        resolveExternal:(nestedName,nestedArgs)=>resolveExternal?.(nestedName,nestedArgs) ??
          this.evaluateReturn(owner.filePath,nestedName,nestedArgs,resolveExternal),
      });
      result=engine.summarizeMethodReturn(method,args);
    }finally{this.active.delete(id);}
    if(this.summaries.size>=MAX_CACHED_SUMMARIES)this.summaries.clear();
    this.summaries.set(id,result);
    return result;
  }

  /**
   * Exhaustive private-method argument tracing. Unlike the public caller
   * provenance index, this can narrow an execution site: Apex private methods
   * cannot be called by other classes. Every syntactically possible local
   * invocation must have a complete, bounded argument context.
   *
   * Public callers with known local constants are accepted; runtime method
   * parameters, unsupported invocation locations and missing dispatch proof
   * invalidate the entire closure. Never union unknown and known paths.
   */
  resolvePrivateContexts(filePath:string,target:IndexedApexMethod,
    resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined
  ):ApexValue[][]|undefined {
    if(target.visibility!=="private")return undefined;
    const owner=this.paths.get(path.resolve(filePath));
    if(!owner || !owner.methods.some(method=>method.start===target.start))return undefined;
    const cacheKey=owner.filePath+"|"+target.start+"|"+this.scopeId(resolveExternal);
    if(this.privateContexts.has(cacheKey))
      return this.privateContexts.get(cacheKey)??undefined;
    if(this.privateContextStack.has(cacheKey) ||
        this.privateContextStack.size>=MAX_METHOD_DEPTH)return undefined;
    this.privateContextStack.add(cacheKey);
    let proven:ApexValue[][]|undefined;
    try {
      const masked=maskApexSource(owner.source);
      const pattern=new RegExp("\\b"+target.name+"\\s*\\(","g");
      const contexts:ApexValue[][]=[];
      let callCount=0;
      let failed=false;
      let match:RegExpExecArray|null;
      while((match=pattern.exec(masked))!==null){
        const opening=masked.indexOf("(",match.index);
        const closing=matchingPair(masked,opening);
        if(closing<0){failed=true;break;}
        const following=masked.slice(closing+1).match(/^\s*([\s\S]?)/)?.[1];
        const containing=owner.methods.filter(method=>
          method.start<=match!.index&&match!.index<method.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
        if(!containing){
          // Declaration, not invocation. A class-level initializer is an
          // unknown invocation context and must not be silently skipped.
          if(following==="{")continue;
          failed=true;break;
        }
        const prior=masked.slice(Math.max(0,match.index-80),match.index);
        if(/\.\s*$/.test(prior)){
          const receiver=/\b([A-Za-z_]\w*)\.\s*$/.exec(prior)?.[1];
          if(receiver!=="this"&&receiver?.toLowerCase()!==owner.className.toLowerCase()){
            failed=true;break;
          }
        }
        const argumentText=owner.source.slice(opening+1,closing);
        const expressions=argumentText.trim()?splitApexTopLevel(argumentText,","):[];
        if(expressions.length!==target.parameters.length){
          // Another overload with a different arity is not this method.
          continue;
        }
        const overloads=owner.methods.filter(method=>
          method.name.toLowerCase()===target.name.toLowerCase()&&
          method.parameters.length===expressions.length);
        if(overloads.length!==1||containing===target){failed=true;break;}
        callCount++;
        const callerContexts=containing.visibility==="private"
          ?this.resolvePrivateContexts(owner.filePath,containing,resolveExternal)
          :undefined;
        // A private caller with unproven inputs is not a closed context.
        if(containing.visibility==="private"&&!callerContexts?.length){
          failed=true;break;
        }
        const seeds=callerContexts?.length?callerContexts:[undefined];
        for(const seed of seeds){
          const engine=new ApexDataFlowEngine(owner.source,{
            resolveExternal:(name,args)=>resolveExternal?.(name,args) ??
              this.evaluateReturn(owner.filePath,name,args,resolveExternal),
          });
          const values=engine.evaluateArgumentsAt(containing,match.index,expressions,seed);
          if(!values.length || values.some(args=>
            args.length!==target.parameters.length||
            args.some(value=>value.kind==="unknown"))){
            failed=true;break;
          }
          contexts.push(...values);
          if(contexts.length>MAX_CALL_CONTEXTS){failed=true;break;}
        }
        if(failed)break;
      }
      if(!failed&&callCount>0&&contexts.length>0){
        const distinct=new Map(contexts.map(args=>[JSON.stringify(args),args]));
        if(distinct.size<=MAX_CALL_CONTEXTS)proven=[...distinct.values()];
      }
    }finally{
      this.privateContextStack.delete(cacheKey);
    }
    if(this.privateContexts.size>=MAX_CACHED_SUMMARIES)this.privateContexts.clear();
    this.privateContexts.set(cacheKey,proven??null);
    return proven;
  }

  /** Identify the declaring method of an execution site, without guessing dispatch. */
  methodAt(filePath:string,offset:number):{
    className:string; methodName:string; arity:number;
    visibility:IndexedApexMethod["visibility"];
  }|undefined {
    const source=this.paths.get(path.resolve(filePath));
    if(!source)return undefined;
    const owner=source.methods.filter(method=>method.start<=offset&&offset<method.end)
      .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    return owner?{className:source.className,methodName:owner.name,
      arity:owner.parameters.length,visibility:owner.visibility}:undefined;
  }

  /**
   * Probe actual repository callers in their lexical method context.
   * This is evidence for diagnostics, NOT proof that public methods have no
   * additional callers in the org, in dynamic dispatch or outside the repo.
   */
  inspectCallers(cls:string,methodName:string,arity:number):ApexCallerEvidence {
    const key=this.methodKey(cls,methodName,arity);
    const cached=this.callerEvidence.get(key);
    if(cached)return cached;
    const methods=this.findMethods(cls,methodName,arity);
    const externallyCallable=methods.length!==1 ||
      methods[0].method.visibility!=="private";
    const candidates=this.callers.get(this.methodKey(cls,methodName,arity))??[];
    if(candidates.length>MAX_CALL_CONTEXTS)
      return {knownCalls:0,unknownCalls:candidates.length,
        candidateCalls:candidates.length,externallyCallable};
    let knownCalls=0,unknownCalls=0;
    for(const call of candidates) {
      const privateInputs=call.method.visibility==="private"
        ?this.resolvePrivateContexts(call.caller.filePath,call.method):undefined;
      if(call.method.visibility==="private" && !privateInputs?.length){
        unknownCalls++;
        continue;
      }
      const seeds=privateInputs?.length?privateInputs:[undefined];
      let allKnown=true;
      for(const seed of seeds){
        const engine=new ApexDataFlowEngine(call.caller.source,{
          resolveExternal:(name,args)=>this.evaluateReturn(call.caller.filePath,name,args),
        });
        const contexts=engine.evaluateArgumentsAt(call.method,call.offset,call.expressions,seed);
        if(!contexts.length||contexts.some(args=>
          args.length!==arity||args.some(value=>value.kind==="unknown"))){
          allKnown=false;
          break;
        }
      }
      if(allKnown)knownCalls++;else unknownCalls++;
    }
    const result={knownCalls,unknownCalls,candidateCalls:candidates.length,
      externallyCallable};
    this.callerEvidence.set(key,result);
    return result;
  }
}
