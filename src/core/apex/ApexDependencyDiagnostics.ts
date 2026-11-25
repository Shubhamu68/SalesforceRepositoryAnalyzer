import {sourceLine} from "./ApexSourceModel.js";

/** Opt-in, source-only diagnostic. No expression text, values, metadata
 * responses, absolute paths or raw provider/exception reasons. */
export interface ApexDependencyDiagnostic {
  code:string;
  file:string;
  line:number;
  method?:string;
  symbol?:string;
  depth:number;
  count?:number;
}
export type ApexDependencyObserver=(event:ApexDependencyDiagnostic)=>void;
export function sourceFileName(filePath:string):string{
  const name=filePath.split(/[\\/]/).at(-1)??"";
  return /^[A-Za-z0-9_.-]{1,180}$/.test(name)?name:"<source>";
}
export function sourceIdentifier(name?:string):string|undefined{
  return name&&/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(name)?name:undefined;
}
export function reportApexDependency(observer:ApexDependencyObserver|undefined,code:string,
  frame:{filePath:string;source:string;depth:number;method?:{name:string}},offset:number,symbol?:string,count?:number):void{
  if(!observer)return;
  observer({code,file:sourceFileName(frame.filePath),line:sourceLine(frame.source,offset),
    method:sourceIdentifier(frame.method?.name),symbol:sourceIdentifier(symbol),depth:frame.depth,
    ...(count===undefined?{}:{count})});
}


/** Compact, source-only blockers for normal user-facing analysis. Unlike a
 * verbose trace, this retains no progress events or runtime values. A blocker
 * is a limit of the proof, not an assertion that the Apex code is defective.
 * Multiple candidate paths can contribute blockers; do not claim causality
 * or that every invocation has the same dependency. */
const blockerGroups:readonly {codes:readonly string[];label:string;limit?:number}[]=[
  {codes:["NO_PROVEN_CALLER","NO_REPOSITORY_INDEX","METADATA_SELECTOR_RUNTIME"],label:"Runtime inputs could not be established from available source evidence",limit:4},
  {codes:["METADATA_RECORD_UNRESOLVED","METADATA_MEMBER_UNAVAILABLE","METADATA_ROWS_UNAVAILABLE","METADATA_RESULT_UNAVAILABLE","METADATA_MEMBER_INVALID"],label:"Custom Metadata record or member could not be established",limit:2},
  {codes:["SHARED_HELPER_ARGUMENT_UNPROVEN","HELPER_ARGUMENT_UNPROVEN","HELPER_MUTABLE_ARGUMENT"],label:"Helper arguments are runtime-dependent or otherwise unproven",limit:3},
  {codes:["CLASS_MEMBER_UNPROVEN","NO_LOCAL_OR_PARAMETER_DEFINITION","CONSTANT_UNRESOLVED","NO_INITIALIZER","DECLARATION_AMBIGUOUS"],label:"Class member or variable value could not be established",limit:3},
  {codes:["CALLER_DEPTH_LIMIT","WORK_LIMIT","EDGE_OR_ROW_LIMIT","COLLECTION_SIZE_LIMIT","VARIABLE_CYCLE"],label:"Dependency analysis reached a supported traversal or size limit"},
  {codes:["DESCRIBE_UNAVAILABLE","DESCRIBE_OBJECT_UNPROVEN","LABEL_UNAVAILABLE","GUARD_MAP_UNPROVEN","RUNTIME_LOOP_DOMAIN_UNPROVEN"],label:"Required metadata or schema validation could not be established"},
  {codes:["LOOP_EFFECT_UNSUPPORTED","RUNTIME_LOOP_EFFECT_UNPROVEN","RUNTIME_LOOP_TYPE_UNPROVEN","LOOP_SHAPE_UNSUPPORTED"],label:"Loop effects or iteration shape are not proven"},
  {codes:["MAP_ALIAS_OR_WRITE","METADATA_ALIAS_OR_WRITE","COLLECTION_ALIAS_OR_WRITE","COLLECTION_ALIAS","SCALAR_WRITE_UNSUPPORTED","SELF_REFERENTIAL_APPEND","GUARD_DEPENDS_ON_TARGET","GUARD_CALL_UNSUPPORTED"],label:"Assignment, reference effect or guard could not be proven",limit:2},
  {codes:["SHARED_HELPER_UNPROVEN","HELPER_RETURN_UNPROVEN","HELPER_INPUT_MODIFIED"],label:"Helper return or input preservation could not be proven"},
  {codes:["UNSUPPORTED_CALL","UNSUPPORTED_MEMBER","UNSUPPORTED_ALLOCATION","UNSUPPORTED_OTHER","UNSUPPORTED_INLINE_QUERY","READ_OPERATION_UNPROVEN","READ_COLLECTION_UNPROVEN"],label:"Expression or operation is outside proven evaluator support",limit:2},
  {codes:["LEXICAL_PATH_UNSUPPORTED","OPAQUE_CONTROL_FLOW","CONTROL_FLOW_UNSUPPORTED","NO_INDEXED_METHOD"],label:"Lexical execution path could not be established"},
  {codes:["SHADOWED_PLATFORM_CLASS","SHADOWED_STRING"],label:"Platform class identity is not proven"},
  {codes:["LOOP_ITERABLE_UNPROVEN","COLLECTION_ADDITION_UNPROVEN","COLLECTION_MEMBER_UNKNOWN","COLLECTION_COPY_UNKNOWN","RUNTIME_COLLECTION_ONLY","JOIN_RUNTIME_MEMBERS","JOIN_INPUT_UNPROVEN","JOIN_CONSUMER_REJECTED","JOIN_ARITY","CONDITIONAL_APPEND_UNRESOLVED","WRITE_OR_ALIAS_UNSUPPORTED"],label:"Collection members, joined values or conditional changes remain unproven"}
];
const groupByCode=new Map(blockerGroups.flatMap((g,i)=>g.codes.map(code=>[code,i] as const)));
export function collectApexDependencyBlockers(){
  const groups=new Map<number,ApexDependencyDiagnostic[]>();
  // Caller eligibility counters are attached only to a matching parameter
  // location, never inferred from another method or another caller frame.
  const callerStats=new Map<string,{indexed?:number;eligible?:number}>();
  const location=(e:ApexDependencyDiagnostic)=>[e.file,e.line,e.method,e.symbol,e.depth].join("|");
  const observe:ApexDependencyObserver=e=>{
    const key=location(e);
    if(e.code==="CALLER_INDEX_CANDIDATES"||e.code==="CALLER_SOURCE_ELIGIBLE"){
      if(!callerStats.has(key)&&callerStats.size>=64)return;
      const stats=callerStats.get(key)??{};
      if(e.code==="CALLER_INDEX_CANDIDATES")stats.indexed=e.count;
      else stats.eligible=e.count;
      callerStats.set(key,stats);return;
    }
    const id=groupByCode.get(e.code);if(id===undefined)return;
    const entries=groups.get(id)??[];
    if(entries.length>=(blockerGroups[id].limit??2)||entries.some(old=>location(old)===key))return;
    entries.push(e);groups.set(id,entries);
  };
  const describe=(e:ApexDependencyDiagnostic)=>{
    const symbol=e.symbol?e.symbol+" ":"";
    const where="("+e.file+":"+e.line+(e.method?", "+e.method+"()":"")+")";
    const stats=callerStats.get(location(e));
    const caller=e.code==="NO_PROVEN_CALLER"&&stats?.indexed!==undefined&&stats.indexed>0&&stats.eligible===0
      ?" — "+stats.indexed+" indexed caller(s), none eligible for backward tracing"
      :e.code==="NO_PROVEN_CALLER"?" — no proven source caller":"";
    return symbol+where+caller;
  };
  const summarize=():string|undefined=>{
    const ids=[...groups.keys()].sort((a,b)=>a-b);
    if(!ids.length)return undefined;
    // Higher priority evidence first; downstream symptoms must not obscure
    // a runtime parameter or a more concrete metadata/mutation blocker.
    const specific=ids.filter(i=>i!==blockerGroups.length-1);
    const selected=(specific.length?specific:ids).slice(0,4);
    return selected.map(i=>blockerGroups[i].label+": "+groups.get(i)!.map(describe).join(", ")+".").join(" ")+
      (specific.length>selected.length?" Additional dependency limitations remain.":"");
  };
  return {observe,summarize};
}
