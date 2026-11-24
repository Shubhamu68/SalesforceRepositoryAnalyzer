import {countApex,timeApex} from "./ApexPerformance.js";
import {
  indexApexMethods, maskApexSource, matchingPair, sourceLine, splitApexTopLevel,
  type IndexedApexMethod, type SourceNode,
} from "./ApexSourceModel.js";
import {
  evaluateApexExpression, addApexValues, listValue, textValue, unknown, runtimeParameter, booleanValue,
  type ApexEnvironment, type ApexValue, type ApexExpressionContext,
} from "./ApexValueEvaluator.js";
import {ApexLocalLiveness,sharedApexLocalLiveness,declaredLoopLocals} from "./ApexLocalLiveness.js";
import {apexStateIdentity} from "./ApexStateIdentity.js";
import {ApexExecutionBudget} from "./ApexExecutionBudget.js";
import {writeInstanceMember} from "./ApexInstanceModel.js";
import {invocationMayExecute} from "./ApexConditionalInvocation.js";
import {invocationDependencySlice,trackedStandaloneDeclaration} from "./ApexDependencySlice.js";
import {discoverApexInvocations,dynamicDatabaseQuerySelector,type ApexInvocationSelector,type ApexCallSite} from "./ApexInvocationModel.js";
export type {ApexCallSite} from "./ApexInvocationModel.js";

export interface ApexCallValue {
  site: ApexCallSite;
  query: ApexValue;
  accessLevel: ApexValue;
  /** Values in the selector-requested argument order. */
  arguments?:readonly ApexValue[];
}
export interface ApexFlowOptions {
  /** Pluggable read-only, preloaded metadata or constant value source. */
  resolveExternal?: (name: string, args: ApexValue[]) => ApexValue | undefined;
  /** Only completely proven private-method caller contexts can narrow entry inputs. */
  resolvePrivateContexts?: (method: IndexedApexMethod) => ApexValue[][] | undefined;
  selectInvocation?:ApexInvocationSelector;
  /** Exact-source immutable methods from the repository index. */
  sourceMethods?:IndexedApexMethod[];
  maxPaths?: number;
  maxOperations?: number;
  maxDepth?: number;
}
interface State { values: ApexEnvironment; stopped?: boolean }
interface FrameResult { states: State[]; returns: ApexValue[] }

/** Identical symbolic states do not represent additional structural query variants. */
function mergeEquivalentStates(states:State[]):State[] {
  if(states.length<2)return states;
  const distinct=new Map<string,State>();
  for(const state of states) {
    // Completed returns/throws never re-enter the current normal frame.
    // Their return values and invocation evidence have already been recorded
    // independently, so their obsolete environments need not multiply paths.
    const key=state.stopped?"terminated":apexStateIdentity(state.values,false);
    if(!distinct.has(key))distinct.set(key,state);
  }
  return [...distinct.values()];
}

const DEFAULT_PATHS = 32, DEFAULT_OPERATIONS = 5000, DEFAULT_DEPTH = 6;
const MAX_LOOP_ITEMS = 100;

function clone(state:State):State {return {values:new Map(state.values),stopped:state.stopped};}
/** Replace an abstract collection in this frame, including tracked aliases
 * and references stored in a bounded nested map. Never mutate snapshot objects. */
function replaceCollectionAliases(state:State,existing:ApexValue,next:ApexValue):boolean{
  if(existing.kind!=="collection"&&existing.kind!=="map"&&existing.kind!=="instance"&&existing.kind!=="instanceList")return false;
  const memo=new Map<ApexValue,ApexValue>();
  const replace=(value:ApexValue,depth=0):ApexValue=>{
    if(value===existing)return next;
    const cached=memo.get(value);
    if(cached!==undefined)return cached;
    if(value.kind==="instanceList"&&depth<12){
      const items=value.items.map(item=>replace(item,depth+1));
      if(items.some((item,i)=>item!==value.items[i])){
        const changed:ApexValue={...value,items};memo.set(value,changed);return changed;
      }
    }
    if((value.kind==="map"||value.kind==="instance")&&depth<12){
      const entries=value.entries.map(([k,v]):[string,ApexValue]=>[k,replace(v,depth+1)]);
      if(entries.some(([,v],i)=>v!==value.entries[i][1])){
        const changed:ApexValue=value.kind==="instance"?{...value,entries}:{kind:"map",entries};
        memo.set(value,changed);return changed;
      }
    }
    return value;
  };
  let found=false;
  for(const [key,value] of state.values){
    const changed=replace(value);
    if(changed!==value){state.values.set(key,changed);if(value===existing)found=true;}
  }
  return found;
}
function bool(value: ApexValue): boolean | undefined {
  if(value.kind!=="text"||value.scalarType!=="boolean"||value.values.length!==1)return undefined;
  if(value.values[0]==="true")return true;
  if(value.values[0]==="false")return false;
  return undefined;
}
function asText(value:ApexValue):string|undefined {
  return value.kind==="text"&&value.values.length===1?value.values[0]:undefined;
}

/**
 * Bounded path-sensitive abstract interpreter, reusable by other Apex features.
 * Never executes Apex. Unknown values taint a query rather than fabricating
 * an object/field value. Cross-method summaries are memoized by argument context.
 */
export class ApexDataFlowEngine {
  readonly sites: ApexCallSite[];
  private readonly methods: IndexedApexMethod[];
  private readonly captures = new Map<number,ApexCallValue[]>();
  private readonly skippedInvocations=new Map<number,number>();
  private readonly options: Required<Pick<ApexFlowOptions,"maxPaths"|"maxOperations"|"maxDepth">> & ApexFlowOptions;
  private readonly summaries = new Map<string,ApexValue>();
  private readonly activeCalls = new Set<string>();
  private readonly budget:ApexExecutionBudget;
  private get exceeded():boolean{return this.budget.exceeded;}
  private readonly liveness=new Map<IndexedApexMethod,ApexLocalLiveness>();
  /** Per-site failure attribution: a large unrelated method never taints other sites. */
  private readonly failures=new Map<number,string>();
  private activeStopOffset:number|undefined;
  private activeQueryOffset:number|undefined;
  private argumentProbe?: { offset:number; expressions:string[]; results:ApexValue[][] };
  /** Per-site, per-method optimization: never applied to helper summaries. */
  private activeSlice:Set<SourceNode>|undefined;
  private readonly className:string|undefined;
  private currentMethod:IndexedApexMethod|undefined;
  constructor(readonly source:string,options:ApexFlowOptions={}) {
    countApex("engine.instances");
    this.options={maxPaths:options.maxPaths??DEFAULT_PATHS,
      maxOperations:options.maxOperations??DEFAULT_OPERATIONS,
      maxDepth:options.maxDepth??DEFAULT_DEPTH,...options};
    this.budget=new ApexExecutionBudget(this.options.maxOperations,this.options.maxPaths);
    const masked=maskApexSource(source);
    this.className=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked)?.[1];
    this.methods=options.sourceMethods??indexApexMethods(source);
    this.sites=discoverApexInvocations(source,options.selectInvocation??dynamicDatabaseQuerySelector,this.methods);
  }
  private evaluate(expr:string, state:State, depth:number):ApexValue {
    const context:ApexExpressionContext={values:state.values,
      resolveCall:(name,args)=>{
        if(name==="Apex.thisField"||name==="Apex.unqualifiedField"){
          const field=args[0];
          if(field?.kind!=="text"||field.values.length!==1||!this.className)
            return unknown("Member field name or class is not proven.");
          if(!this.currentMethod)
            return unknown("Member field requires a known Apex method scope.");
          const mode=name==="Apex.thisField"?"this":"unqualified";
          if(mode==="this"&&this.currentMethod.isStatic)
            return unknown("Instance field cannot be accessed via this in a static method.");
          const qualified=(this.className+"."+field.values[0]).toLowerCase();
          const instance=("this."+field.values[0]).toLowerCase();
          const override=mode==="this"?state.values.get(instance):
            state.values.get(qualified)??(!this.currentMethod.isStatic?state.values.get(instance):undefined);
          if(override!==undefined)return override;
          const resolve=this.options.resolveExternal;
          const value=resolve?.("Apex.scopeField",[
            textValue(this.className),field,textValue(mode),
            textValue(String(this.currentMethod.isStatic===true)),
          ]) ?? unknown("Field "+this.className+"."+field.values[0]+
            " cannot be proven in the current method scope.");
          // Keep collection references in the method frame so explicit
          // mutations of class/instance members never mutate the global cache.
          if(value.kind==="collection"||value.kind==="map"){
            const staticValue=mode==="unqualified"?resolve?.("Apex.scopeField",[
              textValue(this.className),field,textValue("unqualified"),textValue("true"),
            ]):undefined;
            state.values.set(mode==="this"||staticValue!==value?instance:qualified,value);
          }
          return value;
        }
        if(name==="Apex.constant"&&args[0]?.kind==="text"&&args[0].values.length===1){
          const key=args[0].values[0].toLowerCase();
          const previous=state.values.get(key);
          if(previous!==undefined)return previous;
          const value=this.options.resolveExternal?.(name,args);
          if(value?.kind==="collection"||value?.kind==="map")state.values.set(key,value);
          if(value!==undefined)return value;
        }
        const external=this.options.resolveExternal?.(name,args);
        if(external!==undefined)return external;
        const ownName=name.replace(/^this\./i,"");
        const sameClass=this.className&&ownName.startsWith(this.className+".")
          ?ownName.slice(this.className.length+1):ownName;
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===sameClass.toLowerCase()
          && m.parameters.length===args.length);
        if(candidates.length!==1)return undefined;
        if(!args.length&&candidates[0].isStatic&&this.className){
          const lazy=this.options.resolveExternal?.("Apex.lazyGetter",[textValue(this.className),textValue(sameClass)]);
          if(lazy!==undefined)return lazy;
        }
        if(depth>=this.options.maxDepth)return unknown("Apex helper recursion depth exceeded.");
        const key=candidates[0].start+"|"+apexStateIdentity(new Map(args.map((v,i)=>[String(i),v])),false);
        if(this.activeCalls.has(key))return unknown("Recursive Apex helper call.");
        const cacheable=args.every(v=>v.kind==="text"||v.kind==="number"||v.kind==="null"||v.kind==="unknown");
        const cached=cacheable?this.summaries.get(key):undefined;
        if(cached){countApex("helper.local_cache_hit");return cached;}
        countApex("helper.local_evaluations");
        this.activeCalls.add(key);
        const env=new Map<string,ApexValue>();
        candidates[0].parameters.forEach((p,i)=>env.set(p,args[i]));
        let result:FrameResult;
        const previousMethod:IndexedApexMethod|undefined=this.currentMethod;
        this.currentMethod=candidates[0];
        try {
          result=this.execute(candidates[0].body,[{values:env}],depth+1);
        }finally{
          this.currentMethod=previousMethod;
          this.activeCalls.delete(key);
        }
        let value:ApexValue;
        if(result.returns.length===0||result.states.some(s=>!s.stopped))
          value=unknown("Helper has an execution path without a proven return: "+ownName);
        else if(result.returns.some(v=>v.kind==="unknown"))
          value=result.returns.find(v=>v.kind==="unknown")!;
        else if(result.returns.every(v=>v.kind==="text")){
          const alternatives=[...new Set(result.returns.flatMap(v=>v.kind==="text"?v.values:[]))];
          value=alternatives.length>this.options.maxPaths
            ?unknown("Too many helper return alternatives.")
            :{kind:"text",values:alternatives,...(result.returns.every(v=>v.kind==="text"&&v.scalarType==="boolean")?{scalarType:"boolean" as const}:{})};
        }else{
          // A List/Set or number is safe only when every return path has the
          // same complete value. Never merge different collections by union.
          const distinct=new Map(result.returns.map(v=>[JSON.stringify(v),v]));
          value=distinct.size===1?distinct.values().next().value!:
            unknown("Helper returns incompatible collection or numeric alternatives: "+ownName);
        }
        if(value.kind==="instance"||value.kind==="instanceList")return unknown("Instance-return alias transfer is not yet proven.");
        if(cacheable&&(value.kind==="text"||value.kind==="number"||value.kind==="null"||value.kind==="unknown"))this.summaries.set(key,value);
        return value;
      }};
    return evaluateApexExpression(expr,context);
  }
  /**
   * Apex passes mutable collection references into helpers. If we cannot prove
   * a call is side-effect free, a known List/Set used later in SELECT is no
   * longer a safe complete field inventory. Scalars remain immutable.
   */
  private taintCollectionsPassedToUnknownCalls(source:string,state:State):void{
    if(!source.includes("(") || ![...state.values.values()].some(v=>
      v.kind==="collection"||v.kind==="map"||v.kind==="instance"||v.kind==="instanceList"))return;
    const masked=maskApexSource(source);
    const call=/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g;
    const pure=/^(?:String\.(?:join|isBlank|isNotBlank|escapeSingleQuotes)|System\.debug|Math\.\w+|Database\.(?:query|queryWithBinds|countQuery|countQueryWithBinds|getQueryLocator|getQueryLocatorWithBinds))$/i;
    let match:RegExpExecArray|null;
    while((match=call.exec(masked))!==null){
      const name=match[1], open=masked.indexOf("(",match.index);
      const close=matchingPair(masked,open);
      if(close<0)continue;
      if(pure.test(name)){call.lastIndex=open+1;continue;}
      const receiver=name.includes(".")?name.slice(0,name.lastIndexOf(".")):"";
      // add/addAll/clear are handled explicitly as ordered mutations above.
      if(["add","addAll","clear"].includes(name.slice(name.lastIndexOf(".")+1)) &&
        state.values.get(receiver)?.kind==="collection"){
        call.lastIndex=open+1;continue;
      }
      const argumentText=maskApexSource(source.slice(open+1,close));
      for(const [identifier,value] of [...state.values]){
        if(value.kind!=="collection"&&value.kind!=="map"&&value.kind!=="instance"&&value.kind!=="instanceList")continue;
        const escaped=identifier.replace(/[.*+?^$()|[\]{}\\]/g,"\\$&");
        if(new RegExp("\\b"+escaped+"\\b","i").test(argumentText)||
          ((value.kind==="instance"||value.kind==="instanceList"&&!/\.(?:get|isEmpty|size)$/i.test(name))&&receiver.toLowerCase()===identifier.toLowerCase())){
          if(value.kind==="instanceList")for(const item of value.items)
            replaceCollectionAliases(state,item,unknown("Custom Apex list element may escape through "+name+"."));
          replaceCollectionAliases(state,state.values.get(identifier)??value,unknown(
            (value.kind==="instance"?"Mutable instance ":"Mutable collection ")+identifier+" may be changed by unsupported method "+name+"."));
        }
      }
      call.lastIndex=open+1;
    }
  }
  private captureCalls(start:number,end:number,state:State,depth:number):void{
    // Sites are sorted by source offset. Binary-search instead of walking
    // every Database call for every parsed Apex statement.
    let low=0, high=this.sites.length;
    while(low<high){
      const mid=(low+high)>>>1;
      if(this.sites[mid].offset<start)low=mid+1;
      else high=mid;
    }
    for(let i=low;i<this.sites.length&&this.sites[i].offset<end;i++){
      const site=this.sites[i];
      if(this.activeQueryOffset!==undefined&&site.offset!==this.activeQueryOffset)continue;
      if(!invocationMayExecute(this.source.slice(start,end),site.offset-start,
        condition=>this.evaluate(condition,clone(state),depth))){
        this.skippedInvocations.set(site.offset,(this.skippedInvocations.get(site.offset)??0)+1);
        continue;
      }
      const args=site.arguments.map(argument=>this.evaluate(argument,state,depth));
      const value=args[0]??unknown("Invocation has no selected argument.");
      const access=args[1]??textValue("(default)");
      const captures=this.captures.get(site.offset)??[];
      captures.push({site,query:value,accessLevel:access,arguments:args});
      this.captures.set(site.offset,captures);
    }
  }
  private statement(node:SourceNode,state:State,depth:number):ApexValue|undefined{
    const original=(node.text??"").trim().replace(/;\s*$/,"");
    // Read arguments in the environment immediately before their invocation,
    // not after the containing assignment or nested helper mutates the state.
    if(this.argumentProbe && node.start<=this.argumentProbe.offset &&
        this.argumentProbe.offset<node.end) {
      if(invocationMayExecute(this.source.slice(node.start,node.end),this.argumentProbe.offset-node.start,
        condition=>this.evaluate(condition,clone(state),depth)))
        this.argumentProbe.results.push(this.argumentProbe.expressions.map(expr=>
          this.evaluate(expr,state,depth)));
    }
    this.captureCalls(node.start,node.end,state,depth);
    if(!original)return;
    if(/^throw\b/i.test(original)){
      // Explicit throw ends the current normal path. The parser currently
      // treats catch paths conservatively; do not invent a helper return.
      const owner=this.currentMethod;
      const inTry=(nodes:SourceNode[]):boolean=>nodes.some(n=>n.start<=node.start&&node.start<n.end&&
        (n.condition==="__apex_exception_path_unknown__"||inTry(n.body??[])||inTry(n.otherwise??[])));
      const capturedSite=this.sites.find(s=>s.offset===this.activeQueryOffset);
      const containingTry=(nodes:SourceNode[]):boolean=>nodes.some(n=>n.start<=node.start&&node.start<n.end&&
        ((n.condition==="__apex_exception_path_unknown__"&&capturedSite!==undefined&&
          (n.body??[]).some(child=>child.start<=capturedSite.offset&&capturedSite.offset<child.end))||
          containingTry(n.body??[])||containingTry(n.otherwise??[])));
      if(owner&&(!inTry(owner.body)||containingTry(owner.body))){
        state.stopped=true;
        return;
      }
      // A caught throw outside the supported normal-path scope may transfer
      // control to a handler with different values; fail closed.
      for(const name of state.values.keys())state.values.set(name,unknown("Caught throw continuation is not proven."));
      return;
    }
    if(/^return\b/.test(original)){
      state.stopped=true;
      return this.evaluate(original.replace(/^return\s+/,""),state,depth);
    }
    // Abstract collections are immutable snapshots; updates affect only the
    // current frame and direct aliases, never another query or repository scan.
    const mutate=/^((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)\s*\.\s*(add|addAll|clear|remove|put|putAll|removeAll|retainAll|set|sort|reverse)\s*\(([\s\S]*)\)$/i.exec(original);
    if(mutate){
      const [,name,operation,expr]=mutate;
      const action=operation.toLowerCase();
      const existing=this.evaluate(name,state,depth);
      const cause=(value:ApexValue)=>value.kind==="unknown"?value.reason:"unsupported value shape";
      let next:ApexValue;
      const args=expr.trim()?splitApexTopLevel(expr,",").map(item=>this.evaluate(item,state,depth)):[];
      const arg=args[0];
      if(existing.kind==="collection"){
        const item=arg?asText(arg):undefined;
        if(action==="clear"&&args.length===0)next=listValue([],existing.unique);
        else if(action==="add"&&args.length===1&&item!==undefined)
          next=listValue([...existing.items,item],existing.unique);
        else if(action==="addall"&&args.length===1&&arg?.kind==="collection")
          next=listValue([...existing.items,...arg.items],existing.unique);
        else if(action==="remove"&&args.length===1&&existing.unique&&item!==undefined)
          next=listValue(existing.items.filter(v=>v!==item),true);
        else if(action==="remove"&&args.length===1&&!existing.unique&&arg?.kind==="number"&&
          Number.isInteger(arg.value)&&arg.value>=0&&arg.value<existing.items.length)
          next=listValue(existing.items.filter((_,i)=>i!==arg.value),false);
        else if(action==="add"||action==="addall")
          next=unknown("Collection "+operation+" argument "+expr+" is unknown: "+(arg?cause(arg):"missing argument"));
        else next=unknown("Unsupported mutation "+operation+" may change the complete query field inventory.");
      }else if(existing.kind==="instanceList"){
        const matches=(v:ApexValue)=>v.kind==="instance"&&(v.className.toLowerCase()===existing.elementType.toLowerCase()||v.className.toLowerCase().endsWith("."+existing.elementType.toLowerCase()));
        if(action==="clear"&&args.length===0)next={...existing,items:[]};
        else if(action==="add"&&args.length===1&&matches(arg))next={...existing,items:[...existing.items,arg]};
        else if(action==="addall"&&args.length===1&&arg.kind==="instanceList"&&arg.items.every(matches))next={...existing,items:[...existing.items,...arg.items]};
        else if(action==="set"&&args.length===2&&arg.kind==="number"&&Number.isInteger(arg.value)&&arg.value>=0&&arg.value<existing.items.length&&matches(args[1]))next={...existing,items:existing.items.map((item,i)=>i===arg.value?args[1]:item)};
        else next=unknown("Unsupported custom Apex list mutation: "+operation);
      }else if(existing.kind==="map"){
        const key=arg?asText(arg):undefined;
        if(action==="clear"&&args.length===0)next={kind:"map",entries:[]};
        else if(action==="put"&&args.length===2&&key!==undefined&&args[1].kind!=="unknown")
          next={kind:"map",entries:[...existing.entries.filter(([k])=>k!==key),[key,args[1]]]};
        else if(action==="remove"&&args.length===1&&key!==undefined)
          next={kind:"map",entries:existing.entries.filter(([k])=>k!==key)};
        else if(action==="putall"&&args.length===1&&arg?.kind==="map")
          next={kind:"map",entries:[...existing.entries.filter(([k])=>!arg.entries.some(([other])=>other===k)),...arg.entries]};
        else next=unknown("Map."+operation+" has an unproven key/value or unsupported mutation: "+
          (args.find(v=>v.kind==="unknown")?.kind==="unknown"?cause(args.find(v=>v.kind==="unknown")!):expr));
      }else{
        next=unknown("Collection "+name+" was mutated without a known initial value: "+cause(existing));
      }
      if(existing.kind==="instanceList"&&[...state.values].some(([key,value])=>key.startsWith("#iterator:")&&value===existing))
        next=unknown("Custom Apex list structure changed during iteration.");
      if(next.kind==="collection"&&next.items.length>2000||next.kind==="map"&&next.entries.length>200||next.kind==="instanceList"&&next.items.length>100)
        next=unknown("Collection mutation exceeded the bounded inventory size.");
      if(!replaceCollectionAliases(state,existing,next))
        state.values.set(name.includes(".")?name.toLowerCase():name,next);
      return;
    }
    // Unsupported indexed writes must not preserve an obsolete list snapshot.
    const indexedWrite=/^([A-Za-z_]\w*)\s*\[[\s\S]+\]\s*(?:\+?=)(?!=|>)/.exec(original);
    if(indexedWrite){
      const existing=state.values.get(indexedWrite[1]);
      if(existing?.kind==="instanceList"||existing?.kind==="collection"||existing?.kind==="map"){
        replaceCollectionAliases(state,existing,unknown("Indexed Apex collection assignment is not proven."));
        return;
      }
    }
    // Explicit instance writes update every alias in this frame, not other
    // allocations with equal field values. Unmodeled receiver writes taint.
    const member=/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*(\+?=)(?!=|>)\s*([\s\S]+)$/.exec(original);
    if(member){
      const [,receiver,field,operator,rhs]=member;
      const existing=state.values.get(receiver);
      if(existing?.kind==="instance"){
        let next=this.evaluate(rhs,state,depth);
        if(operator==="+=")next=this.evaluate(receiver+"."+field+" + ("+rhs+")",state,depth);
        replaceCollectionAliases(state,existing,writeInstanceMember(existing,field,next));
        this.taintCollectionsPassedToUnknownCalls(rhs,state);
        return;
      }
    }
    // Declarations, reassignment and += are independently versioned by state.
    const assignment=/\b([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]+)$/.exec(original);
    const prefix=assignment?original.slice(0,assignment.index).trim():"";
    const validPrefix=!prefix || /^(?:(?:final|static|public|private|protected|global)\s+)*(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>?]+>)?(?:\[\])?)$/.test(prefix);
    if(assignment&&validPrefix){
      const [,name,operator,rhs]=assignment;
      const value=this.evaluate(rhs,state,depth);
      if(operator==="=")state.values.set(name,value);
      else {
        const former=state.values.get(name);
        const added=former?addApexValues(former,value):unknown("No proven previous assignment.");
        if(added.kind==="text"&&added.values.length>this.options.maxPaths)
          state.values.set(name,unknown("Too many += alternatives for "+name));
        else if(added.kind==="unknown")
          state.values.set(name,{...added,reason:"Cannot determine += value of "+name+": "+added.reason});
        else state.values.set(name,added);
      }
      this.taintCollectionsPassedToUnknownCalls(rhs,state);
      return;
    }
    // Retained unfamiliar compound assignments/increments must not leave
    // stale scalar or receiver state behind. Unsupported is not a no-op.
    const visible=maskApexSource(original).trim();
    const compound=/^(?:\+\+|--)\s*((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s*$/.exec(visible)?.[1]??
      /^((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s*(?:\+\+|--|[-*/%&|^]=|<<=|>>=)/.exec(visible)?.[1];
    if(compound){
      const target=compound.replace(/\s+/g,"");
      const existing=this.evaluate(target,state,depth);
      const next=unknown("Unsupported Apex write to "+target+"; previous value cannot be retained.");
      const receiver=target.includes(".")?state.values.get(target.split(".")[0]):undefined;
      if(receiver?.kind==="instance")replaceCollectionAliases(state,receiver,next);
      else if(!replaceCollectionAliases(state,existing,next))
        state.values.set(target.includes(".")?target.toLowerCase():target,next);
      return;
    }
    const declaration=trackedStandaloneDeclaration(original);
    if(declaration){state.values.set(declaration,unknown("Declared but not assigned."));return;}
    // Standalone same-class helper calls may contain a Database.query() inside
    // their body. Evaluate their arguments without executing arbitrary Apex.
    if(/^(?:(?:this|[A-Za-z_]\w*)\.)?[A-Za-z_]\w*\s*\(/.test(original)){
      this.evaluate(original,state,depth);
      this.taintCollectionsPassedToUnknownCalls(original,state);
    }
  }
  /** Restrict refinement to immutable parameter usage solely in repeated
   * identical guards. Other reads (including binds), writes, shadowing or
   * opposite-polarity tests can observe null/unknown semantics and are left
   * unrefined. Count raw references conservatively, including comments. */
  private repeatedGuardOnly(name:string,negated:boolean):boolean{
    const method=this.currentMethod;
    if(!method)return false;
    const key=method.start+"|"+name+"|"+negated;
    const cached=this.guardOnlyCache.get(key);
    if(cached!==undefined)return cached;
    let guards=0;
    const visit=(nodes:SourceNode[])=>{
      for(const n of nodes){
        if(n.kind==="if"){
          const g=/^\s*(!\s*)?([A-Za-z_]\w*)\s*$/.exec(n.condition??"");
          if(g&&g[2]===name&&!!g[1]===negated)guards++;
        }
        visit(n.body??[]);visit(n.otherwise??[]);
      }
    };
    visit(method.body);
    const references=[...this.source.slice(method.start,method.end).matchAll(/\b[A-Za-z_]\w*\b/g)]
      .filter(m=>m[0].toLowerCase()===name.toLowerCase()).length;
    const proven=guards>1&&references===guards;
    this.guardOnlyCache.set(key,proven);
    return proven;
  }
  private readonly guardOnlyCache=new Map<string,boolean>();
  private runNode(node:SourceNode,state:State,depth:number):
    {states:State[];returns:ApexValue[]}{
    if(state.stopped)return {states:[state],returns:[]};
    if(depth===0&&this.activeSlice&&!this.activeSlice.has(node))return {states:[state],returns:[]};
    if(!this.budget.visit(node.start,this.currentMethod?.name??"(unknown method)")){
      return {states:[{values:new Map([...state.values.keys()].map((k):[string,ApexValue]=>
        [k,unknown("Apex operation budget exceeded.")]))}],returns:[]};
    }
    if(node.kind==="statement"){
      const result=this.statement(node,state,depth);
      return {states:[state],returns:result?[result]:[]};
    }
    const scoped=(nodes:SourceNode[],seed=state):FrameResult=>{
      const before=new Set(seed.values.keys());
      const result=this.execute(nodes,[clone(seed)],depth);
      for(const frame of result.states){
        // Locals introduced by a nested branch/block must not escape scope.
        // Assignments to existing symbols remain visible after the block.
        for(const key of frame.values.keys())
          if(!before.has(key)&&!key.includes("."))frame.values.delete(key);
      }
      return result;
    };
    if(node.kind==="block")return scoped(node.body??[]);
    if(node.kind==="if"){
      const condition=this.evaluate(node.condition??"",state,depth);
      const known=bool(condition);
      // Refine only a declared Boolean parameter in a simple, direct guard.
      // Do not assume truth of arbitrary expressions, mutable fields or calls.
      const guard=/^\s*(!\s*)?([A-Za-z_]\w*)\s*$/.exec(node.condition??"");
      const parameterIndex=guard?this.currentMethod?.parameters.indexOf(guard[2])??-1:-1;
      const name=parameterIndex>=0?this.currentMethod!.parameters[parameterIndex]:undefined;
      const refine=known===undefined&&name!==undefined&&
        this.currentMethod?.parameterTypes?.[parameterIndex]?.toLowerCase()==="boolean"&&
        state.values.get(name)?.kind==="unknown"&&this.repeatedGuardOnly(name,!!guard?.[1]);
      const branch=(truth:boolean,nodes:SourceNode[]):FrameResult=>{
        if(!refine||!name)return scoped(nodes);
        const seed=clone(state);
        seed.values.set(name,booleanValue(guard?.[1]?!truth:truth));
        return scoped(nodes,seed);
      };
      const paths=[...(known!==false?[branch(true,node.body??[])]:[]),
        ...(known!==true?[branch(false,node.otherwise??[])]:[])];
      return {states:paths.flatMap(x=>x.states),returns:paths.flatMap(x=>x.returns)};
    }
    if(node.kind==="for"){
      // A query may itself occur in the for-loop header.
      const headEnd=node.body?.[0]?.start??node.end;
      this.captureCalls(node.start,headEnd,state,depth);
      const iterable=node.iterable?this.evaluate(node.iterable,state,depth):unknown("Unsupported for-loop header");
      if(iterable.kind==="instanceList"&&node.loopVariable&&iterable.items.length<=MAX_LOOP_ITEMS){
        // Pin the original iterable as an alias, so member writes through the
        // loop variable or another alias update subsequent iterations.
        const pin="#iterator:"+node.start;
        const original=clone(state);original.values.set(pin,iterable);
        let states=[original],returns:ApexValue[]=[];
        const outerKeys=new Set(original.values.keys());
        const locals=declaredLoopLocals(node.body??[]);
        let unsafe=false;
        for(let i=0;i<iterable.items.length;i++){
          if(this.exceeded)break;
          states=states.map(frame=>{
            if(frame.stopped)return frame;
            const child=clone(frame);
            const current=child.values.get(pin);
            if(current?.kind!=="instanceList"||current.items.length!==iterable.items.length){
              unsafe=true;child.values.set(node.loopVariable!,unknown("Custom Apex list changed during iteration."));
            }else child.values.set(node.loopVariable!,current.items[i]);
            return child;
          });
          const result=this.execute(node.body??[],states,depth);
          for(const frame of result.states){
            for(const key of frame.values.keys())if(locals.has(key)&&!outerKeys.has(key)&&key!==node.loopVariable)frame.values.delete(key);
            const current=frame.values.get(pin);
            if(!frame.stopped&&(current?.kind!=="instanceList"||current.items.length!==iterable.items.length))unsafe=true;
          }
          states=mergeEquivalentStates(result.states);returns.push(...result.returns);
          if(unsafe)break;
        }
        if(unsafe){
          // Never publish earlier captured variants as complete when iteration
          // cardinality or alias state could not be preserved.
          for(const site of this.sites)if(site.offset>=node.start&&site.offset<node.end){
            const missing=unknown("Custom Apex list changed during iteration; complete query coverage is not proven.");
            const prior=this.captures.get(site.offset)??[];
            this.captures.set(site.offset,[...prior,{site,query:missing,accessLevel:missing,arguments:site.arguments.map(()=>missing)}]);
          }
          if(this.argumentProbe&&this.argumentProbe.offset>=node.start&&this.argumentProbe.offset<node.end)
            this.argumentProbe.results.push(this.argumentProbe.expressions.map(()=>unknown("Custom Apex list changed during iteration.")));
          for(const frame of states)if(!frame.stopped)for(const key of frame.values.keys())frame.values.set(key,unknown("Custom Apex list iteration has unproven effects."));
        }
        for(const frame of states){
          frame.values.delete(pin);
          if(state.values.has(node.loopVariable))frame.values.set(node.loopVariable,state.values.get(node.loopVariable)!);
          else frame.values.delete(node.loopVariable);
        }
        return {states,returns};
      }
      if((iterable.kind==="collection"||iterable.kind==="records")&&
         node.loopVariable&&iterable.items.length<=MAX_LOOP_ITEMS){
        let states=[clone(state)], returns:ApexValue[]=[];
        const outerKeys=new Set(state.values.keys());
        const locals=declaredLoopLocals(node.body??[]);
        for(const item of iterable.items){
          if(this.exceeded)break;
          states=states.map(s=>{
            if(s.stopped)return s;
            const child=clone(s);
            child.values.set(node.loopVariable!,iterable.kind==="records"
              ?{kind:"record",entries:item as Array<[string,ApexValue]>}
              :textValue(item as string));
            return child;
          });
          const result=this.execute(node.body??[],states,depth);
          // Each iteration has its own lexical locals. Keeping these in the
          // next iteration incorrectly multiplies otherwise identical paths.
          for(const frame of result.states){
            for(const key of frame.values.keys()){
              if(locals.has(key)&&!outerKeys.has(key)&&key!==node.loopVariable)
                frame.values.delete(key);
            }
          }
          states=mergeEquivalentStates(result.states); returns.push(...result.returns);
        }
        for(const frame of states){
          if(!state.values.has(node.loopVariable!))frame.values.delete(node.loopVariable!);
          else frame.values.set(node.loopVariable!,state.values.get(node.loopVariable!)!);
        }
        return {states,returns};
      }
      // Unknown loop cardinality or values: keep both zero-iteration and
      // unknown-iteration possibility; taint variables assigned in its body.
      const mentioned=new Set<string>();
      const walk=(nodes:SourceNode[])=>{
        for(const n of nodes){
          const text=n.text??"";
          const match=/\b((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)\s*(?:\+?=(?![=>])|\.\s*(?:add|addAll|clear|remove|put|putAll|removeAll|retainAll|set|sort|reverse)\s*\()/gi;
          for(const entry of text.matchAll(match))mentioned.add(entry[1]);
          if(n.body)walk(n.body);
          if(n.otherwise)walk(n.otherwise);
        }
      };
      walk(node.body??[]);
      const changed=clone(state);
      for(const variable of mentioned){
        const target=variable.includes(".")?variable.toLowerCase():variable;
        const replacement=unknown("Loop may change "+variable+" using runtime values. Iterable "+
          (node.iterable??"(unsupported header)")+": "+(iterable.kind==="unknown"?iterable.reason:
            "iteration count or value shape exceeds supported bounds."));
        const receiver=variable.split(".")[0];
        const instance=changed.values.get(receiver);
        if(variable.includes(".")&&instance?.kind==="instance"){
          replaceCollectionAliases(changed,instance,replacement);continue;
        }
        const existing=this.evaluate(variable,changed,depth);
        if(!replaceCollectionAliases(changed,existing,replacement))changed.values.set(target,replacement);
      }
      // If query occurs inside the body, capture an explicitly unknown version.
      for(const site of this.sites){
        if(site.offset<node.start||site.offset>=node.end)continue;
        if(this.captures.has(site.offset))continue;
        this.captures.set(site.offset,[{site,query:unknown("Query occurs in a runtime-dependent loop."),
          accessLevel:unknown("Loop execution context unknown."),
          arguments:site.arguments.map(()=>unknown("Loop execution context unknown."))}]);
      }
      return {states:[state,changed],returns:[]};
    }
    // Opaque unsupported control flow might modify any previously known symbol.
    for(const name of state.values.keys())state.values.set(name,
      unknown("Unsupported Apex control flow preceding this expression."));
    return {states:[state],returns:[]};
  }
  private execute(nodes:SourceNode[],initial:State[],depth:number):FrameResult{
    let states=initial,returns:ApexValue[]=[];
    const owner=this.currentMethod;
    let live:ApexLocalLiveness|undefined;
    if(owner&&nodes===owner.body){
      if(depth===0&&this.activeStopOffset!==undefined)
        live=sharedApexLocalLiveness(this.source,owner,this.activeStopOffset);
      else {
        live=this.liveness.get(owner);
        if(!live){live=sharedApexLocalLiveness(this.source,owner);this.liveness.set(owner,live);}
      }
    }
    for(const node of nodes){
      // Only the source prefix leading to this execution site can contribute
      // to its query value. Helpers (depth>0) must evaluate their full body.
      if(depth===0&&this.activeStopOffset!==undefined&&node.start>this.activeStopOffset)break;
      if(this.exceeded||states.every(state=>state.stopped))break;
      // Skip dead nodes once for the whole frontier, avoiding a clone/hash
      // and path-budget check for every otherwise unchanged state.
      if(depth===0&&this.activeSlice&&!this.activeSlice.has(node))continue;
      const next:State[]=[];
      for(const state of states){
        if(this.exceeded)break;
        const result=this.runNode(node,state,depth);
        next.push(...result.states);returns.push(...result.returns);
      }
      if(this.exceeded)break;
      // Drop proven dead root-local and declared scalar parameter bindings,
      // not mutable aliases, fields or loop-carried values, before deduplication.
      if(live)for(const frame of next)live.discardDeadScalars(frame.values,node.end);
      const distinct=mergeEquivalentStates(next);
      if(!this.budget.checkPaths(distinct.filter(frame=>!frame.stopped).length,node.start,owner?.name??"(unknown method)")){
        states=[{values:new Map([...distinct[0].values.keys()].map((k):[string,ApexValue]=>[k,
          unknown("Query path enumeration budget exceeded.")]))}];
      }else states=distinct;
    }
    return {states,returns};
  }
  /**
   * Evaluate an indexed helper without executing Apex. Return values are symbolic
   * and only returned when every feasible exit has a proven result.
   * Collections cannot be merged across incompatible branch variants.
   */
  summarizeMethodReturn(method:IndexedApexMethod,args:readonly ApexValue[]):ApexValue {
    if(method.parameters.length!==args.length)
      return unknown("Apex helper argument count does not match the declaration.");
    this.budget.reset();
    this.activeSlice=undefined;
    this.activeQueryOffset=undefined;
    this.activeStopOffset=undefined;
    const values=new Map<string,ApexValue>();
    method.parameters.forEach((name,index)=>values.set(name,args[index]));
    const previousMethod:IndexedApexMethod|undefined=this.currentMethod;
    this.currentMethod=method;
    let result:FrameResult;
    try{result=this.execute(method.body,[{values}],1);}
    finally{this.currentMethod=previousMethod;}
    if(this.exceeded)return unknown("Apex helper exceeds bounded analysis budget: "+this.budget.reason);
    if(!result.returns.length || result.states.some(state=>!state.stopped))
      return unknown("Apex helper has an execution path without a proven return.");
    if(result.returns.some(value=>value.kind==="instance"||value.kind==="instanceList"))return unknown("Instance-return alias transfer is not yet proven.");
    if(result.returns.some(value=>value.kind==="unknown"))
      return result.returns.find(value=>value.kind==="unknown")!;
    if(result.returns.every(value=>value.kind==="text")) {
      const alternatives=[...new Set(result.returns.flatMap(value=>
        value.kind==="text"?value.values:[]))];
      return alternatives.length<=this.options.maxPaths
        ?{kind:"text",values:alternatives,...(result.returns.every(v=>v.kind==="text"&&v.scalarType==="boolean")?{scalarType:"boolean" as const}:{})}
        :unknown("Apex helper return alternatives exceed the limit.");
    }
    const unique=new Map(result.returns.map(value=>[JSON.stringify(value),value]));
    return unique.size===1
      ?unique.values().next().value!
      :unknown("Apex helper returns structurally different collection or numeric alternatives.");
  }

  /**
   * Bounded caller-side propagation. Unknown input parameters are deliberately
   * seeded as unknown; the repository cannot infer external runtime callers.
   */
  evaluateArgumentsAt(method:IndexedApexMethod,offset:number,
    expressions:readonly string[],callerArgs?:readonly ApexValue[]):ApexValue[][] {
    this.budget.reset();
    this.activeQueryOffset=undefined;
    this.activeStopOffset=offset;
    this.activeCalls.clear();
    this.summaries.clear();
    this.activeSlice=invocationDependencySlice(method.body,offset,expressions.join(" + "));
    this.argumentProbe={offset,expressions:[...expressions],results:[]};
    const env=new Map<string,ApexValue>();
    method.parameters.forEach((name,index)=>env.set(name,
      callerArgs?.length===method.parameters.length
        ?callerArgs[index] : runtimeParameter(name,method.parameterTypes?.[index],"Runtime caller parameter: "+name)));
    const previousMethod=this.currentMethod;
    this.currentMethod=method;
    try{countApex("caller.argument_probes");timeApex("caller.argument_probe_ms",()=>this.execute(method.body,[{values:env}],0));}
    finally{this.currentMethod=previousMethod;}
    const result=this.argumentProbe.results;
    this.argumentProbe=undefined;
    this.activeSlice=undefined;
    this.activeStopOffset=undefined;
    if(this.exceeded || !result.length)
      return [expressions.map(()=>unknown(this.exceeded
        ?"Caller argument path exceeds bounded analysis budget: "+this.budget.reason
        :"Caller invocation has no proven execution context."))];
    return result;
  }

  /** Collect only lexical same-class callers of an explicitly private helper. */
  private privateCallers(owner:IndexedApexMethod):
    Array<{offset:number;method:IndexedApexMethod}>{
    const masked=maskApexSource(this.source);
    const safeName=owner.name; // Apex identifiers cannot contain regex punctuation.
    const pattern=new RegExp("\\b"+safeName+"\\s*\\(","g");
    const callers:Array<{offset:number;method:IndexedApexMethod}>=[];
    let match:RegExpExecArray|null;
    while((match=pattern.exec(masked))!==null){
      const containing=this.methods.find(m=>m!==owner&&m.start<=match!.index&&match!.index<m.end);
      if(!containing)continue;
      const prior=masked.slice(Math.max(0,match.index-100),match.index);
      const dot=/\.\s*$/.test(prior);
      if(dot){
        const receiver=/\b([A-Za-z_]\w*)\.\s*$/.exec(prior)?.[1];
        if(receiver!=="this"&&receiver!==this.className)continue;
      }
      callers.push({offset:match.index,method:containing});
    }
    return callers;
  }
  /**
   * Analyze independently from each execution site; parse/index once.
   * The tightest enclosing method owns the site. Unknown entry parameters
   * remain unknown unless a caller is proven, never guessed as constants.
   */
  analyze(): {
    captures:Map<number,ApexCallValue[]>;
    unreachable:Set<number>;
    exceeded:boolean;
    failures:Map<number,string>;
  } {
    countApex("invocation.sites",this.sites.length);
    let anyExceeded=false;
    const unreachable=new Set<number>();
    for(const site of this.sites){
      this.budget.reset();
      this.activeQueryOffset=site.offset;
      this.activeStopOffset=site.offset;
      this.activeCalls.clear();
      this.summaries.clear();
      this.activeSlice=undefined;
      const owner=this.methods.filter(m=>m.start<=site.offset&&site.offset<m.end)
        .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
      if(!owner){
        this.failures.set(site.offset,"Execution site is outside a recognized Apex method.");
        continue;
      }
      this.currentMethod=owner;
      const closedContexts=owner.visibility==="private"
        ?this.options.resolvePrivateContexts?.(owner):undefined;
      const callers=owner.visibility==="private"
        ?this.privateCallers(owner):[];
      if(closedContexts?.length){
        // A private method has only the indexed, completely proven caller
        // contexts. Evaluate its query directly under each actual argument set.
        // Public/protected/global methods must never use this optimization.
        this.activeStopOffset=site.offset;
        this.activeSlice=invocationDependencySlice(owner.body,site.offset,
          site.arguments.join(" "));
        for(const args of closedContexts){
          if(args.length!==owner.parameters.length||
             args.some(value=>value.kind==="unknown")){
            this.failures.set(site.offset,"Private caller context is incomplete.");
            break;
          }
          const env=new Map<string,ApexValue>();
          owner.parameters.forEach((name,index)=>env.set(name,args[index]));
          const before=(this.captures.get(site.offset)?.length??0)+(this.skippedInvocations.get(site.offset)??0);
          this.execute(owner.body,[{values:env}],0);
          if((this.captures.get(site.offset)?.length??0)+(this.skippedInvocations.get(site.offset)??0)===before){
            this.failures.set(site.offset,
              "Private caller context did not reach the query execution site.");
            break;
          }
          if(this.exceeded)break;
        }
        this.activeSlice=undefined;
      }else if(callers.length){
        // A private method cannot be invoked externally; every visible
        // call-site must supply a proven argument context to claim RESOLVED.
        for(const caller of callers){
          this.activeStopOffset=caller.offset;
          const before=(this.captures.get(site.offset)?.length??0)+(this.skippedInvocations.get(site.offset)??0);
          const env=new Map<string,ApexValue>();
          caller.method.parameters.forEach((p,i)=>env.set(p,runtimeParameter(p,caller.method.parameterTypes?.[i],"Runtime caller parameter: "+p)));
          const previousMethod:IndexedApexMethod|undefined=this.currentMethod;
          this.currentMethod=caller.method;
          try{this.execute(caller.method.body,[{values:env}],0);}
          finally{this.currentMethod=previousMethod;}
          if((this.captures.get(site.offset)?.length??0)+(this.skippedInvocations.get(site.offset)??0)===before)
            this.failures.set(site.offset,
              "Private helper caller did not establish a complete query execution context.");
          if(this.exceeded)break;
        }
      }else{
        const env=new Map<string,ApexValue>();
        owner.parameters.forEach((p,i)=>env.set(p,runtimeParameter(p,owner.parameterTypes?.[i],"Runtime method parameter: "+p)));
        // Restrict the query's root method to statements that can affect its
        // argument. Calls and opaque operations are deliberately retained.
        this.activeSlice=invocationDependencySlice(owner.body,site.offset,
          site.arguments.join(" "));
        this.execute(owner.body,[{values:env}],0);
        this.activeSlice=undefined;
      }
      if(!this.exceeded && !this.failures.has(site.offset) &&
          !(this.captures.get(site.offset)?.length)&&!this.skippedInvocations.has(site.offset)){
        // A sliced method may omit a side-effecting control-flow dependency.
        // Retry without slicing rather than misreporting a recognized query
        // as an invocation outside a method. Unproven values remain unknown.
        this.budget.reset();
        this.activeSlice=undefined;
        this.activeStopOffset=site.offset;
        const env=new Map<string,ApexValue>();
        owner.parameters.forEach((name,i)=>env.set(name,runtimeParameter(name,owner.parameterTypes?.[i],"Runtime method parameter: "+name)));
        this.execute(owner.body,[{values:env}],0);
      }
      if(this.exceeded){
        this.failures.set(site.offset,
          "This execution site's dependency path exceeded its bounded analysis budget: "+this.budget.reason);
        anyExceeded=true;
        // A bounded helper summary should not be reused for another site.
        this.summaries.clear();
        this.captures.delete(site.offset);
      }else if(!this.failures.has(site.offset)&&!this.captures.get(site.offset)?.length&&
        this.skippedInvocations.has(site.offset)){
        unreachable.add(site.offset);
      }
    }
    this.currentMethod=undefined;
    this.activeStopOffset=undefined;
    this.activeQueryOffset=undefined;
    this.activeSlice=undefined;
    return {captures:this.captures,unreachable,exceeded:anyExceeded,failures:this.failures};
  }
}
