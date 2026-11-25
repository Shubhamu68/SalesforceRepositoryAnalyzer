import {isLiteralMapFactory} from "./ApexPureFactory.js";
import {supportsReceiverPrefix,receiverMapSamples,supportsInitialBatchExecute} from "./ApexFrameworkReceiver.js";
import {outerApexClass} from "./ApexClassModel.js";
import path from "node:path";
import {countApex,timeApex} from "./ApexPerformance.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType,selectApexOverload,type ApexArgumentTypes,type ApexCallResolver} from "./ApexTypeSystem.js";
import { ApexDataFlowEngine } from "./ApexDataFlowEngine.js";
import {memberEffectModel} from "./ApexMemberEffectModel.js";
import { ApexRepositorySyntaxInventory, maskApexSource, matchingPair, splitApexTopLevel,
  type IndexedApexMethod } from "./ApexSourceModel.js";
import { unknown, runtimeParameter, type ApexValue } from "./ApexValueEvaluator.js";
import {ApexInstanceIndex} from "./ApexInstanceModel.js";
import { ApexStaticValueIndex } from "./ApexStaticValueIndex.js";
import {discoverApexInvocations} from "./ApexInvocationModel.js";
import {apexStateIdentity} from "./ApexStateIdentity.js";
import {invocationRelevantIdentifiers} from "./ApexDependencySlice.js";

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
  targetStart?:number;
}
export interface ApexCallerContexts {
  readonly known:ApexValue[][];
  /** Explicit caller contexts with at least one known and one unknown input. */
  readonly partial:ApexValue[][];
  readonly unknownCalls:number;
  readonly candidateCalls:number;
  readonly externallyCallable:boolean;
  readonly bounded:boolean;
  /** Samples under an explicit direct framework entry, never a closed context. */
  readonly freshEntryContexts?:number;
}
export interface ApexCallerEvidence {
  knownCalls: number;
  unknownCalls: number;
  candidateCalls: number;
  /** Public/protected/global methods remain open to callers outside this repo. */
  externallyCallable: boolean;
}
/** Canonical argument-vector identity includes aliases, not only JSON content. */
function argumentIdentity(args:readonly ApexValue[]):string{
  return apexStateIdentity(new Map(args.map((value,i)=>[String(i),value])),false);
}
/**
 * Prioritize concrete query-relevant inputs and diverse projected values.
 * Projection is only a scheduling heuristic: never a coverage proof.
 * Keep full original contexts, including alias identity and unknown provenance.
 */
export function selectApexCallerSeeds(seeds:readonly ApexValue[][],parameters:readonly string[],
  relevant:ReadonlySet<string>,limit:number):ApexValue[][]{
  if(limit<=0)return [];
  if(seeds.length<=limit)return [...seeds];
  const indices=parameters.map((p,i)=>relevant.has(p.toLowerCase())?i:-1).filter(i=>i>=0);
  if(!indices.length)return seeds.slice(0,limit);
  const ranked=seeds.map((seed,order)=>{
    const projection=indices.map(i=>seed[i]??unknown("Missing argument."));
    // Unknown provenance text is not a useful diversity signal. This only
    // groups candidates for selection; original values remain untouched.
    const group=argumentIdentity(projection.map(value=>value.kind==="unknown"
      ?unknown("Unproven projected argument."):value));
    return {seed,order,group,known:projection.filter(v=>v.kind!=="unknown").length};
  }).sort((a,b)=>b.known-a.known||a.order-b.order);
  const groups=new Map<string,typeof ranked>();
  for(const candidate of ranked){
    const group=groups.get(candidate.group)??[];group.push(candidate);groups.set(candidate.group,group);
  }
  const selected:ApexValue[][]=[];
  // First take a representative from each distinct projection, then allow
  // additional candidates from those groups if there is remaining budget.
  for(let round=0;selected.length<limit;round++){
    let added=false;
    for(const group of groups.values()){
      if(!group[round])continue;
      selected.push(group[round].seed);added=true;
      if(selected.length>=limit)break;
    }
    if(!added)break;
  }
  return selected;
}
const MAX_METHOD_DEPTH = 6;
const MAX_CALL_CONTEXTS = 64;
const MAX_CACHED_SUMMARIES = 1024;
const MAX_RECEIVER_SNAPSHOTS = 32;
const BASE_RECEIVER_KEY_LIMIT = 32;
const BASE_RECEIVER_SAMPLE_LIMIT = 40;
const MAX_EXTRA_RECEIVER_SAMPLES = 32;
type BatchReceiver = Extract<ApexValue,{kind:"instance"}>;
interface ReceiverCallEdge {caller:IndexedApexMethod;target:IndexedApexMethod;offset:number;expressions:string[]}
interface BatchReceiverInventory {
  count:number;
  bounded:boolean;
  candidates:Array<{value:BatchReceiver;hypothetical:boolean}>;
}

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
  private readonly methodsByKey=new Map<string,IndexedMethod[]>();
  private readonly batchAllocations=new Map<string,Caller[]>();
  private readonly paths=new Map<string,IndexedSource>();
  private readonly staticValues:ApexStaticValueIndex;
  private readonly instances:ApexInstanceIndex;
  private readonly callerEvidence=new Map<string,ApexCallerEvidence>();
  private readonly contextualEvidence=new Map<string,ApexCallerContexts>();
  private readonly privateContexts=new Map<string,ApexValue[][] | null>();
  private readonly privateContextStack=new Set<string>();
  private readonly active=new Set<string>();
  private readonly summaries=new Map<string,ApexValue>();
  private readonly argumentProbes=new Map<string,ApexValue[][]>();
  private readonly batchReceiverInventories=new Map<string,BatchReceiverInventory>();
  private readonly scopes=new WeakMap<Function,number>();
  private nextScope=1;

  constructor(files:readonly ApexRepositorySource[]) {
    const syntax=new ApexRepositorySyntaxInventory();
    this.staticValues=new ApexStaticValueIndex(files,syntax);
    this.instances=new ApexInstanceIndex(files,syntax);
    const indexed:IndexedSource[]=[];
    for(const file of files) {
      const masked=syntax.masked(file.source);
      const className=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked)?.[1] ??
        path.basename(file.filePath).replace(/\.cls$/i,"");
      const owner={...file,className,methods:syntax.methods(file.source)};
      const key=className.toLowerCase();
      this.classes.set(key,[...(this.classes.get(key)??[]),owner]);
      indexed.push(owner);
      this.paths.set(path.resolve(file.filePath),owner);
      for(const method of owner.methods){
        const key=this.methodKey(className,method.name,method.parameters.length);
        const entries=this.methodsByKey.get(key)??[];entries.push({owner,method});this.methodsByKey.set(key,entries);
      }

    }
    for(const owner of indexed) {
      const masked=syntax.masked(owner.source);
      // Only direct framework dispatch of a newly allocated receiver. Calls
      // through a local alias, scheduler, platform or unknown receiver remain open.
      if(/\bDatabase\s*\.\s*executeBatch\s*\(/i.test(masked)&&!this.classes.has("database")&&!/\b[A-Za-z_]\w*\s+Database\s*(?:[=;,)])/i.test(masked)){
        const calls=discoverApexInvocations(owner.source,(name,args)=>
          /^Database\.executeBatch$/i.test(name)&&args.length>=1&&args.length<=2?{method:name,argumentIndices:[0]}:undefined);
        for(const site of calls){
          const allocation=/^\s*new\s+([A-Za-z_]\w*)\s*\(/i.exec(site.argument);
          const method=owner.methods.filter(m=>m.start<=site.offset&&site.offset<m.end)
            .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
          if(!method)continue;
          const type=allocation?.[1]??apexSymbols(owner.source,owner.methods).expressionType(method,site.argument,site.offset);
          if(!type||!/^[A-Za-z_]\w*$/.test(type))continue;
          const key=type.toLowerCase();
          const candidates=this.batchAllocations.get(key)??[];
          if(candidates.length<=MAX_CALL_CONTEXTS)candidates.push({caller:owner,method,offset:site.offset,expressions:[site.argument]});
          this.batchAllocations.set(key,candidates);
        }
      }
      const receiverShadows=new Map<string,boolean>();
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
        if(!candidate[0].methods.some(m=>m.name.toLowerCase()===name.toLowerCase()))continue;
        const opening=masked.indexOf("(",match.index);
        const close=matchingPair(masked,opening);
        if(close<0)continue;
        const sourceMethods=owner.methods.filter(m=>m.start<=match!.index&&match!.index<m.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start));
        if(!sourceMethods.length)continue;
        // If a class qualifier also appears as a variable/parameter name,
        // dispatch is ambiguous. Err on the side of omitting the evidence.
        if(receiver&&receiver.toLowerCase()!=="this"){
          const receiverKey=receiver.toLowerCase();
          let ambiguous=receiverShadows.get(receiverKey);
          if(ambiguous===undefined){
            const shadow=new RegExp("\\b[A-Za-z_]\\w*(?:\\s*<[\\w\\s,.<>]+>)?(?:\\[\\])?\\s+"+receiver+"\\s*(?:[=;,)\\[])", "i");
            ambiguous=shadow.test(masked);receiverShadows.set(receiverKey,ambiguous);
          }
          if(ambiguous)continue;
        }
        const expressions=owner.source.slice(opening+1,close).trim();
        const args=expressions?splitApexTopLevel(expressions,","):[];
        const key=this.methodKey(candidate[0].className,name,args.length);
        const targets=this.findMethods(candidate[0].className,name,args.length);
        if(!targets.length)continue;
        const chosen=selectApexOverload(targets.map(t=>t.method),args.length,targets.length>1?apexSymbols(owner.source,owner.methods).argumentTypes(sourceMethods[0],args,match.index):undefined);
        const callers=this.callers.get(key)??[];
        callers.push({caller:owner,method:sourceMethods[0],offset:match.index,expressions:args,targetStart:chosen?.start});
        this.callers.set(key,callers);
      }
    }
    syntax.clear();
  }

  indexedMethods(filePath:string,source:string):IndexedApexMethod[]|undefined{
    const owner=this.paths.get(path.resolve(filePath));
    return owner?.source===source?owner.methods:undefined;
  }

  constructInstance(filePath:string,name:string,args:ApexValue[],resolveExternal?: ApexCallResolver,types?:ApexArgumentTypes,normalScenario=false):ApexValue|undefined{
    const resolver:ApexCallResolver=(method,inputs,hints)=>{
      if(method==="Apex.constructorFactory"&&inputs[0]?.kind==="text"&&inputs[0].values.length===1){
        const qualified=inputs[0].values[0];
        const match=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(qualified);
        if(!match)return undefined;
        const methods=this.findMethods(match[1],match[2],inputs.length-1);
        if(methods.length!==1||!isLiteralMapFactory(methods[0].method))return undefined;
        const result=this.evaluateReturn(filePath,qualified,inputs.slice(1),resolveExternal,hints?.slice(1));
        return result?.kind==="map"?result:undefined;
      }
      return resolveExternal?.(method,inputs,hints);
    };
    return this.instances.construct(name,args,filePath,resolver,types,normalScenario);
  }

  /** Source-backed scalar initializers; unresolved/mutable values fail closed. */
  evaluateConstant(name:string,metadata?: ApexCallResolver):ApexValue|undefined {
    const cls=name.split(".")[0];
    if(!this.staticValues.hasClass(cls) && /^[a-z]/.test(cls))return undefined;
    return this.staticValues.resolve(name,metadata);
  }

  /** Resolve only a source-proven lazy getter, not its uninitialized backing field. */
  evaluateLazyGetter(owner:string,method:string):ApexValue|undefined{
    return this.staticValues.resolveLazyGetter(owner,method);
  }

  /** Resolve an unqualified static/instance member using its actual owner. */
  evaluateScopeField(owner:string,field:string,mode:"this"|"unqualified",
    inStaticMethod:boolean,metadata?: ApexCallResolver):ApexValue|undefined {
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
    return (this.methodsByKey.get(this.methodKey(cls,name,arity))??[]).filter(entry=>apexSymbols(entry.owner.source,entry.owner.methods).ownerAt(entry.method.start)?.toLowerCase()===cls.toLowerCase());
  }

  private scopeId(resolveExternal?: ApexCallResolver):number {
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
    resolveExternal?: ApexCallResolver,types?:ApexArgumentTypes):ApexValue|undefined {
    const match=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(name.trim());
    if(!match)return undefined;
    const [,cls,methodName]=match;
    const owners=this.classes.get(cls.toLowerCase());
    if(!owners)return undefined;
    const matches=this.findMethods(cls,methodName,args.length);
    const chosen=selectApexOverload(matches.map(m=>m.method),args.length,types);
    const selected=matches.find(m=>m.method===chosen);
    if(!selected||owners.length!==1)return unknown("Ambiguous or missing indexed Apex method: "+name);
    const {owner,method}=selected;
    const crossClass=path.resolve(fromFilePath)!==path.resolve(owner.filePath);
    if(crossClass && (method.visibility==="private" || method.visibility==="unspecified"))
      return unknown("Cross-class Apex method is not provably accessible: "+name);
    if(!method.isStatic)return unknown("Class-qualified helper is not proven static: "+name);
    if(!args.length){const lazy=this.evaluateLazyGetter(cls,methodName);if(lazy!==undefined)return lazy;}
    const id=owner.filePath+"|"+method.start+"|"+argumentIdentity(args)+"|"+
      this.scopeId(resolveExternal);
    if(this.active.has(id))return unknown("Recursive repository helper call: "+name);
    if(this.active.size>=MAX_METHOD_DEPTH)return unknown("Cross-class helper depth exceeded: "+name);
    const cacheable=args.every(v=>v.kind==="text"||v.kind==="number"||v.kind==="null"||v.kind==="unknown");
    const cached=cacheable?this.summaries.get(id):undefined;
    if(cached){countApex("helper.repository_cache_hit");return cached;}
    countApex("helper.repository_evaluations");
    this.active.add(id);
    let result:ApexValue;
    try {
      const engine=new ApexDataFlowEngine(owner.source,{sourceMethods:owner.methods,
        resolveExternal:(nestedName,nestedArgs,nestedTypes)=>{
          if(nestedName==="Apex.construct"&&nestedArgs[0]?.kind==="text"&&nestedArgs[0].values.length===1)
            return this.constructInstance(owner.filePath,nestedArgs[0].values[0],nestedArgs.slice(1),resolveExternal,nestedTypes?.slice(1));
          return resolveExternal?.(nestedName,nestedArgs,nestedTypes)??this.evaluateReturn(owner.filePath,nestedName,nestedArgs,resolveExternal,nestedTypes);
        },
      });
      result=timeApex("helper.repository_evaluation_ms",()=>engine.summarizeMethodReturn(method,args));
      if(result.kind==="instance"||result.kind==="instanceList")result=unknown("Instance-return alias transfer is not yet proven.");
    }finally{this.active.delete(id);}
    if(this.summaries.size>=MAX_CACHED_SUMMARIES)this.summaries.delete(this.summaries.keys().next().value!);
    if(cacheable&&(result.kind==="text"||result.kind==="number"||result.kind==="null"||result.kind==="unknown"))this.summaries.set(id,result);
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
    resolveExternal?: ApexCallResolver
  ):ApexValue[][]|undefined {
    if(target.visibility!=="private")return undefined;
    const owner=this.paths.get(path.resolve(filePath));
    if(!owner || !owner.methods.some(method=>method.start===target.start))return undefined;
    const symbols=apexSymbols(owner.source,owner.methods);
    if(symbols.ownerAt(target.start)?.toLowerCase()!==owner.className.toLowerCase())return undefined;
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
          symbols.sameOwner(target,method)&&method.name.toLowerCase()===target.name.toLowerCase()&&
          method.parameters.length===expressions.length);
        const selected=selectApexOverload(overloads,expressions.length,apexSymbols(owner.source,owner.methods).argumentTypes(containing,expressions,match.index));
        if(!selected){failed=true;break;}
        if(selected!==target)continue;
        if(containing===target){failed=true;break;}
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
          const engine=new ApexDataFlowEngine(owner.source,{sourceMethods:owner.methods,
            resolveExternal:(name,args,types)=>resolveExternal?.(name,args,types) ??
              this.evaluateReturn(owner.filePath,name,args,resolveExternal,types),
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
        const distinct=new Map(contexts.map(args=>[argumentIdentity(args),args]));
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

  /** Reuse complete scalar argument probes only in the same resolver scope.
   * No mutable reference results, failed probes or cross-pass metadata reuse. */
  private probeArguments(owner:IndexedSource,method:IndexedApexMethod,offset:number,expressions:readonly string[],seed:ApexValue[]|undefined,
    resolveExternal?: ApexCallResolver,freshEntry=false):ApexValue[][]{
    const scalar=(v:ApexValue)=>v.kind==="text"||v.kind==="number"||v.kind==="null";
    const eligible=!this.active.size&&(!seed||seed.every(v=>scalar(v)||v.kind==="unknown"));
    const key=eligible?JSON.stringify([owner.filePath,method.start,offset,expressions,seed?argumentIdentity(seed):null,this.scopeId(resolveExternal),freshEntry]):undefined;
    const cached=key?this.argumentProbes.get(key):undefined;
    if(cached){countApex("caller.probe_cache_hit");return cached.map(args=>[...args]);}
    const engine=new ApexDataFlowEngine(owner.source,{sourceMethods:owner.methods,maxOperations:2000,
      resolveExternal:(name,args,types)=>resolveExternal?.(name,args,types)??this.evaluateReturn(owner.filePath,name,args,resolveExternal,types)});
    const values=engine.evaluateArgumentsAt(method,offset,expressions,seed,freshEntry);
    if(key&&values.length&&values.every(args=>args.every(scalar))){
      if(this.argumentProbes.size>=MAX_CACHED_SUMMARIES)this.argumentProbes.delete(this.argumentProbes.keys().next().value!);
      this.argumentProbes.set(key,values.map(args=>[...args]));
    }
    return values;
  }

  /**
   * Bounded incoming argument propagation across explicit indexed calls.
   * Known contexts are evidence only for externally callable methods.
   * Keep the unknown external entry seed even when every repository caller
   * happens to pass literal values. Do not narrow open dispatch to known calls.
   */
  resolveCallerContexts(filePath:string,target:IndexedApexMethod,
    resolveExternal?: ApexCallResolver,
    stack:ReadonlySet<string>=new Set(),work={remaining:64}):ApexCallerContexts {
    const owner=this.paths.get(path.resolve(filePath));
    const empty:ApexCallerContexts={known:[],partial:[],unknownCalls:0,candidateCalls:0,
      externallyCallable:target.visibility!=="private",bounded:false};
    if(!owner)return empty;
    const key=owner.filePath+"|"+target.start+"|"+this.scopeId(resolveExternal);
    const cached=this.contextualEvidence.get(key);
    if(cached){countApex("caller.context_cache_hit");return cached;}
    countApex("caller.context_evaluations");
    if(stack.has(key)||stack.size>=MAX_METHOD_DEPTH||work.remaining<=0)return {...empty,bounded:true};
    const nextStack=new Set(stack);nextStack.add(key);
    const candidates=(this.callers.get(this.methodKey(owner.className,target.name,target.parameters.length))??[]).filter(c=>c.targetStart===undefined||c.targetStart===target.start);
    if(candidates.length>MAX_CALL_CONTEXTS)
      return {...empty,candidateCalls:candidates.length,unknownCalls:candidates.length,bounded:true};
    const known=new Map<string,ApexValue[]>();
    const partial=new Map<string,ApexValue[]>();
    let unknownCalls=0,bounded=false,inheritedBounded=false,freshEntryContexts=0;
    for(const call of candidates){
      // A variable shadowing a class name or an instance-qualified call
      // cannot establish static dispatch. Only explicit static targets qualify.
      if(!target.isStatic||call.targetStart!==target.start){unknownCalls++;continue;}
      const closed=call.method.visibility==="private"
        ?this.resolvePrivateContexts(call.caller.filePath,call.method,resolveExternal):undefined;
      const upstream=closed?.length?undefined:
        this.resolveCallerContexts(call.caller.filePath,call.method,resolveExternal,nextStack,work);
      const seeds:(ApexValue[]|undefined)[]=closed?.length?closed:
        [undefined,...(upstream?.known??[]),...(upstream?.partial??[])];
      // Repeated caller argument vectors from different hops need only one
      // evaluation, while distinct reference alias topologies stay distinct.
      const uniqueSeeds=[...new Map(seeds.map(seed=>[seed?argumentIdentity(seed):"runtime-entry",seed])).values()];
      if(upstream?.bounded)inheritedBounded=true;
      freshEntryContexts+=upstream?.freshEntryContexts??0;
      let unproven=false;
      for(const seed of uniqueSeeds){
        if(work.remaining--<=0){bounded=true;break;}
        const contexts=this.probeArguments(call.caller,call.method,call.offset,call.expressions,seed,resolveExternal);
        // A direct @AuraEnabled request may start a fresh transaction. Probe
        // that supported framework scenario separately; the ordinary Apex
        // entry still has unknown mutable state. Never feed this into the
        // exhaustive private closure evaluator.
        if(seed===undefined&&work.remaining>0&&contexts.some(args=>args.some(v=>v.kind==="unknown"))&&
          memberEffectModel(call.caller.source,call.caller.methods).freshEntry(call.method)){
          work.remaining--;
          const fresh=this.probeArguments(call.caller,call.method,call.offset,call.expressions,undefined,resolveExternal,true);
          const samples=fresh.filter(args=>args.some(v=>v.kind!=="unknown"));
          freshEntryContexts+=samples.length;
          contexts.push(...samples);
        }
        for(const args of contexts){
          if(args.length!==target.parameters.length){unproven=true;continue;}
          const incomplete=args.some(v=>v.kind==="unknown");
          if(incomplete){
            unproven=true;
            // Keep a runtime bind unknown rather than discarding the other
            // proven inputs. Only the selected invocation arguments need to
            // become complete later; no unknown placeholder becomes a grant.
            if(args.every(v=>v.kind==="unknown"))continue;
            partial.set(argumentIdentity(args),args);
          }else known.set(argumentIdentity(args),args);
          if(known.size+partial.size>=MAX_CALL_CONTEXTS){bounded=true;break;}
        }
        if(bounded)break;
      }
      if(unproven||upstream?.bounded)unknownCalls++;
      if(bounded)break;
    }
    const result:ApexCallerContexts={known:[...known.values()],partial:[...partial.values()],unknownCalls,
      candidateCalls:candidates.length,externallyCallable:target.visibility!=="private",bounded:bounded||inheritedBounded,
      ...(freshEntryContexts?{freshEntryContexts}:{})};
    // Recursive calls can encounter a shallower cycle/budget cut. Cache only
    // root results; never persist an incomplete nested traversal as exhaustive.
    if(stack.size===0){
      if(this.contextualEvidence.size>=MAX_CACHED_SUMMARIES)this.contextualEvidence.clear();
      this.contextualEvidence.set(key,result);
    }
    return result;
  }

  /** Cache only the incoming receiver inventory, never a query-site proof.
   * Resolver identity prevents reuse across metadata discovery passes. Cloning
   * preserves internal aliases and isolates cached values from consumers. */
  private batchReceiverInventory(owner:IndexedSource,method:IndexedApexMethod,
    resolveExternal?:ApexCallResolver):BatchReceiverInventory {
    const key=JSON.stringify([owner.filePath,method.start,this.scopeId(resolveExternal)]);
    const eligible=this.active.size===0;
    const cached=eligible?this.batchReceiverInventories.get(key):undefined;
    if(cached){
      countApex("caller.batch_receiver_cache_hits");
      return structuredClone(cached);
    }
    countApex("caller.batch_receiver_inventory_evaluations");
    const inventory=timeApex("caller.batch_receiver_inventory_ms",()=>{
      const calls=this.batchAllocations.get(owner.className.toLowerCase())??[];
      const receivers=new Map<string,Extract<ApexValue,{kind:"instance"}>>();
      let bounded=calls.length>8;
      for(const call of calls.slice(0,8)){
        countApex("caller.batch_submission_probes");
        const engine=new ApexDataFlowEngine(call.caller.source,{sourceMethods:call.caller.methods,maxOperations:2000,
          resolveExternal:(name,args,types)=>{
            if(name==="Apex.construct"&&args[0]?.kind==="text"&&args[0].values.length===1)
              return this.constructInstance(call.caller.filePath,args[0].values[0],args.slice(1),resolveExternal,types?.slice(1));
            return resolveExternal?.(name,args,types)??this.evaluateReturn(call.caller.filePath,name,args,resolveExternal,types);
          }});
        for(const args of engine.evaluateArgumentsAt(call.method,call.offset,call.expressions)){
          const instance=args[0];
          if(instance?.kind==="instance"&&instance.className.toLowerCase()===owner.className.toLowerCase())
            receivers.set(argumentIdentity([instance]),instance);
          if(receivers.size>=8){bounded=true;break;}
        }
        if(receivers.size>=8)break;
      }
      const candidates=[...receivers.values()].map(value=>({value,hypothetical:false}));
      if(!candidates.length){
        // Explicitly separate a source-initialized scenario from an observed
        // submission. Public mutable fields may differ at runtime.
        for(const signature of this.instances.constructorSignatures(owner.className)){
          const args=signature.parameters.map((name,i)=>runtimeParameter(name,signature.parameterTypes[i],"Conditional constructor input: "+name));
          countApex("caller.batch_constructor_probes");
          const value=this.constructInstance(owner.filePath,owner.className,args,resolveExternal,signature.parameterTypes,true);
          if(value?.kind==="instance")candidates.push({value,hypothetical:true});
        }
      }
      return {count:receivers.size,bounded,candidates};
    });
    if(eligible){
      if(this.batchReceiverInventories.size>=MAX_RECEIVER_SNAPSHOTS)this.batchReceiverInventories.clear();
      this.batchReceiverInventories.set(key,structuredClone(inventory));
    }
    return inventory;
  }

  /**
   * Partial receiver evidence for direct Database.executeBatch(new T(...)).
   * Direct framework invocation after a restricted scalar local prefix.
   * No intervening member writes, arbitrary calls, or heap transfer.
   */
  private probeBatchReceivers(owner:IndexedSource,method:IndexedApexMethod,offset:number,expressions:readonly string[],
    resolveExternal?: ApexCallResolver):
    {count:number;arguments:ApexValue[][];conditionalArguments:ApexValue[][];partialArguments:ApexValue[][];scenarioCount:number;bounded:boolean}{
    const empty={count:0,arguments:[] as ApexValue[][],conditionalArguments:[] as ApexValue[][],partialArguments:[] as ApexValue[][],scenarioCount:0,bounded:false};
    if(method.isStatic||method.name.toLowerCase()!=="start"||method.parameters.length!==1)return empty;
    const declaration=outerApexClass(owner.source);
    if(!declaration?.batch||declaration.parent||declaration.name.toLowerCase()!==owner.className.toLowerCase()||
       !/^database\.batchablecontext$/i.test(method.parameterTypes?.[0]??""))return empty;
    const inventory=this.batchReceiverInventory(owner,method,resolveExternal);
    let bounded=inventory.bounded;
    const {candidates}=inventory;
    const argumentsByValue=new Map<string,ApexValue[]>();
    const conditionalArguments=new Map<string,ApexValue[]>();
    const partialArguments=new Map<string,ApexValue[]>();
    let samples=0,scenarioCount=0;
    const overflow:BatchReceiver[]=[];
    const probe=(instance:BatchReceiver,conditional:boolean)=>{
      samples++;
      if(conditional)scenarioCount++;
      const engine=new ApexDataFlowEngine(owner.source,{sourceMethods:owner.methods,maxOperations:2000,
        resolveExternal:(name,args,types)=>{
          if(name==="Apex.scopeField"&&args[0]?.kind==="text"&&args[0].values[0]?.toLowerCase()===owner.className.toLowerCase()&&args[1]?.kind==="text"&&args[3]?.kind==="text"&&args[3].values[0]!=="true"){
            const fieldName=args[1].values[0]?.toLowerCase();
            const field=instance.entries.find(([key])=>key.toLowerCase()===fieldName);
            if(field)return field[1];
          }
          return resolveExternal?.(name,args,types)??this.evaluateReturn(owner.filePath,name,args,resolveExternal,types);
        }});
      for(const args of engine.evaluateArgumentsAt(method,offset,expressions)){
        if(args.some(v=>v.kind==="unknown")){
          if(args.some(v=>v.kind==="unknown"&&!!v.fragments)){
            const destination=conditional?conditionalArguments:partialArguments;
            if(destination.size<32)destination.set(argumentIdentity(args),args);
          }
          continue;
        }
        (conditional?conditionalArguments:argumentsByValue).set(argumentIdentity(args),args);
      }
    };
    for(const {value:original,hypothetical} of candidates){
      if(!supportsReceiverPrefix(method,offset,original))continue;
      const limit=Math.max(0,BASE_RECEIVER_KEY_LIMIT-samples);
      const domain=receiverMapSamples(method,original,limit);
      bounded=bounded||domain.bounded;
      for(const instance of domain.receivers){
        if(samples>=BASE_RECEIVER_SAMPLE_LIMIT){bounded=true;break;}
        probe(instance,hypothetical||instance!==original);
      }
      // Retain the original sampling order and baseline budget. Only consider
      // extra map keys after all baseline candidates have been evaluated.
      if(domain.bounded&&overflow.length<MAX_EXTRA_RECEIVER_SAMPLES){
        const expanded=receiverMapSamples(method,original,limit+MAX_EXTRA_RECEIVER_SAMPLES-overflow.length);
        overflow.push(...expanded.receivers.slice(domain.receivers.length));
      }
    }
    // Exact argument-vector deduplication is generic; the SOQL adapter still
    // validates grammar and enforces its own 32-variant cap. Never equate
    // merely similar source objects or claim complete runtime coverage.
    let extra=0;
    for(const instance of overflow){
      if(conditionalArguments.size+argumentsByValue.size>=BASE_RECEIVER_KEY_LIMIT||extra>=MAX_EXTRA_RECEIVER_SAMPLES)break;
      probe(instance,true);
      extra++;
    }
    if(extra)countApex("caller.batch_receiver_overflow_samples",extra);
    if(samples)countApex("caller.batch_receiver_samples",samples);
    return {count:inventory.count,arguments:[...argumentsByValue.values()],conditionalArguments:[...conditionalArguments.values()],partialArguments:[...partialArguments.values()],scenarioCount,bounded};
  }

  /** A bounded same-receiver path from a framework entry to an explicitly
   * private instance method. Overloads are selected using lexical types.
   * No arbitrary object dispatch, recursion, virtual calls or closed-world claim. */
  private frameworkReceiverPaths(owner:IndexedSource,target:IndexedApexMethod,
    entries:readonly IndexedApexMethod[]):Array<{entry:IndexedApexMethod;edges:ReceiverCallEdge[]}>{
    const symbols=apexSymbols(owner.source,owner.methods);
    const paths:Array<{entry:IndexedApexMethod;edges:ReceiverCallEdge[]}>=[];
    const visit=(method:IndexedApexMethod,edges:ReceiverCallEdge[],seen:Set<IndexedApexMethod>)=>{
      if(paths.length>=8||seen.has(method)||edges.length>3)return;
      if(entries.includes(method)){paths.push({entry:method,edges});return;}
      if(method.isStatic||method.visibility!=="private"||edges.length===3)return;
      const name=method.name.toLowerCase();
      const calls=discoverApexInvocations(owner.source,(qualified,raw)=>{
        if(qualified.toLowerCase()!==name&&qualified.toLowerCase()!=="this."+name)return undefined;
        const args=raw.length===1&&!raw[0].trim()?[]:raw;
        // Direct literal/local/receiver-member arguments only. Do not ignore
        // nested argument effects or pass the entire receiver as a value.
        if(args.some(a=>! /^(?:(?:this\.)?[A-Za-z_]\w*|[-+]?\d+|'(?:\\.|[^'\\])*')$/i.test(a.trim())||/^this$/i.test(a.trim())))return undefined;
        return {method:qualified,argumentIndices:args.map((_,i)=>i)};
      });
      for(const call of calls){
        if(paths.length>=8)break;
        const caller=owner.methods.filter(m=>m.start<=call.offset&&call.offset<m.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
        if(!caller||caller.isStatic||!symbols.sameOwner(caller,method)||caller===method)continue;
        const candidates=owner.methods.filter(m=>m.name.toLowerCase()===name&&symbols.sameOwner(caller,m));
        if(selectApexOverload(candidates,call.arguments.length,symbols.argumentTypes(caller,call.arguments,call.offset))!==method)continue;
        const next=new Set(seen);next.add(method);
        visit(caller,[{caller,target:method,offset:call.offset,expressions:[...call.arguments]},...edges],next);
      }
    };
    visit(target,[],new Set());
    return paths;
  }

  /** Preserve a proven incoming receiver while probing a private call chain
   * or first stateful execute chunk. These are always conditional variants.
   * The ordinary start-site analysis and its existing budgets are unchanged. */
  private probeLifecycleReceivers(owner:IndexedSource,target:IndexedApexMethod,offset:number,
    expressions:readonly string[],resolveExternal?:ApexCallResolver):{arguments:ApexValue[][];scenarios:number;bounded:boolean}{
    const empty={arguments:[] as ApexValue[][],scenarios:0,bounded:false};
    if(target.isStatic)return empty;
    const cls=outerApexClass(owner.source);
    if(!cls?.batch||cls.parent||cls.name.toLowerCase()!==owner.className.toLowerCase()||this.classes.has("database"))return empty;
    const symbols=apexSymbols(owner.source,owner.methods);
    if(symbols.ownerAt(target.start)?.toLowerCase()!==owner.className.toLowerCase())return empty;
    const frameworkEntry=(m:IndexedApexMethod,name:string,arity:number)=>!m.isStatic&&
      (m.visibility==="public"||m.visibility==="global")&&m.name.toLowerCase()===name&&m.parameters.length===arity&&
      canonicalApexType(m.parameterTypes?.[0])==="database.batchablecontext"&&symbols.sameOwner(target,m);
    const starts=owner.methods.filter(m=>frameworkEntry(m,"start",1)&&canonicalApexType(m.returnType)==="database.querylocator");
    if(starts.length!==1)return empty;
    const start=starts[0];
    const executes=cls.stateful&&!/\btransient\b/i.test(maskApexSource(owner.source))
      ?owner.methods.filter(m=>frameworkEntry(m,"execute",2)&&canonicalApexType(m.returnType)==="void"&&/^list</.test(canonicalApexType(m.parameterTypes?.[1])??"")):[];
    const entries=executes.length===1?[start,executes[0]]:[start];
    if(target===start||(!entries.includes(target)&&target.visibility!=="private"))return empty;
    // Reject lexical shadowing of platform Database for this proof.
    const platformShadow=owner.methods.some(m=>symbols.lookup(m,"Database",m.start)!==undefined)||
      /\b[A-Za-z_]\w*\s+Database\s*(?:[=;,)])/i.test(maskApexSource(owner.source));
    if(platformShadow)return empty;
    const paths=this.frameworkReceiverPaths(owner,target,entries);
    if(!paths.length)return empty;
    const inventory=this.batchReceiverInventory(owner,start,resolveExternal);
    let scenarios=0,bounded=inventory.bounded;
    const results=new Map<string,ApexValue[]>();
    let probes=0;
    for(const {value:receiver} of inventory.candidates){
      for(const {entry,edges} of paths){
        const executeEntry=entry!==start;
        if(executeEntry&&!supportsInitialBatchExecute(start,receiver))continue;
        if(!supportsReceiverPrefix(target,offset,receiver)||
           edges.some(edge=>!supportsReceiverPrefix(edge.caller,edge.offset,receiver,true)))continue;
        const resolver:ApexCallResolver=(name,args,types)=>{
          if(name==="Apex.scopeField"&&args[0]?.kind==="text"&&args[0].values[0]?.toLowerCase()===owner.className.toLowerCase()&&
             args[1]?.kind==="text"&&args[3]?.kind==="text"&&args[3].values[0]!=="true"){
            const fieldName=args[1].values[0]?.toLowerCase();
            const field=receiver.entries.find(([key])=>key.toLowerCase()===fieldName);
            if(field)return field[1];
          }
          return resolveExternal?.(name,args,types)??this.evaluateReturn(owner.filePath,name,args,resolveExternal,types);
        };
        const probe=(method:IndexedApexMethod,site:number,exprs:readonly string[],seed?:ApexValue[])=>{
          if(++probes>32){bounded=true;return [];}
          const engine=new ApexDataFlowEngine(owner.source,{sourceMethods:owner.methods,maxOperations:2000,resolveExternal:resolver});
          return engine.evaluateArgumentsAt(method,site,exprs,seed);
        };
        let seeds:Array<ApexValue[]|undefined>=[undefined];
        for(const edge of edges){
          const next=new Map<string,ApexValue[]>();
          for(const seed of seeds){
            // A literal reachability marker distinguishes a zero-argument
            // call from the engine's unknown/unreachable fallback result.
            for(const vector of probe(edge.caller,edge.offset,["true",...edge.expressions],seed)){
              if(vector[0]?.kind!=="text"||vector[0].scalarType!=="boolean"||vector[0].values[0]!=="true")continue;
              const args=vector.slice(1);
              if(args.length===edge.target.parameters.length&&next.size<8)next.set(argumentIdentity(args),args);
            }
          }
          seeds=[...next.values()];
          if(!seeds.length)break;
        }
        for(const seed of seeds){
          if(probes>=32||results.size>=32){bounded=true;break;}
          scenarios++;
          countApex(executeEntry?"caller.batch_first_execute_scenarios":"caller.batch_private_start_scenarios");
          if(edges.length)countApex("caller.batch_private_receiver_paths");
          for(const args of probe(target,offset,expressions,seed)){
            if(args.some(v=>v.kind==="unknown"&&!v.fragments))continue;
            if(results.size<32)results.set(argumentIdentity(args),args);
          }
        }
      }
    }
    return {arguments:[...results.values()],scenarios,bounded};
  }

  /** Evaluate selected invocation arguments in proven incoming contexts.
   * Evidence is kept separate from the all-path verdict and from permissions. */
  probeInvocationContexts(filePath:string,offset:number,expressions:readonly string[],
    resolveExternal?: ApexCallResolver):{
      contexts:ApexCallerContexts;arguments:ApexValue[][];partialArguments:ApexValue[][];conditionalArguments:ApexValue[][];bounded:boolean;receiverContexts?:number;receiverScenarios?:number
    }|undefined {
    const owner=this.paths.get(path.resolve(filePath));
    const method=owner?.methods.filter(m=>m.start<=offset&&offset<m.end)
      .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    if(!owner||!method)return undefined;
    if(!method.parameters.length&&(method.isStatic||method.visibility!=="private"))return undefined;
    const contexts=this.resolveCallerContexts(filePath,method,resolveExternal);
    const argumentsByValue=new Map<string,ApexValue[]>();
    const partialArguments=new Map<string,ApexValue[]>();
    const maxSeeds=8;
    const seeds=[...new Map([...contexts.known,...contexts.partial].map(seed=>[argumentIdentity(seed),seed])).values()];
    const relevant=invocationRelevantIdentifiers(method.body,offset,expressions.join(" "));
    const selected=selectApexCallerSeeds(seeds,method.parameters,relevant,maxSeeds);
    countApex("caller.candidate_seeds",seeds.length);
    countApex("caller.selected_seeds",selected.length);
    let bounded=contexts.bounded||seeds.length>selected.length;
    for(const seed of selected){
      for(const args of this.probeArguments(owner,method,offset,expressions,seed,resolveExternal)){
        if(args.some(v=>v.kind==="unknown")){
          // Retain only bounded abstract text evidence. The consumer must
          // prove any structural interpretation, never close the site.
          if(partialArguments.size<32&&args.some(v=>v.kind==="unknown"&&!!v.fragments))
            partialArguments.set(argumentIdentity(args),args);
          continue;
        }
        argumentsByValue.set(JSON.stringify(args),args);
      }
    }
    const batch=this.probeBatchReceivers(owner,method,offset,expressions,resolveExternal);
    for(const args of batch.arguments)argumentsByValue.set(JSON.stringify(args),args);
    for(const args of batch.partialArguments)if(partialArguments.size<32)partialArguments.set(argumentIdentity(args),args);
    const lifecycle=this.probeLifecycleReceivers(owner,method,offset,expressions,resolveExternal);
    const conditional=new Map([...batch.conditionalArguments,...lifecycle.arguments].map(args=>[argumentIdentity(args),args]));
    return {contexts,arguments:[...argumentsByValue.values()],partialArguments:[...partialArguments.values()],conditionalArguments:[...conditional.values()],bounded:bounded||batch.bounded||lifecycle.bounded,receiverContexts:batch.count,receiverScenarios:batch.scenarioCount+lifecycle.scenarios};
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
        const engine=new ApexDataFlowEngine(call.caller.source,{sourceMethods:call.caller.methods,
          resolveExternal:(name,args,types)=>this.evaluateReturn(call.caller.filePath,name,args,undefined,types),
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
