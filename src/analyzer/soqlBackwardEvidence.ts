import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import {addApexValues,runtimeParameter,textValue,unknown,type ApexValue,type ApexTextFragment} from "../core/apex/ApexValueEvaluator.js";
import {traceApexDependencies,type ApexDependencyEvidence,type ApexDependencyAppend,type ApexDependencyExpressionContext} from "../core/apex/ApexBackwardDependencyEngine.js";
import type {ApexRepositoryMethodIndex} from "../core/apex/ApexRepositoryMethodIndex.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import type {ApexCallResolver} from "../core/apex/ApexTypeSystem.js";
import {maskApexSource} from "../core/apex/ApexSourceModel.js";
import {reportApexDependency,type ApexDependencyObserver} from "../core/apex/ApexDependencyDiagnostics.js";
import {provePartialSoql} from "./soqlPartialStructure.js";
import {aggregatePermissionShapes,simplePermissionShape,permissionSelectFieldPath,type SoqlPermissionShape} from "./soqlPermissionAggregation.js";
const one=(v:ApexValue)=>v.kind==="text"&&v.values.length===1&&!v.scalarType?v.values[0]:undefined;
const stop=(reason:string)=>unknown("SOQL backward evidence: "+reason);
const path=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const MAX_FIELDS=2000;
const runtimeSelectPrefix="schema-filtered-select-additions:";
type Use=SoqlPermissionShape["fields"][number];
type Evidence=ApexDependencyEvidence<Use>;
const ev=(value:ApexValue,annotations:readonly Use[]=[]):Evidence=>({value,annotations});
const matches=(shape:SoqlPermissionShape,required:readonly Use[])=>required.every(f=>shape.fields.some(x=>x.context===f.context&&x.fieldPath.toLowerCase()===f.fieldPath.toLowerCase()));
function parseText(value:ApexValue):string|undefined{
  const exact=one(value);if(exact!==undefined)return exact;
  if(value.kind!=="unknown"||!value.fragments)return undefined;
  // A String.escapeSingleQuotes call is evidence of *intended* quoted
  // literal use, not an injection-safety proof. Never use it to fill an
  // identifier, an entire query, or a structural predicate hole.
  const fragments:ApexTextFragment[]=[];
  let prefix="";
  for(const [i,part] of value.fragments.entries()){
    if(part.kind==="literal"){fragments.push(part);prefix+=part.text;continue;}
    if(part.symbol?.type!=="soql-escaped-value"){
      fragments.push(part);prefix+="0";continue;
    }
    const suffix=value.fragments[i+1];
    if(suffix?.kind!=="literal"||!/^%?'(?:\s*$|\s+(?:AND|OR|GROUP\s+BY|ORDER\s+BY|WITH|LIMIT|OFFSET|HAVING|FOR)\b|\s*\))/i.test(suffix.text))return undefined;
    let quoted=false,opening=-1;
    for(let j=0;j<prefix.length;j++){
      if(quoted&&prefix[j]==="\\"){j++;continue;}
      if(prefix[j]==="'"){quoted=!quoted;if(quoted)opening=j;}
    }
    if(!quoted||!/^%?$/.test(prefix.slice(opening+1))||
      !/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|=|(?:NOT\s+)?LIKE)\s*$/i.test(prefix.slice(0,opening)))return undefined;
    fragments.push({kind:"literal",text:"sample"});prefix+="sample";
  }
  if(fragments.every(f=>f.kind==="literal"))return fragments.map(f=>f.kind==="literal"?f.text:"").join("");
  return provePartialSoql({...value,fragments})?.text;
}
function normalizePredicate(value:ApexValue):SoqlPermissionShape|undefined{
  const scaffold=addApexValues(textValue("SELECT Id FROM TraceObject__c WHERE "),value);
  const text=parseText(scaffold);
  if(text===undefined)return undefined;
  const trimmed=text.replace(/\s+AND\s*$/i,"").trim();
  const shape=simplePermissionShape(trimmed);
  return shape?.mode==="UNSPECIFIED"&&shape.fields.some(f=>f.context==="WHERE")&&shape.fields.every(f=>f.context==="SELECT"||f.context==="WHERE")?shape:undefined;
}
function fragmentText(value:ApexValue):string|undefined{
  const exact=one(value);if(exact!==undefined)return exact;
  // Only used in a predicate scaffold, not a general String conversion.
  const scaffold="SELECT Id FROM TraceObject__c WHERE ";
  const parsed=parseText(addApexValues(textValue(scaffold),value));
  return parsed?.slice(scaffold.length);
}

function abstractSoqlExpression(context:ApexDependencyExpressionContext):ApexValue|undefined{
  const {source,methods,method,expression:expr,offset}=context;
  const symbols=apexSymbols(source,methods);
      const escaped=/^String\s*\.\s*escapeSingleQuotes\s*\(\s*([A-Za-z_]\w*)\s*\)$/i.exec(expr);
      if(escaped){
        if(symbols.lookup(method,"String",offset)||symbols.lookup(method,escaped[1],offset)!=="string")return stop("unproven escape input");
        // The runtime value is immaterial; this marker is recognized only
        // within a parser-validated complete quoted predicate literal.
        return {kind:"unknown",reason:"Intended escaped predicate value",symbol:{name:escaped[1],type:"soql-escaped-value"}};
      }
      const date=/^String\s*\.\s*valueOf\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\.\s*substring\s*\(\s*0\s*,\s*10\s*\)$/i.exec(expr);
      if(date&&/^(?:date|datetime)$/i.test(apexSymbols(source,methods).lookup(method,date[1],offset)??""))
        return runtimeParameter(date[1],"date","Typed date parser slot");
  return undefined;
}
function mergeSoqlAppends(base:Evidence,additions:readonly ApexDependencyAppend<Use>[]):Evidence{
  // Conditional fragments are analyzed independently, not concatenated
  // blindly. Preserve predicate/SELECT/ORDER usage and object/mode.
  const original=parseText(base.value);
  const full=original?simplePermissionShape(original):undefined;
  if(full&&matches(full,base.annotations)){
    const shapes=[full];
    const anchor=full.fields.find(f=>f.context==="SELECT")?.fieldPath;
    if(!anchor)return ev(stop("no SELECT anchor"));
    for(const a of additions){
      const text=fragmentText(a.evidence.value)?.trim();
      if(text===undefined)return ev(stop("unknown appended fragment"));
      if(!text)continue;
      const order=/^ORDER\s+BY\s+/i.test(text);
      const predicate=text.replace(/^(?:WHERE|AND|OR)\s+/i,"");
      const proof=simplePermissionShape("SELECT "+anchor+" FROM "+full.object+(order?" "+text:" WHERE "+predicate));
      if(!proof||proof.mode!=="UNSPECIFIED"||!matches(proof,a.evidence.annotations)||
        !proof.fields.some(f=>f.context===(order?"ORDER_BY":"WHERE"))||
        proof.fields.some(f=>f.context!=="SELECT"&&f.context!==(order?"ORDER_BY":"WHERE")))return ev(stop("unsupported conditional clause"));
      shapes.push({...proof,mode:full.mode});
    }
    const result=aggregatePermissionShapes(shapes);
    return result.length===1?ev(textValue(result[0])):ev(stop("unproven aggregated query"));
  }
  const baseText=fragmentText(base.value);
  const lead=baseText?.match(/^\s*(?:WHERE|AND)\s+/i)?.[0]??"";
  const basePredicate=baseText===undefined?undefined:normalizePredicate(textValue(baseText.slice(lead.length)));
  if(basePredicate){
    const fields=basePredicate.fields.filter(f=>f.context==="WHERE");
    for(const a of additions){
      const text=fragmentText(a.evidence.value);
      if(text===undefined)return ev(stop("unknown predicate append"));
      const proof=normalizePredicate(textValue(text.replace(/^\s*(?:AND|OR)\s+/i,"")));
      if(!proof||!matches(proof,a.evidence.annotations))return ev(stop("unproven predicate append"));
      fields.push(...proof.fields.filter(f=>f.context==="WHERE"));
    }
    const unique=[...new Map(fields.map(f=>[f.fieldPath.toLowerCase(),f])).values()];
    return ev(textValue(lead+unique.map(f=>f.fieldPath+" != null").join(" AND ")),unique);
  }
  // Complete comma-delimited field paths, never identifier fragments.
  // Require every resulting field to occur in the final SELECT.
  const columns=original?.split(",").map(s=>s.trim());
  if(columns?.length&&columns.every(s=>path.test(s))){
    for(const a of additions){
      const text=one(a.evidence.value);
      if(text===undefined||a.evidence.annotations.length||!/^\s*,/.test(text))return ev(stop("unknown SELECT append"));
      const extra=text.trim().slice(1).split(",").map(s=>s.trim());
      if(!extra.length||extra.some(s=>!path.test(s)))return ev(stop("invalid SELECT append"));
      columns.push(...extra);
    }
    const unique=[...new Set(columns)];
    return unique.length<=MAX_FIELDS?ev(textValue(unique.join(",")),unique.map(fieldPath=>({fieldPath,context:"SELECT"}))):ev(stop("field limit"));
  }
  return ev(stop("conditional fragment is not a proven query, predicate or field list"));
}
export function backtrackSoqlPermissionShapes(source:string,filePath:string,site:ApexCallSite,
  index?:ApexRepositoryMethodIndex,resolveExternal?:ApexCallResolver,observe?:ApexDependencyObserver):{queries:string[];runtimeFieldQueries?:string[];bounded:boolean;callerEdges:number;metadataRows:number}{
  const note=(code:string,count?:number)=>reportApexDependency(observe,code,{filePath,source,depth:0},site.offset,undefined,count);
  if(/\bclass\s+Database\b/i.test(maskApexSource(source))){note("SHADOWED_DATABASE");return {queries:[],bounded:false,callerEdges:0,metadataRows:0};}
  const trace=traceApexDependencies<Use>(source,filePath,{expression:site.argument,offset:site.offset},index,resolveExternal,{
    observe,
    abstractExpression:abstractSoqlExpression,
    allowMetadataCandidateRows:true,
    allowConditionalScalarCandidates:true,
    join:(list,separator)=>{
      if(list.value.kind!=="collection"||!/^,\s*$/.test(separator)||list.value.items.length>MAX_FIELDS||list.value.items.some(s=>!permissionSelectFieldPath(s)))return undefined;
      const annotations:Use[]=list.value.items.map(field=>({fieldPath:permissionSelectFieldPath(field)!,context:"SELECT"}));
      if(list.runtimeMembers){
        // Do not fill arbitrary runtime identifiers. The core has proven
        // only optional additions constrained by a specific Describe map.
        // Preserve the hole until its final SELECT placement is validated.
        if(!list.runtimeMembers.describeObject||!list.value.items.length)return undefined;
        return ev({kind:"unknown",reason:"Runtime-dependent additional schema field names",fragments:[
          {kind:"literal",text:list.value.items.join(",")},
          {kind:"hole",symbol:{name:"additionalFields",type:runtimeSelectPrefix+list.runtimeMembers.describeObject}}
        ]},annotations);
      }
      return ev(textValue(list.value.items.join(",")),annotations);
    },
    mergeConditionalAppends:(base,additions)=>{
      const result=mergeSoqlAppends(base,additions);
      if(result.value.kind==="unknown")note("SOQL_CONDITIONAL_MERGE_REJECTED");
      else note("SOQL_CONDITIONAL_MERGE_ACCEPTED",additions.length);
      return result;
    }
  });
  const queries=new Set<string>(),runtimeQueries=new Set<string>();
  let allRuntime=trace.candidates.length>0&&!trace.bounded;
  note("BACKWARD_CANDIDATES",trace.candidates.length);
  for(const proof of trace.candidates){
    let runtimeObject:string|undefined;
    let text=parseText(proof.value);
    // Permit omission of optional schema-constrained members ONLY at the
    // complete SELECT list boundary of the same root object. All other
    // fragments must be literal; no unproven predicate or mode is omitted.
    if(proof.value.kind==="unknown"&&proof.value.fragments?.length===3){
      const [before,hole,after]=proof.value.fragments;
      if(before.kind==="literal"&&hole.kind==="hole"&&hole.symbol?.type.startsWith(runtimeSelectPrefix)&&after.kind==="literal"&&
        /^\s*SELECT\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*$/i.test(before.text)&&/^\s+FROM\s+[A-Za-z_]\w*\b/i.test(after.text)){
        runtimeObject=hole.symbol.type.slice(runtimeSelectPrefix.length);
        text=before.text+after.text;
      }
    }
    const shape=text?simplePermissionShape(text,site.line,observe?(code)=>note(code):undefined):undefined;
    if(runtimeObject&&(!shape||shape.object.toLowerCase()!==runtimeObject.toLowerCase()||!matches(shape,proof.annotations))){
      note("RUNTIME_SELECT_DOMAIN_MISMATCH");allRuntime=false;continue;
    }
    if(!runtimeObject)allRuntime=false;
    if(!text){
      note(proof.value.kind==="unknown"?(proof.value.fragments?.length?"SOQL_RUNTIME_SLOT_UNPROVEN":"SOQL_VALUE_UNRESOLVED"):"SOQL_NON_TEXT_CANDIDATE");
    }else if(shape&&matches(shape,proof.annotations)){
      queries.add(text!.trim());
      if(runtimeObject){runtimeQueries.add(text!.trim());note("RUNTIME_SELECT_KNOWN_FIELDS_VALIDATED",shape.fields.length);}
      note("SOQL_CANDIDATE_VALIDATED",shape.fields.length);
    }else if(shape)note("SOQL_REQUIRED_REFERENCE_MISMATCH");
  }
  note("BACKWARD_VALIDATED_QUERIES",queries.size);
  return {queries:[...queries],...(allRuntime&&runtimeQueries.size&&runtimeQueries.size===queries.size?{runtimeFieldQueries:[...runtimeQueries]}:{}),bounded:trace.bounded,callerEdges:trace.callerEdges,metadataRows:trace.metadataRows};
}
