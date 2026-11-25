import {indexApexMethods,maskApexSource,matchingPair,splitApexTopLevel,stripApexComments,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {parseApexDeclaration,type ApexCallResolver} from "./ApexTypeSystem.js";
import {addApexValues,evaluateApexExpression,listValue,runtimeParameter,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import type {ApexRepositoryMethodIndex,ApexCallerSource} from "./ApexRepositoryMethodIndex.js";
import {countApex} from "./ApexPerformance.js";

const clean=(s:string)=>stripApexComments(s).trim();
const identifier=/^[A-Za-z_]\w*$/;
const scalar=/^(?:id|integer|long|decimal|double|boolean|date|datetime)$/i;
const rx=(name:string)=>new RegExp("\\b"+name+"\\b","i");
const one=(v:ApexValue)=>v.kind==="text"&&v.values.length===1&&!v.scalarType?v.values[0]:undefined;
const stop=(reason:string)=>unknown("Apex backward dependency: "+reason);
const MAX_EDGES=64,MAX_DEPTH=6,MAX_WORK=2400,MAX_COLLECTION_ITEMS=2000;
/** A source-derived candidate, never a proof of the exact runtime value.
 * Add-only collection unions and consumer-approved conditional merges may
 * contain members from multiple branches. Keep this evidence separate from
 * ApexDataFlowEngine execution states and repository helper value caches. */
export interface ApexDependencyEvidence<A=never> {
  readonly value:ApexValue;
  readonly annotations:readonly A[];
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
function prefixAt(nodes:readonly SourceNode[],offset:number):SourceNode[]|undefined{
  const prefix:SourceNode[]=[];
  for(const node of nodes){
    if(node.end<=offset){prefix.push(node);continue;}
    if(node.start>offset)return prefix;
    if(node.kind==="statement")return prefix;
    if(node.kind==="if"||node.kind==="block"){
      for(const child of [node.body??[],node.otherwise??[]]){
        if(child.some(n=>n.start<=offset&&offset<n.end)){
          const prior=prefixAt(child,offset);return prior?[...prefix,...prior]:undefined;
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
  const ev=(value:ApexValue,annotations:readonly A[]=[]):Evidence=>({value,annotations});
  const concat=(a:Evidence,b:Evidence):Evidence=>ev(addApexValues(a.value,b.value),[...a.annotations,...b.annotations]);
  const methods=index?.indexedMethods(filePath,source)??indexApexMethods(source);
  const method=methods.filter(m=>m.start<=use.offset&&use.offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  const empty:ApexDependencyTrace<A>={kind:"SOURCE_CANDIDATES",candidates:[],bounded:false,callerEdges:0,metadataRows:0};
  if(!method||/\bclass\s+(?:String|List|Set|Label)\b/i.test(maskApexSource(source)))return empty;
  const root:Frame={filePath,source,methods,method,key:"root",depth:0,ancestors:[]};
  let work=0,edges=0,metadataRows=0,bounded=false;
  const found=new Map<string,Evidence>();
  const tick=()=>{if(++work>MAX_WORK)throw new Bounded("Backward dependency work limit");};
  const run=(choices:ReadonlyMap<string,Choice>)=>{
    const active=new Set<string>();
    const resolve=(frame:Frame,expression:string,offset:number,locals:Locals=new Map(),members:readonly string[]=[]):Evidence=>{
      tick();
      const expr=clean(expression);
      if(!expr)return ev(stop("empty expression"));
      if(expr.startsWith("(")&&matchingPair(maskApexSource(expr),0)===expr.length-1)return resolve(frame,expr.slice(1,-1),offset,locals,members);
      if(/^'(?:\\.|[^'\\])*'$/s.test(expr)||/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map()}));
      if(identifier.test(expr)){
        const local=locals.get(expr.toLowerCase());
        if(local)return local;
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
        if(apexSymbols(frame.source,frame.methods).lookup(frame.method,"String",offset))return ev(stop("shadowed String"));
        const args=splitApexTopLevel(join[1],",");
        if(args.length!==2)return ev(stop("join arity"));
        const list=resolve(frame,args[0],offset,locals),separator=one(resolve(frame,args[1],offset,locals).value);
        if(list.value.kind!=="collection"||separator===undefined||list.value.items.length>MAX_COLLECTION_ITEMS)return ev(stop("unproven joined collection"));
        if(policy.join)return policy.join(list,separator)??ev(stop("consumer cannot interpret joined collection"));
        return ev(textValue(list.value.items.join(separator)),list.annotations);
      }
      const create=/^new\s+(List|Set)\s*<\s*String\s*>\s*(?:\{([\s\S]*)\}|\(([\s\S]*)\))$/i.exec(expr);
      if(create){
        const unique=create[1].toLowerCase()==="set";
        if(create[2]!==undefined){
          const values=splitApexTopLevel(create[2],",").filter(s=>s.trim()).map(s=>one(resolve(frame,s,offset,locals).value));
          if(values.some(s=>s===undefined)||values.length>MAX_COLLECTION_ITEMS)return ev(stop("unknown collection member"));
          return ev(listValue(values as string[],unique));
        }
        if(!create[3]?.trim())return ev(listValue([],unique));
        const input=resolve(frame,create[3],offset,locals);
        return input.value.kind==="collection"?ev(listValue([...input.value.items],unique),input.annotations):ev(stop("unknown copied collection"));
      }
      const abstraction=policy.abstractExpression?.({source:frame.source,methods:frame.methods,method:frame.method,expression:expr,offset});
      if(abstraction!==undefined)return ev(abstraction);
      // Read-only scalar/string operations and metadata calls reuse the
      // existing evaluator; inputs must be exact, never a synthesized query.
      const operation=/^((?:(?:System\.)?Label\.)?[A-Za-z_]\w*)\s*\.\s*(split|trim|replace|toLowerCase|toUpperCase)\s*\(([\s\S]*)\)$/i.exec(expr);
      if(operation){
        const value=resolve(frame,operation[1],offset,locals);
        if(one(value.value)===undefined||value.annotations.length)return ev(stop("non-exact String receiver"));
        const args=operation[3].trim()?splitApexTopLevel(operation[3],","):[];
        if(args.some(s=>!/^'(?:\\.|[^'\\])*'$/s.test(clean(s))))return ev(stop("runtime String operation argument"));
        return ev(evaluateApexExpression("receiver."+operation[2]+"("+operation[3]+")",{values:new Map([["receiver",value.value]])}));
      }
      if(/^(?:System\.)?Label\.[A-Za-z_]\w*$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map(),resolveCall:resolveExternal}));
      const member=/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(expr);
      if(member){
        const type=apexSymbols(frame.source,frame.methods).lookup(frame.method,member[1],offset);
        if(type?.endsWith("__mdt")){
          const names=[...maskApexSource(frame.source.slice(frame.method.start,frame.method.end)).matchAll(new RegExp("\\b"+member[1]+"\\s*\\.\\s*([A-Za-z_]\\w*)","gi"))].map(m=>m[1]);
          const record=variable(frame,member[1],offset,locals,[...new Set([...members,...names,member[2]])]);
          if(record.value.kind==="record"){
            const field=record.value.entries.find(([key])=>key.toLowerCase()===member[2].toLowerCase());
            return ev(field?.[1]??stop("metadata member unavailable"));
          }
          return ev(stop("metadata record unresolved"));
        }
        // Constant resolution is allowed only for class-qualified names;
        // an unknown instance member is not an immutable static constant.
        if(!type&&resolveExternal)return ev(resolveExternal("Apex.constant",[textValue(expr)])??stop("unknown constant"));
      }
      const metadata=/^([A-Za-z_]\w*__mdt)\s*\.\s*getInstance\s*\(\s*([A-Za-z_]\w*|'(?:\\.|[^'\\])*')\s*\)$/i.exec(expr);
      if(metadata&&members.length&&members.length<=30&&resolveExternal){
        if(members.some(m=>!identifier.test(m)))return ev(stop("invalid metadata member"));
        const key=resolve(frame,metadata[2],offset,locals);
        const known=one(key.value);
        if(known===undefined&&!policy.allowMetadataCandidateRows)return ev(stop("metadata selector depends on runtime input"));
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
        const rows=resolveExternal("Apex.metadataRows",[textValue(query),...(known!==undefined?[textValue(known)]:[])]);
        if(rows?.kind!=="records"||!rows.items.length||rows.items.length>64)return ev(stop("authoritative metadata rows unavailable"));
        throw new Expand(rowKey,rows.items.map(row=>({kind:"row",row})));
      }
      // Exact, read-only Field Set expression with a source-known name.
      if(/^(?:Schema\.SObjectType\.[A-Za-z_]\w*\.fieldSets\.getMap\(\)\.get\('(?:\\.|[^'\\])*'\)\.getFields\(\)|[A-Za-z_]\w*\.SObjectType\.getDescribe\(\)\.fieldSets\.getMap\(\)\.get\('(?:\\.|[^'\\])*'\)\.getFields\(\))$/i.test(expr))
        return ev(evaluateApexExpression(expr,{values:new Map(),resolveCall:resolveExternal}));
      // Same-owner private straight-line helper return. Keep arguments
      // correlated; no dispatch inference and no evaluation of helper bodies.
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
              if([...inputs.values()].some(v=>v.value.kind==="collection"))return ev(stop("mutable helper argument"));
              const nested:Frame={...frame,method:helper,key:frame.key+"|helper:"+helper.start,depth:frame.depth+1,ancestors:[...frame.ancestors,frameIdentity(frame)]};
              if(helper.body.slice(0,-1).some(n=>n.kind!=="statement"||helper.parameters.some(p=>rx(p).test(maskApexSource(n.text??"")))))return ev(stop("helper input modified"));
              return resolve(nested,ret[1],last!.start,inputs,members);
            }
          }
        }
      }
      return ev(stop("unsupported expression"));
    };
    const variable=(frame:Frame,name:string,offset:number,locals:Locals,members:readonly string[]=[]):Evidence=>{
      tick();
      const id=frame.key+"|"+offset+"|"+name.toLowerCase();
      if(active.has(id))return ev(stop("cyclic variable dependency"));
      active.add(id);
      try{
        const prefix=prefixAt(frame.method.body,offset);
        if(!prefix)return ev(stop("unsupported lexical path"));
        const type=apexSymbols(frame.source,frame.methods).lookup(frame.method,name,offset);
        const key=name.toLowerCase(),param=frame.method.parameters.findIndex(p=>p.toLowerCase()===key);
        const defs=prefix.flatMap((n,i)=>{
          if(n.kind!=="statement")return [];
          const statement=clean(n.text??""),decl=parseApexDeclaration(statement);
          if(decl?.name.toLowerCase()!==key)return [];
          const assignment=/^[\s\S]*?=\s*([\s\S]+);$/.exec(statement);
          return [{index:i,node:n,expression:assignment?.[1],type:decl.type}];
        });
        if(defs.length>1)return ev(stop("ambiguous local declaration"));
        let base:Evidence,after:SourceNode[];
        const collection=/^(?:list|set)<string>$/i.test(type??"");
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
          if(!def.expression)return ev(stop("no initializer"));
          // A direct collection alias may be mutated via another name. Only
          // a fresh collection or a proven read-only getter is supported.
          if(collection&&identifier.test(clean(def.expression)))return ev(stop("mutable collection alias"));
          base=resolve(frame,def.expression,def.node.start,locals,members);
          after=prefix.slice(def.index+1);
        }else if(param>=0){
          const choice=choices.get(frame.key+"|caller");
          if(choice?.kind==="caller"){
            const edge=choice.edge;
            const parent:Frame={filePath:edge.filePath,source:edge.source,methods:edge.methods,method:edge.method,key:frame.key+"|"+edge.filePath+"@"+edge.offset,
              depth:frame.depth+1,ancestors:[...frame.ancestors,frameIdentity(frame)]};
            base=resolve(parent,edge.expressions[param],edge.offset,new Map(),members);
          }else if(scalar.test(type??"")){
            base=ev(runtimeParameter(name,type,"Runtime scalar parameter"));
          }else{
            const candidates=frame.depth<MAX_DEPTH?(index?.sourceCallers(frame.filePath,frame.method)??[]).filter(e=>
              e.filePath+"@"+e.method.start!==frameIdentity(frame)&&!frame.ancestors.includes(e.filePath+"@"+e.method.start)):[];
            if(candidates.length)throw new Expand(frame.key+"|caller",candidates.map(edge=>({kind:"caller",edge})));
            return ev(stop("runtime parameter "+name));
          }
          after=prefix;
        }else return ev(stop("unknown local "+name));
        if(base.value.kind==="unknown"&&!base.value.fragments&&!base.value.symbol)return base;
        const additions:ApexDependencyAppend<A>[]=[];
        let current=base;
        const visit=(nodes:readonly SourceNode[],conditional:boolean,bindings:Locals):boolean=>{
          for(const n of nodes){
            tick();
            const visible=maskApexSource(frame.source.slice(n.start,n.end));
            if(!rx(name).test(visible))continue;
            if(n.kind==="if"){
              if(rx(name).test(maskApexSource(n.condition??""))&&
                !new RegExp("^\\s*!?\\s*"+name+"\\s*\\.\\s*isEmpty\\s*\\(\\s*\\)\\s*$","i").test(clean(n.condition??"")))return false;
              const condition=clean(n.condition??"");
              // A guard invoking Describe/map/metadata predicates is not
              // merely a runtime data flag. It can establish a field's
              // very existence; leave those to authoritative engine proof.
              const calls=[...maskApexSource(condition).matchAll(/\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*\(/g)].map(m=>m[0].replace(/\s|\(/g,""));
              if(calls.some(c=>!(/^(?:String\.(?:isBlank|isNotBlank)|[A-Za-z_]\w*\.isEmpty)$/i.test(c))))return false;
              if(!/^false$/i.test(condition)&&!visit(n.body??[],conditional||!/^true$/i.test(condition),bindings))return false;
              if(!/^true$/i.test(condition)&&!visit(n.otherwise??[],conditional||!/^false$/i.test(condition),bindings))return false;
            }else if(n.kind==="block"){
              if(!visit(n.body??[],conditional,bindings))return false;
            }else if(n.kind==="for"){
              if(!collection||!n.loopVariable||!n.iterable||rx(name).test(maskApexSource(n.iterable)))return false;
              const iterable=resolve(frame,n.iterable,n.start,bindings);
              if(iterable.value.kind!=="collection"||iterable.value.items.length>MAX_COLLECTION_ITEMS)return false;
              for(const item of iterable.value.items){
                const nested=new Map(bindings);nested.set(n.loopVariable.toLowerCase(),ev(textValue(item)));
                if(!visit(n.body??[],conditional,nested))return false;
              }
            }else if(n.kind==="statement"){
              const statement=clean(n.text??"");
              const add=new RegExp("^"+name+"\\s*\\.\\s*(add|addAll)\\s*\\(([\\s\\S]*)\\)\\s*;$","i").exec(statement);
              if(collection&&add){
                const value=resolve(frame,add[2],n.start,bindings);
                const items=add[1].toLowerCase()==="addall"?(value.value.kind==="collection"?value.value.items:undefined):[one(value.value)];
                if(!items||items.some(x=>x===undefined)||current.value.kind!=="collection")return false;
                const merged=[...new Set([...current.value.items,...items as string[]])];
                if(merged.length>MAX_COLLECTION_ITEMS)return false;
                current=ev(listValue(merged,current.value.unique),current.annotations);
                continue;
              }
              const append=new RegExp("^"+name+"\\s*\\+=\\s*([\\s\\S]+);$","i").exec(statement);
              if(type==="string"&&append){
                if(rx(name).test(maskApexSource(append[1])))return false;
                additions.push({evidence:resolve(frame,append[1],n.start,bindings),conditional});
                continue;
              }
              if(type?.endsWith("__mdt")){
                // Reading a scalar configuration member cannot mutate or
                // escape the record; reject assignments and receiver calls.
                const memberRead=new RegExp("\\b"+name+"\\s*\\.\\s*[A-Za-z_]\\w*(?!\\w)(?!\\s*(?:\\(|\\.|=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--))","gi");
                if(!rx(name).test(visible.replace(memberRead,"")))continue;
                return false;
              }
              if(collection){
                // Inert reads only. Any alias or unknown call invalidates
                // the whole collection dependency.
                if(new RegExp("^System\\s*\\.\\s*debug\\s*\\(\\s*"+name+"\\s*\\.\\s*(?:size|isEmpty)\\s*\\(\\s*\\)\\s*\\)\\s*;$","i").test(statement))continue;
                return false;
              }
              // Scalar Strings are passed by value. Do not overlook writes,
              // shadow declarations or mutation through unsupported syntax.
              if(new RegExp("\\b"+name+"\\s*(?:=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--)","i").test(visible)||
                new RegExp("(?:\\+\\+|--)\\s*"+name+"\\b","i").test(visible))return false;
            }else return false;
          }
          return true;
        };
        // Opaque nodes may conceal a write even when lexical slicing cannot
        // establish the relevant identifier; fail closed on those nodes.
        if(after.some(n=>n.kind==="opaque")||!visit(after,false,locals))return ev(stop("unsupported write or alias"));
        if(!additions.length)return current;
        if(additions.every(a=>!a.conditional)){
          for(const a of additions)current=concat(current,a.evidence);
          return current;
        }
        return policy.mergeConditionalAppends?.(current,additions)??ev(stop("conditional String append requires consumer interpretation"));
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
    }catch(error){
      if(error instanceof Bounded){bounded=true;break;}
      if(!(error instanceof Expand))throw error;
      if(choices.has(error.key)||queue.length+error.choices.length>MAX_EDGES||edges+metadataRows+error.choices.length>MAX_EDGES){bounded=true;continue;}
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
