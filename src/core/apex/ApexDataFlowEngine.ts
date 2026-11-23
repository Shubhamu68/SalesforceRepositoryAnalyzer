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
  constructor(readonly source:string,options:ApexFlowOptions={}) {
    this.options={maxPaths:options.maxPaths??DEFAULT_PATHS,
      maxOperations:options.maxOperations??DEFAULT_OPERATIONS,
      maxDepth:options.maxDepth??DEFAULT_DEPTH,...options};
    const masked=maskApexSource(source);
    this.sites=findCalls(source,masked);
    this.methods=indexApexMethods(source);
  }
  private evaluate(expr:string, state:State, depth:number):ApexValue {
    const context:ApexExpressionContext={values:state.values,
      resolveCall:(name,args)=>{
        const external=this.options.resolveExternal?.(name,args);
        if(external!==undefined)return external;
        const ownName=name.replace(/^this\./i,"");
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===ownName.toLowerCase()
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
        const result=this.execute(candidates[0].body,[{values:env}],depth+1);
        this.activeCalls.delete(key);
        let value:ApexValue;
        if(result.returns.length===0)value=unknown("Helper has no provable returned value: "+ownName);
        else if(result.returns.some(v=>v.kind!=="text"))value=unknown("Helper returns unknown query fragment: "+ownName);
        else {
          const alternatives=[...new Set(result.returns.flatMap(v=>v.kind==="text"?v.values:[]))];
          value=alternatives.length>this.options.maxPaths
            ?unknown("Too many helper return alternatives.")
            :{kind:"text",values:alternatives};
        }
        this.summaries.set(key,value);
        return value;
      }};
    return evaluateApexExpression(expr,context);
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
    const assignment=/^(?:(?:(?:final|static|public|private|protected|global)\s+)*(?:[\w.<>,?\[\]]+\s+))?([A-Za-z_]\w*)\s*(\+?=)\s*([\s\S]+)$/i.exec(original);
    if(assignment){
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
        }else state.values.set(name,unknown("Cannot determine += value of "+name));
      }
      return;
    }
    const declaration=/^(?:final\s+)?(?:String|List<[^>]+>|Set<[^>]+>|Integer|Boolean)\s+([A-Za-z_]\w*)$/i.exec(original);
    if(declaration)state.values.set(declaration[1],unknown("Declared but not assigned."));
  }
  private runNode(node:SourceNode,state:State,depth:number):
    {states:State[];returns:ApexValue[]}{
    if(state.stopped)return {states:[state],returns:[]};
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
      const next:State[]=[];
      for(const state of states){
        const result=this.runNode(node,state,depth);
        next.push(...result.states);returns.push(...result.returns);
      }
      if(next.length>this.options.maxPaths){
        this.exceeded=true;
        states=[{values:new Map([...next[0].values.keys()].map((k):[string,ApexValue]=>[k,
          unknown("Query path enumeration budget exceeded.")]))}];
      }else states=next;
    }
    return {states,returns};
  }
  /** Every method is an entry candidate; unknown public input is not guessed. */
  analyze(): {captures:Map<number,ApexCallValue[]>; exceeded:boolean} {
    for(const method of this.methods){
      const env=new Map<string,ApexValue>();
      for(const p of method.parameters)env.set(p,unknown("Runtime method parameter: "+p));
      this.execute(method.body,[{values:env}],0);
    }
    return {captures:this.captures,exceeded:this.exceeded};
  }
}
