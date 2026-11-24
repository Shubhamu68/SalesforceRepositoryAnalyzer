import path from "node:path";
import { ApexDataFlowEngine } from "./ApexDataFlowEngine.js";
import { indexApexMethods, maskApexSource, matchingPair, splitApexTopLevel,
  type IndexedApexMethod } from "./ApexSourceModel.js";
import { unknown, type ApexValue } from "./ApexValueEvaluator.js";
import {ApexInstanceIndex} from "./ApexInstanceModel.js";
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
export interface ApexCallerContexts {
  readonly known:ApexValue[][];
  readonly unknownCalls:number;
  readonly candidateCalls:number;
  readonly externallyCallable:boolean;
  readonly bounded:boolean;
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
  private readonly instances:ApexInstanceIndex;
  private readonly callerEvidence=new Map<string,ApexCallerEvidence>();
  private readonly contextualEvidence=new Map<string,ApexCallerContexts>();
  private readonly privateContexts=new Map<string,ApexValue[][] | null>();
  private readonly privateContextStack=new Set<string>();
  private readonly active=new Set<string>();
  private readonly summaries=new Map<string,ApexValue>();
  private readonly scopes=new WeakMap<Function,number>();
  private nextScope=1;

  constructor(files:readonly ApexRepositorySource[]) {
    this.staticValues=new ApexStaticValueIndex(files);
    this.instances=new ApexInstanceIndex(files);
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
      const expression=/\b([A-Za-z_]\w*)(?:\s*\.\s*([A-Za-z_]\w*))?\s*\(/g;
      let match:RegExpExecArray|null;
      while((match=expression.exec(masked))!==null) {
        if(/\.\s*$/.test(masked.slice(Math.max(0,match.index-12),match.index)))continue;
        const receiver=match[2]?match[1]:undefined;
        const name=match[2]??match[1];
        if(!match[2]&&/\bnew\s*$/i.test(masked.slice(Math.max(0,match.index-20),match.index)))continue;
        const candidate=receiver&&receiver.toLowerCase()!=="this"
          ?this.classes.get(receiver.toLowerCase()):[owner];
        if(!candidate||candidate.length!==1)continue;
        const opening=masked.indexOf("(",match.index);
        const close=matchingPair(masked,opening);
        if(close<0)continue;
        const sourceMethods=owner.methods.filter(m=>m.start<=match!.index&&match!.index<m.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start));
        if(!sourceMethods.length)continue;
        // If a class qualifier also appears as a variable/parameter name,
        // dispatch is ambiguous. Err on the side of omitting the evidence.
        if(receiver&&receiver.toLowerCase()!=="this"){
          const shadow=new RegExp("\\b[A-Za-z_]\\w*(?:\\s*<[\\w\\s,.<>]+>)?(?:\\[\\])?\\s+"+receiver+"\\s*(?:[=;,)\\[])", "i");
          if(shadow.test(masked))continue;
        }
        const expressions=owner.source.slice(opening+1,close).trim();
        const args=expressions?splitApexTopLevel(expressions,","):[];
        const key=this.methodKey(candidate[0].className,name,args.length);
        const targets=this.findMethods(candidate[0].className,name,args.length);
        if(targets.length!==1)continue;
        const callers=this.callers.get(key)??[];
        callers.push({caller:owner,method:sourceMethods[0],offset:match.index,expressions:args});
        this.callers.set(key,callers);
      }
    }
  }

  constructInstance(filePath:string,name:string,args:ApexValue[],resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined):ApexValue|undefined{
    return this.instances.construct(name,args,filePath,resolveExternal);
  }

  /** Source-backed scalar initializers; unresolved/mutable values fail closed. */
  evaluateConstant(name:string,metadata?: (name:string,args:ApexValue[])=>ApexValue|undefined):ApexValue|undefined {
    const cls=name.split(".")[0];
    if(!this.staticValues.hasClass(cls) && /^[a-z]/.test(cls))return undefined;
    return this.staticValues.resolve(name,metadata);
  }

  /** Resolve an unqualified static/instance member using its actual owner. */
  evaluateScopeField(owner:string,field:string,mode:"this"|"unqualified",
    inStaticMethod:boolean,metadata?: (name:string,args:ApexValue[])=>ApexValue|undefined):ApexValue|undefined {
    if(!this.staticValues.hasClass(owner))return undefined;
    if(mode==="this"){
      return inStaticMethod?unknown("Cannot read this."+field+" inside a static method."):
        this.staticValues.resolveInstance(owner,field,metadata);
    }
    return this.staticValues.resolveUnqualified(owner,field,inStaticMethod,metadata);
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
      if(result.kind==="instance")result=unknown("Instance-return alias transfer is not yet proven.");
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
   * Bounded incoming argument propagation across explicit indexed calls.
   * Known contexts are evidence only for externally callable methods.
   * Keep the unknown external entry seed even when every repository caller
   * happens to pass literal values. Do not narrow open dispatch to known calls.
   */
  resolveCallerContexts(filePath:string,target:IndexedApexMethod,
    resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined,
    stack:ReadonlySet<string>=new Set(),work={remaining:64}):ApexCallerContexts {
    const owner=this.paths.get(path.resolve(filePath));
    const empty:ApexCallerContexts={known:[],unknownCalls:0,candidateCalls:0,
      externallyCallable:target.visibility!=="private",bounded:false};
    if(!owner)return empty;
    const key=owner.filePath+"|"+target.start+"|"+this.scopeId(resolveExternal);
    const cached=this.contextualEvidence.get(key);
    if(cached)return cached;
    if(stack.has(key)||stack.size>=MAX_METHOD_DEPTH||work.remaining<=0)return {...empty,bounded:true};
    const nextStack=new Set(stack);nextStack.add(key);
    const candidates=this.callers.get(this.methodKey(owner.className,target.name,target.parameters.length))??[];
    if(candidates.length>MAX_CALL_CONTEXTS||
      this.findMethods(owner.className,target.name,target.parameters.length).length!==1)
      return {...empty,candidateCalls:candidates.length,unknownCalls:candidates.length,bounded:true};
    const known=new Map<string,ApexValue[]>();
    let unknownCalls=0,bounded=false;
    for(const call of candidates){
      // A variable shadowing a class name or an instance-qualified call
      // cannot establish static dispatch. Only explicit static targets qualify.
      if(!target.isStatic){unknownCalls++;continue;}
      const closed=call.method.visibility==="private"
        ?this.resolvePrivateContexts(call.caller.filePath,call.method,resolveExternal):undefined;
      const upstream=closed?.length?undefined:
        this.resolveCallerContexts(call.caller.filePath,call.method,resolveExternal,nextStack,work);
      const seeds:(ApexValue[]|undefined)[]=closed?.length?closed:
        [undefined,...(upstream?.known??[])];
      let unproven=false;
      for(const seed of seeds){
        if(work.remaining--<=0){bounded=true;break;}
        const engine=new ApexDataFlowEngine(call.caller.source,{maxOperations:2000,
          resolveExternal:(name,args)=>resolveExternal?.(name,args) ??
            this.evaluateReturn(call.caller.filePath,name,args,resolveExternal),
        });
        const contexts=engine.evaluateArgumentsAt(call.method,call.offset,call.expressions,seed);
        for(const args of contexts){
          if(args.length!==target.parameters.length||args.some(v=>v.kind==="unknown")){
            unproven=true;continue;
          }
          known.set(JSON.stringify(args),args);
          if(known.size>=MAX_CALL_CONTEXTS){bounded=true;break;}
        }
        if(bounded)break;
      }
      if(unproven||upstream?.bounded)unknownCalls++;
      if(bounded)break;
    }
    const result:ApexCallerContexts={known:[...known.values()],unknownCalls,
      candidateCalls:candidates.length,externallyCallable:target.visibility!=="private",bounded};
    // Recursive calls can encounter a shallower cycle/budget cut. Cache only
    // root results; never persist an incomplete nested traversal as exhaustive.
    if(stack.size===0){
      if(this.contextualEvidence.size>=MAX_CACHED_SUMMARIES)this.contextualEvidence.clear();
      this.contextualEvidence.set(key,result);
    }
    return result;
  }

  /** Evaluate selected invocation arguments in proven incoming contexts.
   * Evidence is kept separate from the all-path verdict and from permissions. */
  probeInvocationContexts(filePath:string,offset:number,expressions:readonly string[],
    resolveExternal?: (name:string,args:ApexValue[])=>ApexValue|undefined):{
      contexts:ApexCallerContexts;arguments:ApexValue[][];bounded:boolean
    }|undefined {
    const owner=this.paths.get(path.resolve(filePath));
    const method=owner?.methods.filter(m=>m.start<=offset&&offset<m.end)
      .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    if(!owner||!method||!method.parameters.length)return undefined;
    const contexts=this.resolveCallerContexts(filePath,method,resolveExternal);
    const argumentsByValue=new Map<string,ApexValue[]>();
    const maxSeeds=8;
    let bounded=contexts.bounded||contexts.known.length>maxSeeds;
    for(const seed of contexts.known.slice(0,maxSeeds)){
      const engine=new ApexDataFlowEngine(owner.source,{maxOperations:2000,
        resolveExternal:(name,args)=>resolveExternal?.(name,args) ??
          this.evaluateReturn(owner.filePath,name,args,resolveExternal)});
      for(const args of engine.evaluateArgumentsAt(method,offset,expressions,seed)){
        if(args.some(v=>v.kind==="unknown"))continue;
        argumentsByValue.set(JSON.stringify(args),args);
      }
    }
    return {contexts,arguments:[...argumentsByValue.values()],bounded};
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
