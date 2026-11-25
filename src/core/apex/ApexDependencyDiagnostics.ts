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
  {codes:["NO_PROVEN_CALLER","NO_REPOSITORY_INDEX","METADATA_SELECTOR_RUNTIME"],label:"Could not determine input values",limit:4},
  {codes:["METADATA_RECORD_UNRESOLVED","METADATA_MEMBER_UNAVAILABLE","METADATA_ROWS_UNAVAILABLE","METADATA_RESULT_UNAVAILABLE","METADATA_MEMBER_INVALID"],label:"Could not resolve Custom Metadata fields or records",limit:2},
  {codes:["SHARED_HELPER_ARGUMENT_UNPROVEN","HELPER_ARGUMENT_UNPROVEN","HELPER_MUTABLE_ARGUMENT"],label:"Could not determine inputs to helper methods",limit:3},
  {codes:["CLASS_MEMBER_UNPROVEN","NO_LOCAL_OR_PARAMETER_DEFINITION","CONSTANT_UNRESOLVED","NO_INITIALIZER","DECLARATION_AMBIGUOUS"],label:"Could not determine class member or variable values",limit:3},
  {codes:["CALLER_DEPTH_LIMIT","WORK_LIMIT","EDGE_OR_ROW_LIMIT","COLLECTION_SIZE_LIMIT","VARIABLE_CYCLE"],label:"Analysis reached a depth or size limit"},
  {codes:["SCHEMA_READ_UNPROVEN","DESCRIBE_UNAVAILABLE","DESCRIBE_OBJECT_UNPROVEN","LABEL_UNAVAILABLE","GUARD_MAP_UNPROVEN","RUNTIME_LOOP_DOMAIN_UNPROVEN"],label:"Could not verify required metadata or schema"},
  {codes:["LOOP_EFFECT_UNSUPPORTED","RUNTIME_LOOP_EFFECT_UNPROVEN","RUNTIME_LOOP_TYPE_UNPROVEN","LOOP_SHAPE_UNSUPPORTED"],label:"Could not determine how the loop changes values"},
  {codes:["MAP_ALIAS_OR_WRITE","METADATA_ALIAS_OR_WRITE","COLLECTION_ALIAS_OR_WRITE","COLLECTION_ALIAS","SCALAR_WRITE_UNSUPPORTED","SELF_REFERENTIAL_APPEND","GUARD_DEPENDS_ON_TARGET","GUARD_CALL_UNSUPPORTED"],label:"Could not verify assignments, shared references or conditions",limit:2},
  {codes:["SHARED_HELPER_UNPROVEN","HELPER_RETURN_UNPROVEN","HELPER_INPUT_MODIFIED","SHARED_HELPER_EFFECT_UNPROVEN"],label:"Could not verify helper results or changes to inputs"},
  {codes:["UNSUPPORTED_CALL","UNSUPPORTED_MEMBER","UNSUPPORTED_ALLOCATION","UNSUPPORTED_OTHER","UNSUPPORTED_INLINE_QUERY","READ_OPERATION_UNPROVEN","READ_COLLECTION_UNPROVEN"],label:"The analyzer could not resolve this expression or operation",limit:2},
  {codes:["LEXICAL_PATH_UNSUPPORTED","OPAQUE_CONTROL_FLOW","CONTROL_FLOW_UNSUPPORTED","NO_INDEXED_METHOD"],label:"Could not follow this execution path"},
  {codes:["SHADOWED_PLATFORM_CLASS","SHADOWED_STRING"],label:"Could not confirm which platform class is used"},
  {codes:["LOOP_ITERABLE_UNPROVEN","COLLECTION_ADDITION_UNPROVEN","COLLECTION_MEMBER_UNKNOWN","COLLECTION_COPY_UNKNOWN","RUNTIME_COLLECTION_ONLY","JOIN_RUNTIME_MEMBERS","JOIN_INPUT_UNPROVEN","JOIN_CONSUMER_REJECTED","JOIN_ARITY","CONDITIONAL_APPEND_UNRESOLVED","WRITE_OR_ALIAS_UNSUPPORTED"],label:"Could not resolve collection values, joins or conditional changes"}
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
  const callerDetail=(e:ApexDependencyDiagnostic)=>{
    const stats=callerStats.get(location(e));
    return e.code==="NO_PROVEN_CALLER"&&stats?.indexed!==undefined&&stats.indexed>0&&stats.eligible===0
      ?stats.indexed+" caller"+(stats.indexed===1?" found":"s found")+", none could be analyzed"
      :e.code==="NO_PROVEN_CALLER"?"no source caller could be verified":"";
  };
  // Print the class/method once per group and combine symbols at the same
  // line with the same caller status. Keep every retained source location.
  const describe=(entries:readonly ApexDependencyDiagnostic[])=>{
    const files=new Map<string,{file:string;method?:string;locations:Map<string,{line:number;detail:string;symbols:string[]}>}>();
    for(const e of entries){
      const key=[e.file,e.method].join("|");
      const file=files.get(key)??{file:e.file,method:e.method,locations:new Map()};
      const detail=callerDetail(e),locKey=e.line+"|"+detail;
      const loc=file.locations.get(locKey)??{line:e.line,detail,symbols:[]};
      if(e.symbol&&!loc.symbols.includes(e.symbol))loc.symbols.push(e.symbol);
      file.locations.set(locKey,loc);files.set(key,file);
    }
    return [...files.values()].map(file=>file.file+(file.method?" / "+file.method+"()":"")+": "+
      [...file.locations.values()].map(loc=>(loc.symbols.length?loc.symbols.join(", ")+" (line "+loc.line+")":"line "+loc.line)+
        (loc.detail?" — "+loc.detail:"")).join("; ")).join("; ");
  };
  const summarize=():string|undefined=>{
    const ids=[...groups.keys()].sort((a,b)=>a-b);
    if(!ids.length)return undefined;
    // Higher priority evidence first; downstream symptoms must not obscure
    // a runtime parameter or a more concrete metadata/mutation blocker.
    const specific=ids.filter(i=>i!==blockerGroups.length-1);
    const selected=(specific.length?specific:ids).slice(0,4);
    return selected.map(i=>blockerGroups[i].label+": "+describe(groups.get(i)!)+".").join(" ")+
      (specific.length>selected.length?" Other unresolved dependencies also remain.":"");
  };
  return {observe,summarize};
}
