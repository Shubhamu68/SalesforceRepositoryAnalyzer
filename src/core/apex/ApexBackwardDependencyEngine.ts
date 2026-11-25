import {indexApexMethods,maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {canonicalApexType,parseApexDeclaration,selectApexOverload,type ApexCallResolver} from "./ApexTypeSystem.js";
import {ApexDataFlowEngine} from "./ApexDataFlowEngine.js";
import {directEffectInvocation,memberEffectModel} from "./ApexMemberEffectModel.js";
import {addApexValues,evaluateApexExpression,listValue,runtimeParameter,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import type {ApexRepositoryMethodIndex,ApexCallerSource} from "./ApexRepositoryMethodIndex.js";
import {countApex} from "./ApexPerformance.js";
import {readApexReadOperation} from "./ApexReadOperations.js";
import {evaluateApexReadOperation} from "./ApexValueEvaluator.js";
import {applyApexStringCollectionMutation,apexIterationValues,mergeApexRuntimeMembers,proveApexAddOnlyIteration,evaluateApexCollectionGuard,isExactMetadataStringList,type ApexRuntimeCollectionMembers} from "./ApexCollectionOperations.js";
import {knownBoolean} from "./ApexScalarOperators.js";
import {evaluateSchemaExpression,evaluateSchemaGlobalGuard,schemaReceiverEligible,isSchemaFieldMap,mutateSchemaFieldMap} from "./ApexSchemaModel.js";
import {metadataSelectorHelper} from "./ApexCustomMetadataQueryModel.js";
import {reportApexDependency,type ApexDependencyObserver} from "./ApexDependencyDiagnostics.js";

const clean=(s:string)=>stripApexComments(s).trim();
const identifier=/^[A-Za-z_]\w*$/;
const scalar=/^(?:id|integer|long|decimal|double|boolean|date|datetime)$/i;
const rx=(name:string)=>new RegExp("\\b"+name+"\\b","i");
const one=(v:ApexValue)=>v.kind==="text"&&v.values.length===1&&!v.scalarType?v.values[0]:undefined;
const stop=(reason:string)=>unknown("Apex backward dependency: "+reason);
const MAX_EDGES=64,MAX_DEPTH=6,MAX_WORK=2400,MAX_COLLECTION_ITEMS=2000,MAX_EFFECT_SUMMARIES=32;
const effectPlatforms=["String","List","Set","Map","Math","System","Schema","JSON","Label","Database"];
const scalarEffectInput=(v:ApexValue)=>v.kind==="number"||v.kind==="null"||v.kind==="text"&&v.values.length===1;
/** A source-derived candidate, never a proof of the exact runtime value.
 * Add-only collection unions and consumer-approved conditional merges may
 * contain members from multiple branches. Keep this evidence separate from
 * ApexDataFlowEngine execution states and repository helper value caches. */
export interface ApexDependencyEvidence<A=never> {
  readonly value:ApexValue;
  readonly annotations:readonly A[];
  /** Known candidate members plus possible additional runtime strings.
   * Never consumed as an exact collection by the generic join evaluator. */
  readonly runtimeMembers?:ApexRuntimeCollectionMembers;
  /** Proven schema Describe snapshot identity, not inferred from its contents. */
  readonly describeObject?:string;
}
export interface ApexDependencyExpressionContext {
  readonly source:string;
  readonly methods:readonly IndexedApexMethod[];
  readonly method:IndexedApexMethod;
  readonly expression:string;
  readonly offset:number;
}
export interface ApexDependencyAppend<A=never>{
  readonly evidence:ApexDependencyEvidence<A>;
  readonly conditional:boolean;
}
/** Consumer policy: interpretation of a candidate is never an Apex rule.
 * Defaults resolve ordinary String.join and leave conditional String merges
 * unknown. Enumerating unfiltered configuration candidates is opt-in. */
export interface ApexDependencyPolicy<A=never>{
  abstractExpression?(context:ApexDependencyExpressionContext):ApexValue|undefined;
  join?(collection:ApexDependencyEvidence<A>,separator:string):ApexDependencyEvidence<A>|undefined;
  mergeConditionalAppends?(base:ApexDependencyEvidence<A>,additions:readonly ApexDependencyAppend<A>[]):ApexDependencyEvidence<A>|undefined;
  allowMetadataCandidateRows?:boolean;
  /** Diagnostic-only observer; not consulted by any proof or selection rule. */
  observe?:ApexDependencyObserver;
}
export interface ApexDependencyTrace<A=never>{
  readonly kind:"SOURCE_CANDIDATES";
  readonly candidates:readonly ApexDependencyEvidence<A>[];
  readonly bounded:boolean;
  readonly callerEdges:number;
  readonly metadataRows:number;
}
interface Frame {filePath:string;source:string;methods:readonly IndexedApexMethod[];method:IndexedApexMethod;key:string;depth:number;ancestors:readonly string[]}
type Row=Array<[string,ApexValue]>;
type Choice={kind:"caller";edge:ApexCallerSource}|{kind:"row";row:Row};
class Expand {constructor(readonly key:string,readonly choices:readonly Choice[]){}}
class Bounded extends Error{}

function frameIdentity(frame:Frame){return frame.filePath+"@"+frame.method.start;}
/** Prefix of the selected lexical path only. No sibling branch statements
 * become unconditional definitions. Loops containing the use are deferred. */
function prefixAt(nodes:readonly SourceNode[],offset:number,allowLoop?:(node:SourceNode)=>boolean):SourceNode[]|undefined{
  const prefix:SourceNode[]=[];
  for(const node of nodes){
    if(node.end<=offset){prefix.push(node);continue;}
    // At the exact entry of a node, its effects have not occurred.
    if(node.start>=offset)return prefix;
    if(node.kind==="statement")return prefix;
    if(node.kind==="if"||node.kind==="block"||(node.kind==="for"&&allowLoop?.(node))){
      for(const child of [node.body??[],node.otherwise??[]]){
        if(child.some(n=>n.start<=offset&&offset<n.end)){
          const prior=prefixAt(child,offset,allowLoop);return prior?[...prefix,...prior]:undefined;
        }
      }
    }
    return undefined;
  }
  return prefix;
}
/** Demand-driven source dependency traversal, shared by analysis consumers.
 * Correlates caller vectors and metadata rows; does not execute Apex or infer
 * operation-specific permissions. All outputs are bounded source candidates. */
export function traceApexDependencies<A=never>(source:string,filePath:string,use:{expression:string;offset:number},
  index?:ApexRepositoryMethodIndex,resolveExternal?:ApexCallResolver,policy:ApexDependencyPolicy<A>={}):ApexDependencyTrace<A>{
  type Evidence=ApexDependencyEvidence<A>;
  type Locals=ReadonlyMap<string,Evidence>;
  const ev=(value:ApexValue,annotations:readonly A[]=[],provenance:Pick<Evidence,"runtimeMembers"|"describeObject">={}):Evidence=>({value,annotations,...provenance});
  const concat=(a:Evidence,b:Evidence):Evidence=>ev(addApexValues(a.value,b.value),[...a.annotations,...b.annotations]);
  const methods=index?.indexedMethods(filePath,source)??indexApexMethods(source);
  const method=methods.filter(m=>m.start<=use.offset&&use.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  const empty:ApexDependencyTrace<A>={kind:"SOURCE_CANDIDATES",candidates:[],bounded:false,callerEdges:0,metadataRows:0};
  if(!method||/\bclass\s+(?:String|List|Set|Label)\b/i.test(maskApexSource(source))){
    reportApexDependency(policy.observe,!method?"NO_INDEXED_METHOD":"SHADOWED_PLATFORM_CLASS",{filePath,source,depth:0,method},use.offset);
    return empty;
  }
  const root:Frame={filePath,source,methods,method,key:"root",depth:0,ancestors:[]};
  let work=0,edges=0,metadataRows=0,bounded=false,effectSummaries=0;
  const effectEngines=new Map<string,ApexDataFlowEngine>();
  const found=new Map<string,Evidence>();
  const note=(frame:Frame,offset:number,code:string,symbol?:string,count?:number)=>
    reportApexDependency(policy.observe,code,frame,offset,symbol,count);
  const tick=()=>{if(++work>MAX_WORK)throw new Bounded("Backward dependency work limit");};
  const run=(choices:ReadonlyMap<string,Choice>)=>{
    const active=new Set<string>();
    const iterating=new Set<SourceNode>();
    // Identity-local provenance: an exact collection is not a candidate
    // union or an inventory of additional unknown runtime members.
    const exactCollections=new WeakSet<ApexValue>();
    const exact=(e:Evidence)=>e.value.kind==="collection"&&exactCollections.has(e.value)&&!e.annotations.length&&!e.runtimeMembers&&!e.describeObject;
    const exactValue=(e:Evidence)=>!e.annotations.length&&!e.runtimeMembers&&!e.describeObject&&scalarEffectInput(e.value);
    const mark=(value:ApexValue)=>{if(value.kind==="collection")exactCollections.add(value);return value;};
    const resolve=(frame:Frame,expression:string,offset:number,locals:Locals=new Map(),members:readonly string[]=[]):Evidence=>{
      tick();
      const expr=clean(expression);
      const reject=(reason:string,code:string,symbol?:string):ApexValue=>{
        note(frame,offset,code,symbol);return stop(reason);
      };
      if(!expr)return ev(reject("empty expression","EMPTY_EXPRESSION"));
      if(expr.startsWith("(")&&matchingPair(maskApexSource(expr),0)===expr.length-1)return resolve(frame,expr.slice(1,-1),offset,locals,members);
      if(/^'(?:\\.|[^'\\])*'$/s.test(expr)||/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map()}));
      if(identifier.test(expr)){
        const local=locals.get(expr.toLowerCase());
        if(local){note(frame,offset,"LOCAL_BINDING",expr);return local;}
        return variable(frame,expr,offset,locals,members);
      }
      const terms=splitApexTopLevel(expr,"+");
      if(terms.length>1){
        let result=resolve(frame,terms[0],offset,locals);
        for(const term of terms.slice(1))result=concat(result,resolve(frame,term,offset,locals));
        return result;
      }
      const join=/^String\s*\.\s*join\s*\(([\s\S]*)\)$/i.exec(expr);
      if(join){
        if(apexSymbols(frame.source,frame.methods).lookup(frame.method,"String",offset))return ev(reject("shadowed String","SHADOWED_STRING"));
        const args=splitApexTopLevel(join[1],",");
        if(args.length!==2)return ev(reject("join arity","JOIN_ARITY"));
        const list=resolve(frame,args[0],offset,locals),separator=one(resolve(frame,args[1],offset,locals).value);
        if(list.value.kind!=="collection"||separator===undefined||list.value.items.length>MAX_COLLECTION_ITEMS)return ev(reject("unproven joined collection","JOIN_INPUT_UNPROVEN"));
        if(policy.join)return policy.join(list,separator)??ev(reject("consumer cannot interpret joined collection","JOIN_CONSUMER_REJECTED"));
        if(list.runtimeMembers)return ev(reject("runtime collection additions cannot establish an exact joined String","JOIN_RUNTIME_MEMBERS"));
        return ev(evaluateApexExpression("String.join(items,separator)",{values:new Map<string,ApexValue>([["items",list.value],["separator",textValue(separator)]])}),list.annotations);
      }
      const create=/^new\s+(List|Set)\s*<\s*String\s*>\s*(?:\{([\s\S]*)\}|\(([\s\S]*)\))$/i.exec(expr);
      if(create){
        const unique=create[1].toLowerCase()==="set";
        if(create[2]!==undefined){
          const expressions=splitApexTopLevel(create[2],",").filter(s=>s.trim());
          const evidence=expressions.map(s=>resolve(frame,s,offset,locals));
          const values=evidence.map(e=>one(e.value));
          if(values.some(s=>s===undefined)||values.length>MAX_COLLECTION_ITEMS)return ev(reject("unknown collection member","COLLECTION_MEMBER_UNKNOWN"));
          const value=listValue(values as string[],unique);
          // Literal allocations have no incoming alias. Other candidate
          // expressions retain their existing inventory-only semantics.
          if(evidence.every(exactValue)&&expressions.every(s=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))))mark(value);
          return ev(value);
        }
        if(!create[3]?.trim())return ev(mark(listValue([],unique)));
        const input=resolve(frame,create[3],offset,locals);
        if(input.value.kind!=="collection")return ev(reject("unknown copied collection","COLLECTION_COPY_UNKNOWN"));
        const copy=listValue([...input.value.items],unique);
        if(exact(input))mark(copy);
        return ev(copy,input.annotations,input.runtimeMembers?{runtimeMembers:input.runtimeMembers}:{});
      }
      const abstraction=policy.abstractExpression?.({source:frame.source,methods:frame.methods,method:frame.method,expression:expr,offset});
      if(abstraction!==undefined){note(frame,offset,"CONSUMER_ABSTRACTION");return ev(abstraction);}
      // Read-only scalar/string operations and metadata calls reuse the
      // existing evaluator; inputs must be exact, never a synthesized query.
      // Reuse the forward evaluator for known literal maps and Describe snapshots.
      if(/^new\s+Map\s*<\s*(?:String|Integer)\s*,[\w\s,.<>]+\s*>\s*(?:\{[\s\S]*\}|\(\s*\))$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map()}));
      const describe=/^([A-Za-z_]\w*)\.SObjectType\.getDescribe\(\)\.fields\.getMap\(\)$/i.exec(expr);
      if(describe){
        if(apexSymbols(frame.source,frame.methods).hasLocalBinding(frame.method,describe[1],offset))
          return ev(reject("shadowed Describe object","DESCRIBE_OBJECT_UNPROVEN"));
        const value=evaluateApexExpression(expr,{values:new Map(),resolveCall:resolveExternal});
        const established=value.kind==="collection"||isSchemaFieldMap(value);
        note(frame,offset,established?"DESCRIBE_RESOLVED":"DESCRIBE_UNAVAILABLE");
        return ev(value,[],established?{describeObject:describe[1]}:{});
      }
      // Schema reads share the forward evaluator's typed metadata semantics.
      // Candidate unions, synthetic fragments and runtime collections never
      // become exact object/field identities.
      const symbolsForSchema=apexSymbols(frame.source,frame.methods);
      const schema=evaluateSchemaExpression(expr,{
        evaluate:part=>{
          const v=resolve(frame,part,offset,locals);
          return v.annotations.length||v.runtimeMembers||v.describeObject&&!isSchemaFieldMap(v.value)?stop("Schema input is not exact"):v.value;
        },
        resolveCall:resolveExternal,
        shadowed:root=>!!locals.get(root.toLowerCase())||symbolsForSchema.hasLocalBinding(frame.method,root,offset)||
          !!index?.hasSourceClass(root)||new RegExp("\\bclass\\s+"+root+"\\b","i").test(maskApexSource(frame.source)),
        receiverEligible:part=>locals.get(part.toLowerCase())?.value.kind==="schema"||
          schemaReceiverEligible(part,symbolsForSchema.lookup(frame.method,part,offset))
      });
      if(schema!==undefined){
        note(frame,offset,schema.kind==="unknown"?"SCHEMA_READ_UNPROVEN":"SCHEMA_READ_RESOLVED");
        return ev(schema);
      }
      const operation=readApexReadOperation(expr);
      if(operation&&!/^(?:String|Integer|Long|Decimal|Math|System|Schema)$/i.test(operation.receiver)){
        const value=resolve(frame,operation.receiver,offset,locals);
        const args=operation.args.map(arg=>resolve(frame,arg,offset,locals));
        if(value.value.kind==="unknown"||value.runtimeMembers||value.annotations.length||args.some(a=>a.value.kind==="unknown"||a.runtimeMembers||a.annotations.length))
          return ev(reject("non-exact operation receiver or argument","READ_OPERATION_UNPROVEN"));
        // A union of candidate collection members is not an exact collection.
        // Do not infer membership, position or cardinality from it.
        if(value.value.kind==="collection")
          return ev(reject("collection observation not proven","READ_COLLECTION_UNPROVEN"));
        const result=evaluateApexReadOperation(value.value,operation.name,args.map(a=>a.value));
        note(frame,offset,result.kind==="unknown"?"READ_OPERATION_UNPROVEN":"READ_OPERATION_RESOLVED",operation.name);
        return ev(result);
      }
      if(/^(?:System\.)?Label\.[A-Za-z_]\w*$/i.test(expr)){
        const value=evaluateApexExpression(expr,{values:new Map(),resolveCall:resolveExternal});
        note(frame,offset,value.kind==="text"?"LABEL_RESOLVED":"LABEL_UNAVAILABLE");
        return ev(value);
      }
      const member=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
      if(member){
        const bound=locals.get(member[1].toLowerCase());
        if(bound&&(bound.value.kind==="record"||bound.value.kind==="instance")&&!bound.annotations.length)
          return ev(evaluateApexExpression("item."+member[2],{values:new Map([["item",bound.value]])}));
        const type=apexSymbols(frame.source,frame.methods).lookup(frame.method,member[1],offset);
        if(type?.endsWith("__mdt")){
          const names=[...maskApexSource(frame.source.slice(frame.method.start,frame.method.end)).matchAll(new RegExp("\\b"+member[1]+"\\s*\\.\\s*([A-Za-z_]\\w*)","gi"))].map(m=>m[1]);
          const record=variable(frame,member[1],offset,locals,[...new Set([...members,...names,member[2]])]);
          if(record.value.kind==="record"){
            const field=record.value.entries.find(([key])=>key.toLowerCase()===member[2].toLowerCase());
            return ev(field?.[1]??reject("metadata member unavailable","METADATA_MEMBER_UNAVAILABLE",member[2]));
          }
          return ev(reject("metadata record unresolved","METADATA_RECORD_UNRESOLVED",member[2]));
        }
        // Constant resolution is allowed only for class-qualified names;
        // an unknown instance member is not an immutable static constant.
        if(!type&&resolveExternal)return ev(resolveExternal("Apex.constant",[textValue(expr)])??reject("unknown constant","CONSTANT_UNRESOLVED"));
      }
      const metadata=/^([A-Za-z_]\w*__mdt)\s*\.\s*getInstance\s*\(\s*([A-Za-z_]\w*|'(?:\\.|[^'\\])*')\s*\)$/i.exec(expr);
      if(metadata&&members.length&&members.length<=30&&resolveExternal){
        if(members.some(m=>!identifier.test(m)))return ev(reject("invalid metadata member","METADATA_MEMBER_INVALID"));
        const key=resolve(frame,metadata[2],offset,locals);
        const known=one(key.value);
        if(known===undefined&&!policy.allowMetadataCandidateRows)return ev(reject("metadata selector depends on runtime input","METADATA_SELECTOR_RUNTIME"));
        // One row per originating expression, even if a later member read
        // demands a different projection. Missing members remain unknown.
        const rowKey=frame.key+"|metadata|"+offset+"|"+expr;
        const selected=choices.get(rowKey);
        if(selected?.kind==="row")return ev({kind:"record",entries:selected.row});
        // All rows are a conservative candidate inventory only for a
        // source-proven getInstance selection. Never expand business data
        // or change the shared exact-filter interpreter.
        const select=[...new Set(["DeveloperName",...members])].join(",");
        const query="[SELECT "+select+" FROM "+metadata[1]+(known!==undefined?" WHERE DeveloperName = :name":"")+"]";
        note(frame,offset,known!==undefined?"METADATA_EXACT_REQUEST":"METADATA_CANDIDATE_REQUEST",metadata[1]);
        const rows=resolveExternal("Apex.metadataRows",[textValue(query),...(known!==undefined?[textValue(known)]:[])]);
        note(frame,offset,rows?.kind==="records"?"METADATA_ROWS_RETURNED":"METADATA_RESULT_UNAVAILABLE",metadata[1],rows?.kind==="records"?rows.items.length:undefined);
        if(rows?.kind!=="records"||!rows.items.length||rows.items.length>64)return ev(reject("authoritative metadata rows unavailable","METADATA_ROWS_UNAVAILABLE"));
        throw new Expand(rowKey,rows.items.map(row=>({kind:"row",row})));
      }
      // Exact, read-only Field Set expression with a source-known name.
      if(/^(?:Schema\.SObjectType\.[A-Za-z_]\w*\.fieldSets\.getMap\(\)\.get\('(?:\\.|[^'\\])*'\)\.getFields\(\)|[A-Za-z_]\w*\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\('(?:\\.|[^'\\])*'\)\.getFields\(\))$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map(),resolveCall:resolveExternal}));
      // Reuse the repository/metadata invocation resolver with source-level
      // overload hints. Only exact scalar arguments may cross this boundary:
      // candidate collection unions, synthetic slots and reference effects
      // are not exact Apex execution states. The legacy symbolic helper
      // path below remains available for its existing narrow evidence.
      const invocation=/^([A-Za-z_]\w*)(?:\s*\.\s*([A-Za-z_]\w*))?\s*\(([\s\S]*)\)$/i.exec(expr);
      if(invocation&&matchingPair(maskApexSource(expr),expr.indexOf("("))===expr.length-1){
        const symbols=apexSymbols(frame.source,frame.methods);
        const pieces=invocation[3].trim()?splitApexTopLevel(invocation[3],","):[];
        const hints=symbols.argumentTypes(frame.method,pieces,offset);
        const owner=symbols.ownerAt(frame.method.start);
        const qualified=!!invocation[2];
        const target=qualified?undefined:selectApexOverload(frame.methods.filter(m=>
          symbols.sameOwner(frame.method,m)&&m.name.toLowerCase()===invocation[1].toLowerCase()),pieces.length,hints);
        const name=qualified
          ?(!locals.has(invocation[1].toLowerCase())&&!symbols.lookup(frame.method,invocation[1],offset)&&
            !symbols.hasLocalBinding(frame.method,invocation[1],offset)?invocation[1]+"."+invocation[2]:undefined)
          :target?.isStatic&&owner&&identifier.test(owner)?owner+"."+target.name:undefined;
        if(name&&(index||resolveExternal)&&frame.depth<MAX_DEPTH){
          const args=pieces.map(arg=>resolve(frame,arg,offset,locals));
          const exact=args.every(a=>!a.annotations.length&&!a.runtimeMembers&&!a.describeObject&&
            (a.value.kind==="number"||a.value.kind==="null"||a.value.kind==="text"&&a.value.values.length===1));
          if(!exact&&policy.allowMetadataCandidateRows&&target&&resolveExternal&&members.length&&
            args.length===1&&args[0].value.kind==="unknown"&&!args[0].annotations.length&&!args[0].runtimeMembers&&
            !args[0].describeObject&&!index?.hasSourceClass("String")&&
            !/\bclass\s+String\b/i.test(maskApexSource(frame.source))&&
            !apexSymbols(frame.source,frame.methods).hasLocalBinding(target,"String",target.start)){
            const query=metadataSelectorHelper(target);
            if(query&&members.every(m=>query.fields.some(f=>f.toLowerCase()===m.toLowerCase()))){
              const rowKey=frame.key+"|metadata-selector|"+offset+"|"+target.start;
              const selected=choices.get(rowKey);
              if(selected?.kind==="row")return ev({kind:"record",entries:selected.row});
              note(frame,offset,"METADATA_SELECTOR_CANDIDATE_REQUEST",query.type);
              const rows=resolveExternal("Apex.metadataSelectorCandidates",[textValue(query.expression)]);
              note(frame,offset,rows?.kind==="records"?"METADATA_SELECTOR_ROWS_RETURNED":"METADATA_SELECTOR_ROWS_UNAVAILABLE",
                query.type,rows?.kind==="records"?rows.items.length:undefined);
              if(rows?.kind!=="records"||!rows.items.length||rows.items.length>MAX_EDGES){
                // Preserve the unresolved source-level helper input in the
                // consumer explanation when no candidate row is established.
                note(frame,offset,"SHARED_HELPER_ARGUMENT_UNPROVEN",target.name);
                return ev(reject("complete bounded metadata selector candidates unavailable","METADATA_SELECTOR_ROWS_UNAVAILABLE"));
              }
              throw new Expand(rowKey,rows.items.map(row=>({kind:"row",row})));
            }
          }
          if(exact){
            const values=args.map(a=>a.value);
            const result=resolveExternal?.(name,values,hints,frame.filePath)??index?.evaluateReturn(frame.filePath,name,values,resolveExternal,hints);
            if(result!==undefined){
              note(frame,offset,result.kind==="unknown"?"SHARED_HELPER_UNPROVEN":"SHARED_HELPER_RESOLVED",invocation[2]??invocation[1]);
              // A complete return summary is not a reference-effect proof.
              // Never transfer instances or multiple text alternatives as
              // a single exact argument/value. Retain symbolic fallback.
              if(result.kind!=="unknown"&&result.kind!=="instance"&&result.kind!=="instanceList"&&
                !(result.kind==="text"&&result.values.length!==1))return ev(result);
              if(qualified)return ev(result.kind==="unknown"?result:reject("helper return alternatives are not exact","HELPER_RETURN_UNPROVEN"));
            }
          }else{
            note(frame,offset,"SHARED_HELPER_ARGUMENT_UNPROVEN",invocation[2]??invocation[1]);
            if(qualified)return ev(reject("class-qualified helper arguments depend on unresolved runtime values or reference state","HELPER_ARGUMENT_UNPROVEN"));
          }
        }
      }
      // Existing symbolic private straight-line helper evidence. This is
      // not a second general invocation interpreter: it preserves consumer
      // annotations and typed holes that exact value summaries cannot take.
      const call=/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/i.exec(expr);
      if(call){
        const args=call[2].trim()?splitApexTopLevel(call[2],","):[];
        const symbols=apexSymbols(frame.source,frame.methods);
        const candidates=frame.methods.filter(m=>m.name.toLowerCase()===call[1].toLowerCase()&&m.parameters.length===args.length&&symbols.sameOwner(frame.method,m));
        if(candidates.length===1){
          const helper=candidates[0],id=frame.filePath+"@"+helper.start;
          if(helper.visibility==="private"&&(helper.isStatic||!frame.method.isStatic)&&frame.depth<MAX_DEPTH&&id!==frameIdentity(frame)&&!frame.ancestors.includes(id)){
            const last=helper.body.at(-1);
            const ret=last?.kind==="statement"?/^return\s+([\s\S]+);$/i.exec(clean(last.text??"")):undefined;
            if(ret){
              const inputs=new Map<string,Evidence>();
              for(const [i,arg] of args.entries())inputs.set(helper.parameters[i].toLowerCase(),resolve(frame,arg,offset,locals));
              // Collection arguments may be mutable, so only admit literal
              // scalar/record helper inputs in this straight-line adapter.
              if([...inputs.values()].some(v=>v.value.kind==="collection"||v.runtimeMembers))return ev(reject("mutable helper argument","HELPER_MUTABLE_ARGUMENT"));
              const nested:Frame={...frame,method:helper,key:frame.key+"|helper:"+helper.start,depth:frame.depth+1,ancestors:[...frame.ancestors,frameIdentity(frame)]};
              if(helper.body.slice(0,-1).some(n=>n.kind!=="statement"||helper.parameters.some(p=>rx(p).test(maskApexSource(n.text??"")))))return ev(reject("helper input modified","HELPER_INPUT_MODIFIED"));
              note(nested,last!.start,"HELPER_RETURN",helper.name);
              return resolve(nested,ret[1],last!.start,inputs,members);
            }
          }
        }
      }
      // Distinguish unsupported shapes without exposing the expression.
      const shape=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(/.test(expr)?"CALL":
        /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(expr)?"MEMBER":
        /^new\s/i.test(expr)?"ALLOCATION":/^\[\s*SELECT\b/i.test(expr)?"INLINE_QUERY":"OTHER";
      note(frame,offset,"UNSUPPORTED_"+shape);
      return ev(reject("unsupported expression","EXPRESSION_UNSUPPORTED"));
    };
    const variable=(frame:Frame,name:string,offset:number,locals:Locals,members:readonly string[]=[]):Evidence=>{
      tick();
      const reject=(reason:string,code:string):ApexValue=>{
        note(frame,offset,code,name);return stop(reason);
      };
      note(frame,offset,"VARIABLE_USE",name);
      const id=frame.key+"|"+offset+"|"+name.toLowerCase();
      if(active.has(id))return ev(reject("cyclic variable dependency","VARIABLE_CYCLE"));
      active.add(id);
      try{
        // Only enter loops currently being enumerated. A local declared
        // within this iteration can be read. An outer symbol must be read
        // only throughout the loop, including subsequent iterations.
        const readOnlyMapUse=(node:SourceNode)=>{
          const body=maskApexSource(frame.source.slice(node.start,node.end));
          return !rx(name).test(body.replace(new RegExp("\\b"+name+"\\s*\\.\\s*(?:containsKey|isEmpty|size)\\s*\\(","gi"),"("));
        };
        const prefix=prefixAt(frame.method.body,offset,node=>{
          if(!iterating.has(node))return false;
          const local=node.body?.some(n=>n.kind==="statement"&&parseApexDeclaration(clean(n.text??""))?.name.toLowerCase()===name.toLowerCase()&&n.end<=offset);
          if(local)return true;
          if(apexSymbols(frame.source,frame.methods).isReadOnlyOuterScalar(frame.method,name,node,offset)){
            note(frame,offset,"LOOP_OUTER_SCALAR_READ_PROVEN",name);
            return true;
          }
          return readOnlyMapUse(node);
        });
        if(!prefix)return ev(reject("unsupported lexical path","LEXICAL_PATH_UNSUPPORTED"));
        const type=apexSymbols(frame.source,frame.methods).lookup(frame.method,name,offset);
        const key=name.toLowerCase(),param=frame.method.parameters.findIndex(p=>p.toLowerCase()===key);
        const defs=prefix.flatMap((n,i)=>{
          if(n.kind!=="statement")return [];
          const statement=clean(n.text??""),decl=parseApexDeclaration(statement);
          if(decl?.name.toLowerCase()!==key)return [];
          const assignment=/^[\s\S]*?=\s*([\s\S]+);$/.exec(statement);
          return [{index:i,node:n,expression:assignment?.[1],type:decl.type}];
        });
        if(defs.length>1)return ev(reject("ambiguous local declaration","DECLARATION_AMBIGUOUS"));
        let base:Evidence,after:SourceNode[],freshCollection=false;
        const collection=/^(?:list|set)<string>$/i.test(type??"");
        const map=/^map</i.test(type??"");
        const schemaReferenceList=/^list<schema\.sobjecttype>$/i.test(type??"");
        const schemaFieldMap=/^map<string,schema\.sobjectfield>$/i.test(type??"");
        if(defs.length){
          let def=defs[0];
          // Latest unconditional scalar assignment is the reaching
          // definition; an older overwritten value is not evidence.
          if(def.type==="string"){
            const assignment=new RegExp("^"+name+"\\s*=(?!=|>)\\s*([\\s\\S]+);$","i");
            for(let i=def.index+1;i<prefix.length;i++){
              const node=prefix[i],match=node.kind==="statement"?assignment.exec(clean(node.text??"")):null;
              if(match)def={index:i,node,expression:match[1],type:def.type};
            }
          }
          if(!def.expression)return ev(reject("no initializer","NO_INITIALIZER"));
          // A direct collection alias may be mutated via another name. Only
          // a fresh collection or a proven read-only getter is supported.
          if((collection||map||schemaReferenceList)&&identifier.test(clean(def.expression)))return ev(reject("mutable collection alias","COLLECTION_ALIAS"));
          note(frame,def.node.start,"REACHING_DEFINITION",name);
          base=resolve(frame,def.expression,def.node.start,locals,members);
          freshCollection=collection&&(
            /^new\s+(?:List|Set)\s*</i.test(clean(def.expression))&&exact(base)||
            isExactMetadataStringList(base.value)&&!base.annotations.length&&!base.runtimeMembers&&!base.describeObject);
          after=prefix.slice(def.index+1);
        }else if(param>=0){
          if(schemaReferenceList||schemaFieldMap)return ev(reject("Schema collection caller alias not proven","SCHEMA_COLLECTION_ALIAS_OR_WRITE"));
          note(frame,offset,"PARAMETER_USE",name,param);
          const choice=choices.get(frame.key+"|caller");
          if(choice?.kind==="caller"){
            const edge=choice.edge;
            const parent:Frame={filePath:edge.filePath,source:edge.source,methods:edge.methods,method:edge.method,key:frame.key+"|"+edge.filePath+"@"+edge.offset,
              depth:frame.depth+1,ancestors:[...frame.ancestors,frameIdentity(frame)]};
            note(parent,edge.offset,"CALLER_ARGUMENT",name,param);
            base=resolve(parent,edge.expressions[param],edge.offset,new Map(),members);
          }else if(scalar.test(type??"")){
            note(frame,offset,"TYPED_RUNTIME_SCALAR",name);
            base=ev(runtimeParameter(name,type,"Runtime scalar parameter"));
          }else{
            const candidates=frame.depth<MAX_DEPTH?(index?.sourceCallers(frame.filePath,frame.method,policy.observe?(stats)=>{
              note(frame,offset,stats.status,name,stats.candidates);
              note(frame,offset,"CALLER_SOURCE_ELIGIBLE",name,stats.eligible);
            }:undefined)??[]).filter(e=>
              e.filePath+"@"+e.method.start!==frameIdentity(frame)&&!frame.ancestors.includes(e.filePath+"@"+e.method.start)):[];
            note(frame,offset,"CALLER_EDGES_AVAILABLE",name,candidates.length);
            if(candidates.length)throw new Expand(frame.key+"|caller",candidates.map(edge=>({kind:"caller",edge})));
            const unresolved=reject("runtime parameter "+name,frame.depth>=MAX_DEPTH?"CALLER_DEPTH_LIMIT":!index?"NO_REPOSITORY_INDEX":"NO_PROVEN_CALLER");
            // A typed String collection parameter can supply unknown
            // additional members. Check its prior uses for writes/escapes
            // before returning this evidence. Other types remain unknown.
            if(!collection||frame.depth>=MAX_DEPTH)return ev(unresolved);
            base=ev(unresolved,[],{runtimeMembers:{}});
            note(frame,offset,"RUNTIME_COLLECTION_PARAMETER",name);
          }
          after=prefix;
        }else{
          // Consult the same repository-scoped initializer snapshot used by
          // forward evaluation, but only after exhausting lexical bindings.
          // Unknown locals/parameters must never fall through to a same-name
          // class member. A bare instance member needs receiver-state proof.
          const symbols=apexSymbols(frame.source,frame.methods);
          const owner=symbols.ownerAt(frame.method.start);
          if(index&&owner&&!symbols.hasLocalBinding(frame.method,name,offset)){
            const snapshot=resolveExternal?.("Apex.scopeField",[
              textValue(owner),textValue(name),textValue("unqualified"),textValue("true"),
            ])??index.evaluateScopeField(owner,name,"unqualified",true,resolveExternal);
            if(snapshot!==undefined){
              note(frame,offset,snapshot.kind==="unknown"?"CLASS_MEMBER_UNPROVEN":"CLASS_MEMBER_RESOLVED",name);
              return ev(snapshot);
            }
          }
          return ev(reject("unknown local or class member "+name,"NO_LOCAL_OR_PARAMETER_DEFINITION"));
        }
        if(base.value.kind==="unknown"&&!base.value.fragments&&!base.value.symbol&&!base.runtimeMembers){note(frame,offset,"BASE_VALUE_UNKNOWN",name);return base;}
        const additions:ApexDependencyAppend<A>[]=[];
        let current=base;
        let exactCurrent=freshCollection;
        const visit=(nodes:readonly SourceNode[],conditional:boolean,bindings:Locals):boolean=>{
          for(const n of nodes){
            tick();
            const visible=maskApexSource(frame.source.slice(n.start,n.end));
            if(!rx(name).test(visible))continue;
            const blocked=(code:string):false=>{note(frame,n.start,code,name);return false;};
            // Until typed reference-list mutation replay is implemented, any
            // intervening use can escape or change the positional snapshot.
            if(schemaReferenceList)return blocked("SCHEMA_REFERENCE_LIST_ALIAS_OR_WRITE");
            if(map){
              // Replay only exact, standalone mutations on a locally
              // established typed map. Conditional paths and aliases are
              // deliberately rejected rather than preserving stale fields.
              if(schemaFieldMap&&isSchemaFieldMap(current.value)&&n.kind==="statement"&&!conditional&&!current.annotations.length&&!current.runtimeMembers){
                const mutation=new RegExp("^"+name+"\\s*\\.\\s*(clear|remove|put)\\s*\\(([\\s\\S]*)\\)\\s*;$","i").exec(clean(n.text??""));
                if(mutation){
                  const args=mutation[2].trim()?splitApexTopLevel(mutation[2],",").map(p=>resolve(frame,p,n.start,bindings)):[];
                  if(args.some(arg=>arg.annotations.length||arg.runtimeMembers||arg.describeObject||arg.value.kind==="unknown"))return blocked("SCHEMA_MAP_MUTATION_UNPROVEN");
                  const updated=mutateSchemaFieldMap(current.value,mutation[1],args.map(arg=>arg.value));
                  if(!isSchemaFieldMap(updated))return blocked("SCHEMA_MAP_MUTATION_UNPROVEN");
                  current=ev(updated); // drop complete Describe provenance
                  note(frame,n.start,"SCHEMA_MAP_MUTATION_RESOLVED",name);
                  continue;
                }
              }
              // Other map snapshots must stay immutable; no aliases or writes.
              if(!rx(name).test(visible.replace(new RegExp("\\b"+name+"\\s*\\.\\s*(?:containsKey|isEmpty|size)\\s*\\(","gi"),"(")))continue;
              return blocked("MAP_ALIAS_OR_WRITE");
            }
            if(n.kind==="if"){
              // A selected metadata row cannot be null. Follow the proven
              // branch of the explicit null guard; never execute guard code.
              if(type?.endsWith("__mdt")&&current.value.kind==="record"){
                const guard=new RegExp("^\\s*(?:"+name+"\\s*(==|!=)\\s*null|null\\s*(==|!=)\\s*"+name+")\\s*$","i").exec(clean(n.condition??""));
                if(guard){
                  const truth=(guard[1]??guard[2])==="!=";
                  if(!visit(truth?n.body??[]:n.otherwise??[],conditional,bindings))return false;
                  note(frame,n.start,"METADATA_NULL_GUARD_RESOLVED",name);
                  continue;
                }
              }
              // Evaluate a proven read-only Schema guard against the current
              // reaching value, not the variable's eventual value at the use.
              // An unknown metadata response does not authorize skipping it.
              if(/\bSchema\s*\.\s*getGlobalDescribe\s*\(/i.test(maskApexSource(n.condition??""))){
                const symbols=apexSymbols(frame.source,frame.methods);
                const guard=evaluateSchemaGlobalGuard(clean(n.condition??""),{
                  evaluate:part=>{
                    const value=part.trim().toLowerCase()===name.toLowerCase()?
                      (additions.length||conditional?ev(stop("Current guard value is not exact")):current):
                      resolve(frame,part,n.start,bindings);
                    return exactValue(value)?value.value:stop("Schema guard input is not exact");
                  },
                  resolveCall:resolveExternal,
                  shadowed:root=>bindings.has(root.toLowerCase())||symbols.hasLocalBinding(frame.method,root,n.start)||
                    !!index?.hasSourceClass(root)||new RegExp("\\bclass\\s+"+root+"\\b","i").test(maskApexSource(frame.source))
                });
                if(guard!==undefined){
                  const truth=knownBoolean(guard);
                  if(truth===undefined)return blocked("SCHEMA_GUARD_UNPROVEN");
                  note(frame,n.start,"SCHEMA_GUARD_RESOLVED",name);
                  const chosen=truth?n.body??[]:n.otherwise??[];
                  // Do not claim a downstream use is reached if this path
                  // terminates or has unsupported control flow.
                  if(chosen.some(child=>/\b(?:return|throw|break|continue)\b/i.test(maskApexSource(frame.source.slice(child.start,child.end)))))
                    return blocked("SCHEMA_GUARD_PATH_TERMINATES");
                  if(!visit(chosen,conditional,bindings))return false;
                  continue;
                }
              }
              if(collection&&rx(name).test(maskApexSource(n.condition??""))){
                const guard=evaluateApexCollectionGuard(clean(n.condition??""),name,current.value,
                  !conditional&&!additions.length&&!current.annotations.length&&!current.runtimeMembers&&!current.describeObject&&
                  (exactCurrent||current.value.kind==="null"));
                if(guard!==undefined){
                  const truth=knownBoolean(guard);
                  if(truth===undefined){
                    // Retain the existing inventory-only behavior for a
                    // lone emptiness test; compound guards require proof.
                    if(!new RegExp("^\\s*!?\\s*"+name+"\\s*\\.\\s*isEmpty\\s*\\(\\s*\\)\\s*$","i").test(clean(n.condition??"")))
                      return blocked("COLLECTION_GUARD_UNPROVEN");
                  }else{
                    note(frame,n.start,"COLLECTION_GUARD_RESOLVED",name);
                    const chosen=truth?n.body??[]:n.otherwise??[];
                    if(chosen.some(child=>/\b(?:return|throw|break|continue)\b/i.test(maskApexSource(frame.source.slice(child.start,child.end)))))
                      return blocked("COLLECTION_GUARD_PATH_TERMINATES");
                    if(!visit(chosen,conditional,bindings))return false;
                    continue;
                  }
                }
              }
              if(rx(name).test(maskApexSource(n.condition??""))&&
                !new RegExp("^\\s*!?\\s*"+name+"\\s*\\.\\s*isEmpty\\s*\\(\\s*\\)\\s*$","i").test(clean(n.condition??"")))return blocked("GUARD_DEPENDS_ON_TARGET");
              const condition=clean(n.condition??"");
              // A guard invoking Describe/map/metadata predicates is not
              // merely a runtime data flag. It can establish a field's
              // very existence; leave those to authoritative engine proof.
              const calls=[...maskApexSource(condition).matchAll(/\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*\(/g)].map(m=>m[0].replace(/\s|\(/g,""));
              const membership=/^(!\s*)?([A-Za-z_]\w*)\s*\.\s*containsKey\s*\(([\s\S]*)\)$/i.exec(condition);
              let truth:boolean|undefined;
              if(membership&&/^map</i.test(apexSymbols(frame.source,frame.methods).lookup(frame.method,membership[2],n.start)??"")){
                const receiver=resolve(frame,membership[2],n.start,bindings);
                const key=resolve(frame,membership[3],n.start,bindings);
                if(receiver.value.kind==="map"&&!receiver.annotations.length&&!key.annotations.length)
                  truth=knownBoolean(evaluateApexReadOperation(receiver.value,"containsKey",[key.value]));
                else if(receiver.value.kind==="collection"&&receiver.describeObject&&!receiver.runtimeMembers&&!receiver.annotations.length&&!key.annotations.length&&
                    /^map<string,schema\.sobjectfield>$/i.test(apexSymbols(frame.source,frame.methods).lookup(frame.method,membership[2],n.start)??"")){
                  // Describe field-map keys are case-insensitive. Reuse the
                  // existing evaluator on a normalized metadata snapshot.
                  const k=one(key.value);
                  if(k!==undefined)truth=knownBoolean(evaluateApexReadOperation(
                    listValue(receiver.value.items.map(s=>s.toLowerCase()),true),"containsKey",[textValue(k.toLowerCase())]));
                }
                if(truth===undefined)return blocked("GUARD_MAP_UNPROVEN");
                if(membership[1])truth=!truth;
                note(frame,n.start,"GUARD_MAP_RESOLVED",membership[2]);
              }else{
                if(calls.some(c=>!(/^(?:String\.(?:isBlank|isNotBlank)|[A-Za-z_]\w*\.isEmpty)$/i.test(c))))return blocked("GUARD_CALL_UNSUPPORTED");
                truth=/^true$/i.test(condition)?true:/^false$/i.test(condition)?false:undefined;
              }
              if(truth!==false&&!visit(n.body??[],conditional||truth!==true,bindings))return false;
              if(truth!==true&&!visit(n.otherwise??[],conditional||truth!==false,bindings))return false;
            }else if(n.kind==="block"){
              if(!visit(n.body??[],conditional,bindings))return false;
            }else if(n.kind==="for"){
              // A completed loop that only reads an outer scalar does not
              // change its reaching value. Reuse the lexical proof used
              // when resolving arguments inside an active iteration.
              if(!collection&&apexSymbols(frame.source,frame.methods).isReadOnlyOuterScalar(frame.method,name,n,offset)){
                note(frame,n.start,"LOOP_OUTER_SCALAR_READ_PROVEN",name);
                continue;
              }
              if(!collection||!n.loopVariable||!n.iterable||rx(name).test(maskApexSource(n.iterable)))return blocked("LOOP_SHAPE_UNSUPPORTED");
              const iterable=resolve(frame,n.iterable,n.start,bindings);
              const items=apexIterationValues(iterable.value,MAX_COLLECTION_ITEMS)??(iterable.value.kind==="unknown"&&iterable.runtimeMembers?[]:undefined);
              if(!items||iterable.annotations.length)return blocked("LOOP_ITERABLE_UNPROVEN");
              const body=maskApexSource(frame.source.slice(n.body?.[0]?.start??n.end,n.end));
              if(/\b(?:break|continue|return|throw)\b/i.test(body)||
                new RegExp("\\b"+n.loopVariable+"\\s*(?:=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--)","i").test(body)||
                (identifier.test(clean(n.iterable))&&rx(clean(n.iterable)).test(body)))return blocked("LOOP_EFFECT_UNSUPPORTED");
              note(frame,n.start,"LOOP_ITERABLE_RESOLVED",name,items.length);
              if(!exact(iterable)||iterable.value.kind==="collection"&&iterable.value.unique&&items.length>1)exactCurrent=false;
              iterating.add(n);
              try{
                for(const item of items){
                  const nested=new Map(bindings);nested.set(n.loopVariable.toLowerCase(),ev(item));
                  if(!visit(n.body??[],conditional,nested))return false;
                }
                if(iterable.runtimeMembers){
                  // Unknown iterations may contribute further members,
                  // but cannot erase known members in an add-only loop.
                  if(n.loopVariableType?.toLowerCase()!=="string"||current.value.kind!=="collection")
                    return blocked("RUNTIME_LOOP_TYPE_UNPROVEN");
                  const effect=proveApexAddOnlyIteration(n.body??[],name,n.loopVariable);
                  if(!effect||effect.usesStringGuard&&apexSymbols(frame.source,frame.methods).lookup(frame.method,"String",n.start))
                    return blocked("RUNTIME_LOOP_EFFECT_UNPROVEN");
                  let extra:ApexRuntimeCollectionMembers=effect.caseOnly?iterable.runtimeMembers:{};
                  if(effect.membership){
                    const receiver=resolve(frame,effect.membership.receiver,n.start,bindings);
                    if((receiver.value.kind!=="collection"&&!isSchemaFieldMap(receiver.value))||!receiver.describeObject||receiver.runtimeMembers||
                      !/^map<string,schema\.sobjectfield>$/i.test(apexSymbols(frame.source,frame.methods).lookup(frame.method,effect.membership.receiver,n.start)??""))
                      return blocked("RUNTIME_LOOP_DOMAIN_UNPROVEN");
                    extra={describeObject:receiver.describeObject};
                  }
                  current=ev(current.value,current.annotations,{runtimeMembers:mergeApexRuntimeMembers(current.runtimeMembers,extra)});
                  note(frame,n.start,extra.describeObject?"RUNTIME_COLLECTION_MEMBERS_SCHEMA_FILTERED":"RUNTIME_COLLECTION_MEMBERS_RETAINED",name);
                }
              }finally{iterating.delete(n);}
            }else if(n.kind==="statement"){
              const statement=clean(n.text??"");
              const add=new RegExp("^"+name+"\\s*\\.\\s*(add|addAll)\\s*\\(([\\s\\S]*)\\)\\s*;$","i").exec(statement);
              if(collection&&add){
                const value=resolve(frame,add[2],n.start,bindings);
                const items=add[1].toLowerCase()==="addall"?(value.value.kind==="collection"?value.value.items:undefined):[one(value.value)];
                if(!items||items.some(x=>x===undefined)||current.value.kind!=="collection")return blocked("COLLECTION_ADDITION_UNPROVEN");
                const updated=applyApexStringCollectionMutation(current.value,add[1],[value.value],add[2]);
                if(updated.kind!=="collection")return blocked("COLLECTION_ADDITION_UNPROVEN");
                const merged=[...new Set(updated.items)];
                if(merged.length>MAX_COLLECTION_ITEMS)return blocked("COLLECTION_SIZE_LIMIT");
                note(frame,n.start,"COLLECTION_ADDITION",name,items.length);
                // Candidate union, not exact execution ordering/cardinality.
                const runtimeMembers=mergeApexRuntimeMembers(current.runtimeMembers,value.runtimeMembers);
                const exactAdd=add[1].toLowerCase()==="addall"?exact(value):
                  exactValue(value)&&(/^'(?:\\.|[^'\\])*'$/s.test(clean(add[2]))||bindings.has(clean(add[2]).toLowerCase()));
                exactCurrent=exactCurrent&&!conditional&&!runtimeMembers&&exactAdd&&merged.length===updated.items.length;
                current=ev(listValue(merged,updated.unique),current.annotations,runtimeMembers?{runtimeMembers}:{});
                continue;
              }
              const append=new RegExp("^"+name+"\\s*\\+=\\s*([\\s\\S]+);$","i").exec(statement);
              if(type==="string"&&append){
                if(rx(name).test(maskApexSource(append[1])))return blocked("SELF_REFERENTIAL_APPEND");
                note(frame,n.start,conditional?"CONDITIONAL_APPEND":"STRING_APPEND",name);
                additions.push({evidence:resolve(frame,append[1],n.start,bindings),conditional});
                continue;
              }
              if(type?.endsWith("__mdt")){
                // Reading a scalar configuration member cannot mutate or
                // escape the record; reject assignments and receiver calls.
                const memberRead=new RegExp("\\b"+name+"\\s*\\.\\s*[A-Za-z_]\\w*(?!\\w)(?!\\s*(?:\\(|\\.|=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--))","gi");
                if(!rx(name).test(visible.replace(memberRead,"")))continue;
                return blocked("METADATA_ALIAS_OR_WRITE");
              }
              if(collection){
                // Inert reads only. Any alias or unknown call invalidates
                // the whole collection dependency.
                if(new RegExp("^System\\s*\\.\\s*debug\\s*\\(\\s*"+name+"\\s*\\.\\s*(?:size|isEmpty)\\s*\\(\\s*\\)\\s*\\)\\s*;$","i").test(statement))continue;
                // Resolve a complete standalone call or declaration RHS;
                // actual effects are evaluated by AUE, never by this tracer.
                const expression=statement.replace(/;\s*$/,"");
                const declaration=parseApexDeclaration(maskApexSource(expression));
                const eq=declaration?maskApexSource(expression).indexOf("="):-1;
                const invocation=directEffectInvocation(eq>=0?expression.slice(eq+1):expression);
                if(invocation&&identifier.test(invocation.name)){
                  const pieces=invocation.argumentText.trim()?splitApexTopLevel(invocation.argumentText,","):[];
                  const targetPositions=pieces.flatMap((p,i)=>clean(p).toLowerCase()===key?[i]:[]);
                  if(targetPositions.length){
                    const symbols=apexSymbols(frame.source,frame.methods);
                    const hints=symbols.argumentTypes(frame.method,pieces,n.start);
                    const helper=selectApexOverload(frame.methods.filter(m=>symbols.sameOwner(frame.method,m)&&m.name.toLowerCase()===invocation.name),pieces.length,hints);
                    const effects=memberEffectModel(frame.source,frame.methods);
                    const effectBlocked=(code:string,symbol=invocation.name):false=>{
                      note(frame,n.start,code,symbol);
                      return blocked("SHARED_HELPER_EFFECT_UNPROVEN");
                    };
                    if(!helper||!helper.isStatic||helper.visibility!=="private"||
                      helper.parameterTypes?.length!==pieces.length||
                      hints.some((t,i)=>!canonicalApexType(t)||canonicalApexType(t)!==canonicalApexType(helper.parameterTypes?.[i])))
                      return effectBlocked("HELPER_EFFECT_SIGNATURE_UNPROVEN");
                    if(declaration&&(eq<0||declaration.name.toLowerCase()===key||declaration.type!==canonicalApexType(helper.returnType)))
                      return effectBlocked("HELPER_EFFECT_RETURN_BINDING_UNPROVEN",helper.name);
                    if(declaration&&!effects.resultCannotExposeReference(helper))
                      return effectBlocked("HELPER_EFFECT_RETURN_ALIAS_UNPROVEN",helper.name);
                    if(!exactCurrent||conditional||current.runtimeMembers||current.annotations.length||current.value.kind!=="collection")
                      return effectBlocked("HELPER_EFFECT_REACHING_STATE_UNPROVEN",helper.name);
                    if(pieces.some((p,i)=>!targetPositions.includes(i)&&rx(name).test(maskApexSource(p))))
                      return effectBlocked("HELPER_EFFECT_ARGUMENT_ALIAS_UNPROVEN",helper.name);
                    if(effectPlatforms.some(p=>index?.hasSourceClass(p)||new RegExp("\\bclass\\s+"+p+"\\b","i").test(maskApexSource(frame.source))||
                        frame.methods.some(m=>effects.locals(m).has(p.toLowerCase()))))
                      return effectBlocked("HELPER_EFFECT_PLATFORM_SHADOWED",helper.name);
                    const args=pieces.map((p,i)=>targetPositions.includes(i)?current:resolve(frame,p,n.start,bindings));
                    const unproven=args.findIndex((v,i)=>!targetPositions.includes(i)&&!exactValue(v));
                    if(unproven>=0)return effectBlocked("HELPER_EFFECT_ARGUMENT_VALUE_UNPROVEN",helper.parameters[unproven]);
                    if(++effectSummaries>MAX_EFFECT_SUMMARIES){note(frame,n.start,"WORK_LIMIT",helper.name);throw new Bounded("Helper effect summary limit");}
                    let engine=effectEngines.get(frame.filePath);
                    if(!engine){
                      // Permit only source-proven allocations and the same
                      // authoritative Schema snapshot reads used by forward evaluation.
                      // Never bypass local effect replay via application return summaries.
                      engine=new ApexDataFlowEngine(frame.source,{sourceMethods:[...frame.methods],maxOperations:500,
                        selectInvocation:()=>undefined,
                        resolveExternal:(call,values,types)=>call==="Apex.construct"&&values[0]?.kind==="text"&&values[0].values.length===1?
                          index?.constructInstance(frame.filePath,values[0].values[0],values.slice(1),undefined,types?.slice(1)):
                          /^(?:Schema\.objectSchema|Schema\.fieldMap)$/.test(call)?resolveExternal?.(call,values,types,frame.filePath):undefined});
                      effectEngines.set(frame.filePath,engine);
                    }
                    const updated=engine.summarizeArgumentEffects(helper,args.map(v=>v.value),(code,at)=>
                      note({...frame,method:helper,depth:frame.depth+1},at,code,helper.name))?.[targetPositions[0]];
                    if(updated?.kind!=="collection"||updated.items.length>MAX_COLLECTION_ITEMS)return blocked("SHARED_HELPER_EFFECT_UNPROVEN");
                    current=ev(mark(updated));
                    note(frame,n.start,"SHARED_HELPER_EFFECT_RESOLVED",helper.name);
                    continue;
                  }
                }
                return blocked("COLLECTION_ALIAS_OR_WRITE");
              }
              // Scalar Strings are passed by value. Do not overlook writes,
              // shadow declarations or mutation through unsupported syntax.
              if(new RegExp("\\b"+name+"\\s*(?:=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--)","i").test(visible)||
                new RegExp("(?:\\+\\+|--)\\s*"+name+"\\b","i").test(visible))return blocked("SCALAR_WRITE_UNSUPPORTED");
            }else return blocked("CONTROL_FLOW_UNSUPPORTED");
          }
          return true;
        };
        // Opaque nodes may conceal a write even when lexical slicing cannot
        // establish the relevant identifier; fail closed on those nodes.
        const opaque=after.find(n=>n.kind==="opaque");
        if(opaque)note(frame,opaque.start,"OPAQUE_CONTROL_FLOW",name);
        if(opaque||!visit(after,false,locals))return ev(reject("unsupported write or alias","WRITE_OR_ALIAS_UNSUPPORTED"));
        if(!additions.length){
          // An empty known inventory is not a proven empty runtime
          // collection. Retain the runtime provenance for downstream loops.
          if(current.value.kind==="collection"&&!current.value.items.length&&current.runtimeMembers)
            return ev(reject("no known collection members","RUNTIME_COLLECTION_ONLY"),current.annotations,{runtimeMembers:current.runtimeMembers});
          if(exactCurrent)mark(current.value);else exactCollections.delete(current.value);
          return current;
        }
        if(additions.every(a=>!a.conditional)){
          for(const a of additions)current=concat(current,a.evidence);
          return current;
        }
        return policy.mergeConditionalAppends?.(current,additions)??ev(reject("conditional String append requires consumer interpretation","CONDITIONAL_APPEND_UNRESOLVED"));
      }finally{active.delete(id);}
    };
    return resolve(root,use.expression,use.offset);
  };
  const queue:Array<Map<string,Choice>>=[new Map()];
  while(queue.length){
    const choices=queue.shift()!;
    try{
      const proof=run(choices);
      // Even unresolved values are useful dependency evidence to another
      // consumer. Do not parse, execute, or assert complete runtime coverage.
      found.set(JSON.stringify(proof),proof);
      note(root,use.offset,"CANDIDATE_"+proof.value.kind.toUpperCase(),undefined,proof.value.kind==="unknown"?proof.value.fragments?.length:undefined);
    }catch(error){
      if(error instanceof Bounded){bounded=true;note(root,use.offset,"WORK_LIMIT");break;}
      if(!(error instanceof Expand))throw error;
      if(choices.has(error.key)||queue.length+error.choices.length>MAX_EDGES||edges+metadataRows+error.choices.length>MAX_EDGES){bounded=true;note(root,use.offset,"EDGE_OR_ROW_LIMIT");continue;}
      for(const choice of error.choices){
        if(choice.kind==="caller")edges++;else metadataRows++;
        const next=new Map(choices);next.set(error.key,choice);queue.push(next);
      }
    }
  }
  if(queue.length)bounded=true;
  if(edges)countApex("backward.caller_edges",edges);
  if(metadataRows)countApex("backward.metadata_rows",metadataRows);
  if(bounded)countApex("backward.bounded");
  return {kind:"SOURCE_CANDIDATES",candidates:[...found.values()],bounded,callerEdges:edges,metadataRows};
}
