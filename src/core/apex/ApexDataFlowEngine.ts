import {
  indexApexMethods, maskApexSource, matchingPair, sourceLine, splitApexTopLevel,
  type IndexedApexMethod, type SourceNode,
} from "./ApexSourceModel.js";
import {
  evaluateApexExpression, listValue, textValue, unknown,
  type ApexEnvironment, type ApexValue, type ApexExpressionContext,
} from "./ApexValueEvaluator.js";

/** Capture is by source offset, not file+line, so alternatives never collide. */
export interface ApexCallSite {
  offset: number;
  line: number;
  method: string;
  argument: string;
  accessLevelArgument?: string;
}
export interface ApexCallValue {
  site: ApexCallSite;
  query: ApexValue;
  accessLevel: ApexValue;
}
export interface ApexFlowOptions {
  /** Pluggable read-only, preloaded metadata or constant value source. */
  resolveExternal?: (name: string, args: ApexValue[]) => ApexValue | undefined;
  maxPaths?: number;
  maxOperations?: number;
  maxDepth?: number;
}
interface State { values: ApexEnvironment; stopped?: boolean }
interface FrameResult { states: State[]; returns: ApexValue[] }

/** Shared declaration recognizer for source slicing and symbolic execution. */
function trackedStandaloneDeclaration(statement:string):string|undefined {
  return /^(?:final\s+)?(?:String|List<[^>]+>|Set<[^>]+>|Integer|Boolean)\s+([A-Za-z_]\w*)\s*;?\s*$/i
    .exec(statement.trim())?.[1];
}

/** Identical symbolic states do not represent additional structural query variants. */
function mergeEquivalentStates(states:State[]):State[] {
  const distinct=new Map<string,State>();
  for(const state of states) {
    const variables=[...state.values.entries()].sort(([a],[b])=>a.localeCompare(b));
    const key=JSON.stringify([state.stopped===true,variables]);
    if(!distinct.has(key))distinct.set(key,state);
  }
  return [...distinct.values()];
}

/**
 * Query-site backward dependency slice. Only simple, provably side-effect-free
 * statements are eligible for pruning. Calls, control-flow exits and opaque
 * Apex remain live unless explicitly demonstrated irrelevant.
 */
function queryDependencySlice(nodes:SourceNode[], offset:number, expression:string):Set<SourceNode> {
  const live=new Set<SourceNode>();
  const relevant=new Set<string>();
  const identifiers=(text:string):string[]=>[...maskApexSource(text).matchAll(/\b[A-Za-z_]\w*\b/g)]
    .map(match=>match[0]);
  for(const name of identifiers(expression))relevant.add(name);
  const mark=(node:SourceNode):boolean=>{
    if(node.start>offset)return false;
    const isTarget=node.start<=offset&&node.end>offset;
    if(node.kind==="opaque"){live.add(node);return true;}
    if(node.kind==="statement") {
      const statement=(node.text??"").trim();
      const includesCall=isTarget||/\bDatabase\s*\.\s*(?:query|countQuery|getQueryLocator)/i.test(statement);
      const terminates=/^(?:return|throw|break|continue)\b/i.test(statement);
      const assignment=/\b([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]+?);?\s*$/.exec(statement);
      const mutation=/\b([A-Za-z_]\w*)\s*\.\s*(?:add|addAll|clear|remove|put|putAll)\s*\(/i.exec(statement);
      const write=assignment?.[1]??mutation?.[1];
      // Keeping a referenced outer declaration preserves its lexical scope:
      // otherwise branch cleanup incorrectly deletes assignments to it.
      const declaration=trackedStandaloneDeclaration(statement);
      // Methods may mutate collections by reference or instance state.
      // Keep calls until an explicit side-effect model proves them harmless.
      const containsCall=/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(/.test(maskApexSource(statement));
      const safeDebug=/^System\.debug\s*\(/i.test(statement);
      const needed=includesCall||terminates||(write!==undefined&&relevant.has(write))||
        (declaration!==undefined&&relevant.has(declaration))||
        (containsCall&&!safeDebug)||(!write&&/[\[\]{}]/.test(statement));
      if(!needed)return false;
      live.add(node);
      if(write!==undefined&&relevant.has(write)) {
        for(const name of identifiers(assignment?.[3]??statement))relevant.add(name);
      }
      // A retained unknown call may mutate a relevant collection or shared state.
      if(containsCall&&!safeDebug)for(const name of identifiers(statement))relevant.add(name);
      return true;
    }
    let childNeeded=false;
    const children=[...(node.body??[]),...(node.otherwise??[])];
    for(let i=children.length-1;i>=0;i--)if(mark(children[i]))childNeeded=true;
    const condition=(node.condition??"")+" "+(node.iterable??"");
    const conditionCalls=[...maskApexSource(condition).matchAll(
      /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)].map(match=>match[1]);
    const opaqueCondition=conditionCalls.some(name=>
      !/^(?:String\.(?:isBlank|isNotBlank)|Math\.\w+)$/i.test(name));
    const needed=isTarget||childNeeded||opaqueCondition;
    if(needed) {
      live.add(node);
      if(childNeeded)for(const name of identifiers(condition))relevant.add(name);
    }
    return needed;
  };
  for(let i=nodes.length-1;i>=0;i--)mark(nodes[i]);
  return live;
}
const EXECUTION = /\bDatabase\s*\.\s*(queryWithBinds|countQueryWithBinds|getQueryLocatorWithBinds|query|countQuery|getQueryLocator)\s*\(/gi;
const DEFAULT_PATHS = 32, DEFAULT_OPERATIONS = 5000, DEFAULT_DEPTH = 6;
const MAX_LOOP_ITEMS = 100;

function clone(state:State):State {return {values:new Map(state.values),stopped:state.stopped};}
function bool(value: ApexValue): boolean | undefined {
  if(value.kind!=="text"||value.values.length!==1)return undefined;
  if(value.values[0]==="true")return true;
  if(value.values[0]==="false")return false;
  return undefined;
}
function asText(value:ApexValue):string|undefined {
  return value.kind==="text"&&value.values.length===1?value.values[0]:undefined;
}
function findCalls(source:string,masked:string):ApexCallSite[]{
  const sites:ApexCallSite[]=[];
  EXECUTION.lastIndex=0;
  let match:RegExpExecArray|null;
  while((match=EXECUTION.exec(masked))!==null){
    const open=masked.indexOf("(",match.index);
    const end=matchingPair(masked,open);
    if(end<0){
      sites.push({offset:match.index,line:sourceLine(source,match.index),
        method:match[1],argument:""});
      continue;
    }
    const args=splitApexTopLevel(source.slice(open+1,end),",");
    // Bracketed SOQL is already parsed by the existing static scanner.
    // Database.getQueryLocator([SELECT ...]) is not a string-built query.
    if(/^\s*\[\s*SELECT\b/i.test(args[0]??"")){
      EXECUTION.lastIndex=end+1;
      continue;
    }
    const index=/withbinds$/i.test(match[1])?2:1;
    sites.push({offset:match.index,line:sourceLine(source,match.index),
      method:match[1],argument:args[0]??"",
      ...(args[index]?{accessLevelArgument:args[index]}:{})});
    EXECUTION.lastIndex=end+1;
  }
  return sites;
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
  private readonly options: Required<Pick<ApexFlowOptions,"maxPaths"|"maxOperations"|"maxDepth">> & ApexFlowOptions;
  private readonly summaries = new Map<string,ApexValue>();
  private readonly activeCalls = new Set<string>();
  private operationCount = 0;
  private exceeded = false;
  /** Per-site failure attribution: a large unrelated method never taints other sites. */
  private readonly failures=new Map<number,string>();
  private activeStopOffset:number|undefined;
  private activeQueryOffset:number|undefined;
  private argumentProbe?: { offset:number; expressions:string[]; results:ApexValue[][] };
  /** Per-site, per-method optimization: never applied to helper summaries. */
  private activeSlice:Set<SourceNode>|undefined;
  private readonly className:string|undefined;
  constructor(readonly source:string,options:ApexFlowOptions={}) {
    this.options={maxPaths:options.maxPaths??DEFAULT_PATHS,
      maxOperations:options.maxOperations??DEFAULT_OPERATIONS,
      maxDepth:options.maxDepth??DEFAULT_DEPTH,...options};
    const masked=maskApexSource(source);
    this.className=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(masked)?.[1];
    this.sites=findCalls(source,masked);
    this.methods=indexApexMethods(source);
  }
  private evaluate(expr:string, state:State, depth:number):ApexValue {
    const context:ApexExpressionContext={values:state.values,
      resolveCall:(name,args)=>{
        const external=this.options.resolveExternal?.(name,args);
        if(external!==undefined)return external;
        const ownName=name.replace(/^this\./i,"");
        const sameClass=this.className&&ownName.startsWith(this.className+".")
          ?ownName.slice(this.className.length+1):ownName;
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===sameClass.toLowerCase()
          && m.parameters.length===args.length);
        if(candidates.length!==1)return undefined;
        if(depth>=this.options.maxDepth)return unknown("Apex helper recursion depth exceeded.");
        const key=candidates[0].start+"|"+JSON.stringify(args);
        if(this.activeCalls.has(key))return unknown("Recursive Apex helper call.");
        const cached=this.summaries.get(key);
        if(cached)return cached;
        this.activeCalls.add(key);
        const env=new Map<string,ApexValue>();
        candidates[0].parameters.forEach((p,i)=>env.set(p,args[i]));
        let result:FrameResult;
        try {
          result=this.execute(candidates[0].body,[{values:env}],depth+1);
        }finally{this.activeCalls.delete(key);}
        let value:ApexValue;
        if(result.returns.length===0||result.states.some(s=>!s.stopped))
          value=unknown("Helper has an execution path without a proven return: "+ownName);
        else if(result.returns.some(v=>v.kind==="unknown"))
          value=result.returns.find(v=>v.kind==="unknown")!;
        else if(result.returns.every(v=>v.kind==="text")){
          const alternatives=[...new Set(result.returns.flatMap(v=>v.kind==="text"?v.values:[]))];
          value=alternatives.length>this.options.maxPaths
            ?unknown("Too many helper return alternatives.")
            :{kind:"text",values:alternatives};
        }else{
          // A List/Set or number is safe only when every return path has the
          // same complete value. Never merge different collections by union.
          const distinct=new Map(result.returns.map(v=>[JSON.stringify(v),v]));
          value=distinct.size===1?distinct.values().next().value!:
            unknown("Helper returns incompatible collection or numeric alternatives: "+ownName);
        }
        this.summaries.set(key,value);
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
    if(!source.includes("(") || ![...state.values.values()].some(v=>v.kind==="collection"))return;
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
      const argumentText=source.slice(open+1,close);
      for(const [identifier,value] of state.values){
        if(value.kind!=="collection")continue;
        if(new RegExp("\\b"+identifier+"\\b").test(argumentText)){
          state.values.set(identifier,unknown(
            "Mutable collection "+identifier+" may be changed by unsupported method "+name+"."));
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
      const value=this.evaluate(site.argument,state,depth);
      const access=site.accessLevelArgument?
        this.evaluate(site.accessLevelArgument,state,depth):textValue("(default)");
      const captures=this.captures.get(site.offset)??[];
      captures.push({site,query:value,accessLevel:access});
      this.captures.set(site.offset,captures);
    }
  }
  private statement(node:SourceNode,state:State,depth:number):ApexValue|undefined{
    const original=(node.text??"").trim().replace(/;\s*$/,"");
    // Read arguments in the environment immediately before their invocation,
    // not after the containing assignment or nested helper mutates the state.
    if(this.argumentProbe && node.start<=this.argumentProbe.offset &&
        this.argumentProbe.offset<node.end) {
      this.argumentProbe.results.push(this.argumentProbe.expressions.map(expr=>
        this.evaluate(expr,state,depth)));
    }
    this.captureCalls(node.start,node.end,state,depth);
    if(!original)return;
    if(/^return\b/.test(original)){
      state.stopped=true;
      return this.evaluate(original.replace(/^return\s+/,""),state,depth);
    }
    // A tracked collection mutation preserves the source order of added values.
    const mutate=/^([A-Za-z_]\w*)\s*\.\s*(add|addAll|clear)\s*\(([\s\S]*)\)$/i.exec(original);
    if(mutate){
      const [,name,action,expr]=mutate;
      const existing=state.values.get(name);
      if(!existing||existing.kind!=="collection"){
        state.values.set(name,unknown("Collection "+name+" was mutated without a known initial value."));
        return;
      }
      if(action.toLowerCase()==="clear"){state.values.set(name,listValue([],existing.unique));return;}
      const value=this.evaluate(expr,state,depth);
      if(action.toLowerCase()==="add"){
        const item=asText(value);
        state.values.set(name,item===undefined?unknown("Collection item "+expr+" is unknown.")
          :listValue([...existing.items,item],existing.unique));
      }else state.values.set(name,value.kind==="collection"?
        listValue([...existing.items,...value.items],existing.unique):
        unknown("Collection addAll argument "+expr+" is unknown."));
      return;
    }
    // Declarations, reassignment and += are independently versioned by state.
    const assignment=/\b([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]+)$/.exec(original);
    const prefix=assignment?original.slice(0,assignment.index).trim():"";
    const validPrefix=!prefix || /^(?:(?:final|static|public|private|protected|global)\s+)*(?:[A-Za-z_]\w*(?:\s*<[\w\s,.<>?]+>)?(?:\[\])?)$/.test(prefix);
    if(assignment&&validPrefix){
      const [,name,operator,rhs]=assignment;
      const value=this.evaluate(rhs,state,depth);
      if(operator==="=")state.values.set(name,value);
      else {
        const former=state.values.get(name);
        if(former?.kind==="text"&&value.kind==="text"){
          const values:string[]=[];
          for(const l of former.values)for(const r of value.values){
            values.push(l+r);
            if(values.length>this.options.maxPaths){
              state.values.set(name,unknown("Too many += alternatives for "+name));
              return;
            }
          }
          state.values.set(name,{kind:"text",values:[...new Set(values)]});
        }else {
          const previousReason=former?.kind==="unknown"?former.reason:
            former?"Previous value is not a proven String.":"No proven previous assignment.";
          const appendedReason=value.kind==="unknown"?value.reason:
            value.kind!=="text"?"Appended expression is not a proven String.":undefined;
          state.values.set(name,unknown("Cannot determine += value of "+name+": "+
            [previousReason,appendedReason].filter(Boolean).join("; ")));
        }
      }
      this.taintCollectionsPassedToUnknownCalls(rhs,state);
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
  private runNode(node:SourceNode,state:State,depth:number):
    {states:State[];returns:ApexValue[]}{
    if(state.stopped)return {states:[state],returns:[]};
    if(depth===0&&this.activeSlice&&!this.activeSlice.has(node))return {states:[state],returns:[]};
    if(++this.operationCount>this.options.maxOperations){
      this.exceeded=true;
      return {states:[{values:new Map([...state.values.keys()].map((k):[string,ApexValue]=>
        [k,unknown("Apex operation budget exceeded.")]))}],returns:[]};
    }
    if(node.kind==="statement"){
      const result=this.statement(node,state,depth);
      return {states:[state],returns:result?[result]:[]};
    }
    const scoped=(nodes:SourceNode[]):FrameResult=>{
      const before=new Set(state.values.keys());
      const result=this.execute(nodes,[clone(state)],depth);
      for(const frame of result.states){
        // Locals introduced by a nested branch/block must not escape scope.
        // Assignments to existing symbols remain visible after the block.
        for(const key of frame.values.keys())
          if(!before.has(key))frame.values.delete(key);
      }
      return result;
    };
    if(node.kind==="block")return scoped(node.body??[]);
    if(node.kind==="if"){
      const condition=this.evaluate(node.condition??"",state,depth);
      const known=bool(condition);
      const paths=[...(known!==false?[scoped(node.body??[])]:[]),
        ...(known!==true?[scoped(node.otherwise??[])]:[])];
      return {states:paths.flatMap(x=>x.states),returns:paths.flatMap(x=>x.returns)};
    }
    if(node.kind==="for"){
      // A query may itself occur in the for-loop header.
      const headEnd=node.body?.[0]?.start??node.end;
      this.captureCalls(node.start,headEnd,state,depth);
      const iterable=node.iterable?this.evaluate(node.iterable,state,depth):unknown("Unsupported for-loop header");
      if(iterable.kind==="collection"&&node.loopVariable&&iterable.items.length<=MAX_LOOP_ITEMS){
        let states=[clone(state)], returns:ApexValue[]=[];
        for(const item of iterable.items){
          states=states.map(s=>{
            const child=clone(s);child.values.set(node.loopVariable!,textValue(item));return child;
          });
          const result=this.execute(node.body??[],states,depth);
          states=result.states; returns.push(...result.returns);
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
          const match=/\b([A-Za-z_]\w*)\s*(?:\+?=|\.\s*(?:add|addAll|clear)\s*\()/g;
          for(const entry of text.matchAll(match))mentioned.add(entry[1]);
          if(n.body)walk(n.body);
          if(n.otherwise)walk(n.otherwise);
        }
      };
      walk(node.body??[]);
      const changed=clone(state);
      for(const variable of mentioned)changed.values.set(variable,unknown("Loop may change "+variable+" using runtime values."));
      // If query occurs inside the body, capture an explicitly unknown version.
      for(const site of this.sites){
        if(site.offset<node.start||site.offset>=node.end)continue;
        if(this.captures.has(site.offset))continue;
        this.captures.set(site.offset,[{site,query:unknown("Query occurs in a runtime-dependent loop."),
          accessLevel:unknown("Loop execution context unknown.")}]);
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
    for(const node of nodes){
      // Only the source prefix leading to this execution site can contribute
      // to its query value. Helpers (depth>0) must evaluate their full body.
      if(depth===0&&this.activeStopOffset!==undefined&&node.start>this.activeStopOffset)break;
      if(this.exceeded)break;
      const next:State[]=[];
      for(const state of states){
        const result=this.runNode(node,state,depth);
        next.push(...result.states);returns.push(...result.returns);
      }
      const distinct=mergeEquivalentStates(next);
      if(distinct.length>this.options.maxPaths){
        this.exceeded=true;
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
    this.operationCount=0;
    this.exceeded=false;
    this.activeSlice=undefined;
    this.activeQueryOffset=undefined;
    this.activeStopOffset=undefined;
    const values=new Map<string,ApexValue>();
    method.parameters.forEach((name,index)=>values.set(name,args[index]));
    const result=this.execute(method.body,[{values}],1);
    if(this.exceeded)return unknown("Apex helper exceeds bounded analysis budget.");
    if(!result.returns.length || result.states.some(state=>!state.stopped))
      return unknown("Apex helper has an execution path without a proven return.");
    if(result.returns.some(value=>value.kind==="unknown"))
      return result.returns.find(value=>value.kind==="unknown")!;
    if(result.returns.every(value=>value.kind==="text")) {
      const alternatives=[...new Set(result.returns.flatMap(value=>
        value.kind==="text"?value.values:[]))];
      return alternatives.length<=this.options.maxPaths
        ?{kind:"text",values:alternatives}
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
    expressions:readonly string[]):ApexValue[][] {
    this.operationCount=0;
    this.exceeded=false;
    this.activeQueryOffset=undefined;
    this.activeStopOffset=offset;
    this.activeCalls.clear();
    this.summaries.clear();
    this.activeSlice=queryDependencySlice(method.body,offset,expressions.join(" + "));
    this.argumentProbe={offset,expressions:[...expressions],results:[]};
    const env=new Map<string,ApexValue>();
    method.parameters.forEach(name=>env.set(name,unknown("Runtime caller parameter: "+name)));
    this.execute(method.body,[{values:env}],0);
    const result=this.argumentProbe.results;
    this.argumentProbe=undefined;
    this.activeSlice=undefined;
    this.activeStopOffset=undefined;
    if(this.exceeded || !result.length)
      return [expressions.map(()=>unknown(this.exceeded
        ?"Caller argument path exceeds bounded analysis budget."
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
    exceeded:boolean;
    failures:Map<number,string>;
  } {
    let anyExceeded=false;
    for(const site of this.sites){
      this.operationCount=0;
      this.exceeded=false;
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
      const callers=owner.visibility==="private"
        ?this.privateCallers(owner):[];
      if(callers.length){
        // A private method cannot be invoked externally; every visible
        // call-site must supply a proven argument context to claim RESOLVED.
        for(const caller of callers){
          this.activeStopOffset=caller.offset;
          const before=this.captures.get(site.offset)?.length??0;
          const env=new Map<string,ApexValue>();
          for(const p of caller.method.parameters)
            env.set(p,unknown("Runtime caller parameter: "+p));
          this.execute(caller.method.body,[{values:env}],0);
          if((this.captures.get(site.offset)?.length??0)===before)
            this.failures.set(site.offset,
              "Private helper caller did not establish a complete query execution context.");
          if(this.exceeded)break;
        }
      }else{
        const env=new Map<string,ApexValue>();
        for(const p of owner.parameters)env.set(p,unknown("Runtime method parameter: "+p));
        // Restrict the query's root method to statements that can affect its
        // argument. Calls and opaque operations are deliberately retained.
        this.activeSlice=queryDependencySlice(owner.body,site.offset,
          site.argument+" "+(site.accessLevelArgument??""));
        this.execute(owner.body,[{values:env}],0);
        this.activeSlice=undefined;
      }
      if(this.exceeded){
        this.failures.set(site.offset,
          "This execution site's dependency path exceeded its bounded analysis budget.");
        anyExceeded=true;
        // A bounded helper summary should not be reused for another site.
        this.summaries.clear();
        this.captures.delete(site.offset);
      }
    }
    this.activeStopOffset=undefined;
    this.activeQueryOffset=undefined;
    this.activeSlice=undefined;
    return {captures:this.captures,exceeded:anyExceeded,failures:this.failures};
  }
}
