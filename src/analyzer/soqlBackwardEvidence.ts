import {apexSymbols} from "../core/apex/ApexSymbolTable.js";
import {proveConfiguredPredicateDomain} from "../core/apex/ApexConfiguredPredicateDomain.js";
import {addApexValues,runtimeParameter,textValue,unknown,type ApexValue,type ApexTextFragment} from "../core/apex/ApexValueEvaluator.js";
import {traceApexDependencies,type ApexDependencyEvidence,type ApexDependencyAppend,type ApexDependencyExpressionContext} from "../core/apex/ApexBackwardDependencyEngine.js";
import type {ApexRepositoryMethodIndex} from "../core/apex/ApexRepositoryMethodIndex.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import type {ApexCallResolver} from "../core/apex/ApexTypeSystem.js";
import {maskApexSource} from "../core/apex/ApexSourceModel.js";
import {parseApexAccessLevel} from "../core/apex/ApexDatabaseAccessMode.js";
import {reportApexDependency,type ApexDependencyObserver} from "../core/apex/ApexDependencyDiagnostics.js";
import {provePartialSoql} from "./soqlPartialStructure.js";
import {maskSoqlStringsAndComments} from "./soqlExecutionMode.js";
import {aggregatePermissionShapes,simplePermissionShape,permissionSelectFieldPath,type SoqlPermissionShape} from "./soqlPermissionAggregation.js";
const one=(v:ApexValue)=>v.kind==="text"&&v.values.length===1&&!v.scalarType?v.values[0]:undefined;
const stop=(reason:string)=>unknown("SOQL backward evidence: "+reason);
const path=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const MAX_FIELDS=2000;
const runtimeSelectPrefix="schema-filtered-select-additions:";
const optionalWhereType="soql-optional-where-clause";
const partialWhereType="soql-partial-where-clause";
const partialEffectType="soql-schema-effect-partial-select";
type Use=SoqlPermissionShape["fields"][number]&{predicateRoot?:string};
type Evidence=ApexDependencyEvidence<Use>;
const ev=(value:ApexValue,annotations:readonly Use[]=[]):Evidence=>({value,annotations});
const matches=(shape:SoqlPermissionShape,required:readonly Use[],checkRoot=true)=>required.every(f=>(!checkRoot||!f.predicateRoot||f.predicateRoot.toLowerCase()===shape.object.toLowerCase())&&shape.fields.some(x=>x.context===f.context&&x.fieldPath.toLowerCase()===f.fieldPath.toLowerCase()));
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

/** Validate a predicate in isolation. The scaffold never contributes an
 * actual permission field; only WHERE references are transferred. Do not
 * accept complete clauses, subqueries, or repair malformed predicates. */
function strictPredicate(text:string):SoqlPermissionShape|undefined{
  const visible=maskSoqlStringsAndComments(text).trim();
  if(!visible||/^(?:WHERE|AND|OR)\b/i.test(visible)||/\b(?:AND|OR)\s*$/i.test(visible)||
    /\b(?:SELECT|FROM|WITH|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|FOR|TYPEOF)\b/i.test(visible))return undefined;
  return normalizePredicate(textValue(text));
}
function predicateInventory(fields:readonly Use[]):string{
  return [...new Map(fields.filter(f=>f.context==="WHERE").map(f=>[f.fieldPath.toLowerCase(),f.fieldPath])).values()]
    .map(field=>field+" != null").join(" AND ");
}
function partialWhere(text:string,annotations:readonly Use[]=[]):Evidence{
  return ev({kind:"unknown",reason:"Additional runtime WHERE references are not proven",fragments:[
    {kind:"literal",text},{kind:"hole",symbol:{name:"predicate",type:partialWhereType}}
  ]},annotations);
}
function knownPartialPredicate(value:ApexValue):string|undefined{
  if(value.kind!=="unknown"||value.fragments?.length!==2)return undefined;
  const [before,hole]=value.fragments;
  return before.kind==="literal"&&hole.kind==="hole"&&hole.symbol?.type===partialWhereType?before.text:undefined;
}
/** An unproven structural fragment can widen a WHERE inventory, but can
 * never be substituted with a data value or used as proof of enforcement. */
function unknownPredicateAppend(value:ApexValue):boolean{
  if(value.kind!=="unknown"||!value.fragments?.length)return false;
  const [first,...rest]=value.fragments;
  return first.kind==="literal"&&/^\s+(?:WHERE|AND|OR)\s+$/i.test(first.text)&&
    rest.length>0&&rest.some(p=>p.kind==="hole");
}
/** Resolve only source-proven optional predicate and guarded join forms.
 * For a nonempty candidate list, its inventory is independent of whether
 * a particular runtime execution has zero, one or several predicates. */
function abstractPredicateEvidence(context:ApexDependencyExpressionContext,resolve:(expression:string)=>Evidence,resolveAt:(expression:string,offset:number)=>Evidence,platformShadowed:boolean,resolveExternal?:ApexCallResolver):Evidence|undefined{
  const {source,methods,method,expression,offset}=context;
  if(platformShadowed||!expression.includes("?"))return undefined;
  const symbols=apexSymbols(source,methods);
  if(symbols.hasLocalBinding(method,"String",offset)||/\bclass\s+String\b/i.test(maskApexSource(source)))return undefined;
  const optional=/^String\s*\.\s*isNotBlank\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\?\s*\(\s*' WHERE '\s*\+\s*([A-Za-z_]\w*)\s*\)\s*:\s*''$/i.exec(expression);
  if(optional&&optional[1].toLowerCase()===optional[2].toLowerCase()&&symbols.lookup(method,optional[1],offset)==="string"){
    const input=resolve(optional[1]),partial=knownPartialPredicate(input.value);
    const text=partial??fragmentText(input.value);
    if(text===undefined)return undefined;
    if(!text.trim())return input.annotations.length?undefined:ev(textValue(""));
    const proof=strictPredicate(text);
    if(!proof||!matches(proof,input.annotations,false))return undefined;
    const references:Use[]=proof.fields.filter(f=>f.context==="WHERE").map(f=>({...f,predicateRoot:input.annotations.find(a=>a.context===f.context&&a.fieldPath.toLowerCase()===f.fieldPath.toLowerCase())?.predicateRoot}));
    const inventory=" WHERE "+predicateInventory(references);
    return partial!==undefined?partialWhere(inventory,references):ev(textValue(inventory),references);
  }
  const guarded=/^([A-Za-z_]\w*)\s*\.\s*isEmpty\s*\(\s*\)\s*\?\s*''\s*:\s*(String\s*\.\s*join\s*\(\s*([A-Za-z_]\w*)\s*,\s*'\s+(?:AND|OR)\s+'\s*\))$/i.exec(expression);
  if(guarded&&guarded[1].toLowerCase()===guarded[3].toLowerCase()&&symbols.lookup(method,guarded[1],offset)==="list<string>"){
    const domain=proveConfiguredPredicateDomain(context,guarded[1],(expr,at)=>{
      const result=resolveAt(expr,at);
      return result.annotations.length||result.runtimeMembers||result.describeObject?stop("Non-exact configuration dependency"):result.value;
    },resolveExternal);
    if(domain){
      const fields:Use[]=domain.fields.map(fieldPath=>({fieldPath,context:"WHERE",predicateRoot:domain.object}));
      let complete=domain.complete;
      for(const raw of domain.rawPredicates){
        const proof=strictPredicate(raw);
        if(!proof){complete=false;continue;}
        fields.push(...proof.fields.filter(f=>f.context==="WHERE").map(f=>({...f,predicateRoot:domain.object})));
      }
      if(fields.length){
        const inventory=predicateInventory(fields);
        // Even a finite field domain represents conditional execution, not
        // reconstructed business data. A missing raw/default fragment stays
        // structurally unknown and cannot certify effective mode.
        return complete?ev(textValue(inventory),fields):partialWhere(inventory,fields);
      }
    }
    // Ordinary source-proven list joins retain their established behavior.
    return resolve(guarded[2]);
  }
  return undefined;
}

function abstractSoqlExpression(context:ApexDependencyExpressionContext):ApexValue|undefined{
  const {source,methods,method,expression:expr,offset}=context;
  const symbols=apexSymbols(source,methods);
  // Exact optional-clause syntax establishes a token boundary, not the
  // content of the predicate. Never treat it as an executable query.
  const optional=/^String\s*\.\s*isNotBlank\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\?\s*\(\s*' WHERE '\s*\+\s*([A-Za-z_]\w*)\s*\)\s*:\s*''$/i.exec(expr);
  if(optional&&optional[1].toLowerCase()===optional[2].toLowerCase()&&symbols.lookup(method,optional[1],offset)==="string"&&!symbols.hasLocalBinding(method,"String",offset)&&!/\bclass\s+String\b/i.test(maskApexSource(source)))
    return {kind:"unknown",reason:"Optional WHERE content is not fully proven",symbol:{name:optional[1],type:optionalWhereType}};
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
/** Recover a literal ORDER BY suffix separately from an optional unknown
 * predicate. Never treat it as executable SOQL or verified enforcement. */
function provenOrderSuffix(prefix:string,suffix:string,line:number):string|undefined{
  if(suffix.length>16000)return undefined;
  const field="[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?";
  const tail=new RegExp("^\\s+ORDER\\s+BY\\s+("+field+"(?:\\s*,\\s*"+field+")*)(?:\\s+LIMIT\\s+(?:\\d+|:[A-Za-z_]\\w*))?(?:\\s+OFFSET\\s+(?:\\d+|:[A-Za-z_]\\w*))?\\s*$","i").exec(suffix);
  if(!tail)return undefined;
  const text=prefix+" ORDER BY "+tail[1],shape=simplePermissionShape(text,line);
  return shape?.mode==="UNSPECIFIED"&&shape.fields.some(f=>f.context==="ORDER_BY")?text:undefined;
}
function mergeSoqlAppends(base:Evidence,additions:readonly ApexDependencyAppend<Use>[]):Evidence{
  // Conditional fragments are analyzed independently, not concatenated
  // blindly. Preserve predicate/SELECT/ORDER usage and object/mode.
  const original=parseText(base.value);
  const full=original?simplePermissionShape(original):undefined;
  if(full&&matches(full,base.annotations)){
    const shapes=[full];
    const anchor=full.fields.find(f=>f.context==="SELECT")?.fieldPath;
    if(!anchor&&!full.countOnly)return ev(stop("no SELECT anchor"));
    // COUNT() with an exact root and one conditional unknown WHERE suffix
    // retains object evidence without claiming the predicate is resolved.
    if(full.countOnly&&full.fields.length===0&&full.mode==="UNSPECIFIED"&&original&&
      additions.length===1&&additions[0].conditional){
      const addition=additions[0].evidence;
      const parts=addition.value.kind==="unknown"?addition.value.fragments:undefined;
      if(!addition.annotations.length&&parts?.[0]?.kind==="literal"&&/^ WHERE $/i.test(parts[0].text)&&
        parts.length>1&&parts.slice(1).every(p=>p.kind==="hole"))
        return ev({kind:"unknown",reason:"Conditional COUNT predicate unverified",fragments:[
          {kind:"literal",text:original},{kind:"hole",symbol:{name:"predicate",type:optionalWhereType}}]});
    }
    let incompleteWhere=false;
    for(const a of additions){
      const partial=knownPartialPredicate(a.evidence.value);
      if(partial!==undefined){if(full.mode!=="UNSPECIFIED")return ev(stop("Unverified WHERE may affect mode"));incompleteWhere=true;}
      const text=(partial??fragmentText(a.evidence.value))?.trim();
      if(text===undefined){
        if(full.mode==="UNSPECIFIED"&&!a.evidence.annotations.length&&unknownPredicateAppend(a.evidence.value)){
          incompleteWhere=true;continue;
        }
        return ev(stop("unknown appended fragment"));
      }
      if(!text)continue;
      const order=/^ORDER\s+BY\s+/i.test(text);
      const predicate=text.replace(/^(?:WHERE|AND|OR)\s+/i,"");
      const proof=simplePermissionShape("SELECT "+(anchor??"COUNT()")+" FROM "+full.object+(order?" "+text:" WHERE "+predicate));
      if(!proof||proof.mode!=="UNSPECIFIED"||!matches(proof,a.evidence.annotations)||
        !proof.fields.some(f=>f.context===(order?"ORDER_BY":"WHERE"))||
        proof.fields.some(f=>f.context!=="SELECT"&&f.context!==(order?"ORDER_BY":"WHERE")))return ev(stop("unsupported conditional clause"));
      shapes.push({...proof,mode:full.mode});
    }
    const result=aggregatePermissionShapes(shapes);
    return result.length===1?(incompleteWhere?partialWhere(result[0]):ev(textValue(result[0]))):ev(stop("unproven aggregated query"));
  }
  const baseText=fragmentText(base.value);
  const lead=baseText?.match(/^\s*(?:WHERE|AND)\s+/i)?.[0]??"";
  const basePredicate=baseText===undefined?undefined:normalizePredicate(textValue(baseText.slice(lead.length)));
  if(basePredicate){
    const fields=basePredicate.fields.filter(f=>f.context==="WHERE");
    let incompleteWhere=false;
    for(const a of additions){
      const text=fragmentText(a.evidence.value);
      if(text===undefined){
        if(!a.evidence.annotations.length&&unknownPredicateAppend(a.evidence.value)){incompleteWhere=true;continue;}
        return ev(stop("unknown predicate append"));
      }
      const proof=normalizePredicate(textValue(text.replace(/^\s*(?:AND|OR)\s+/i,"")));
      if(!proof||!matches(proof,a.evidence.annotations))return ev(stop("unproven predicate append"));
      fields.push(...proof.fields.filter(f=>f.context==="WHERE"));
    }
    const unique=[...new Map(fields.map(f=>[f.fieldPath.toLowerCase(),f])).values()];
    const inventory=lead+predicateInventory(unique);
    return incompleteWhere?partialWhere(inventory,unique):ev(textValue(inventory),unique);
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
  index?:ApexRepositoryMethodIndex,resolveExternal?:ApexCallResolver,observe?:ApexDependencyObserver):{queries:string[];runtimeFieldQueries?:string[];partialSelectQueries?:string[];bounded:boolean;callerEdges:number;metadataRows:number}{
  const note=(code:string,count?:number)=>reportApexDependency(observe,code,{filePath,source,depth:0},site.offset,undefined,count);
  if(/\bclass\s+Database\b/i.test(maskApexSource(source))){note("SHADOWED_DATABASE");return {queries:[],bounded:false,callerEdges:0,metadataRows:0};}
  const trace=traceApexDependencies<Use>(source,filePath,{expression:site.argument,offset:site.offset},index,resolveExternal,{
    observe,
    abstractExpression:abstractSoqlExpression,
    abstractEvidence:(context,resolve,resolveAt)=>abstractPredicateEvidence(context,resolve,resolveAt,["String","List","Set","Map","Schema","JSON"].some(p=>!!index?.hasSourceClass(p)),resolveExternal),
    allowMetadataCandidateRows:true,
    validatePartialSetMember:member=>!!permissionSelectFieldPath(member),
    join:(list,separator)=>{
      if(list.value.kind==="collection"&&/^\s+(?:AND|OR)\s+$/i.test(separator)&&!list.runtimeMembers&&!list.describeObject&&list.value.items.length<=MAX_FIELDS){
        const predicates=list.value.items.map(strictPredicate);
        if(predicates.some(p=>!p))return undefined;
        const references=predicates.flatMap(p=>p?.fields.filter(f=>f.context==="WHERE")??[]);
        if(list.annotations.some(f=>!references.some(x=>x.context===f.context&&x.fieldPath.toLowerCase()===f.fieldPath.toLowerCase())))return undefined;
        return ev(textValue(predicateInventory(references)),references);
      }
      if(list.value.kind!=="collection"||!/^,\s*$/.test(separator)||list.value.items.length>MAX_FIELDS||list.value.items.some(s=>!permissionSelectFieldPath(s)))return undefined;
      const annotations:Use[]=list.value.items.map(field=>({fieldPath:permissionSelectFieldPath(field)!,context:"SELECT"}));
      if(list.runtimeMembers?.schemaEffectPartial){
        if(!list.value.items.length)return undefined;
        return ev({kind:"unknown",reason:"Only common SELECT members across Schema effects are proven",fragments:[{kind:"literal",text:list.value.items.join(",")},{kind:"hole",symbol:{name:"additionalFields",type:partialEffectType}}]},annotations);
      }
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
  const queries=new Set<string>(),runtimeQueries=new Set<string>(),partialSelectQueries=new Set<string>();
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
      const mode=parseApexAccessLevel(site.accessLevelArgument);
      const parts=proof.value.kind==="unknown"?proof.value.fragments:undefined;
      // The extra SELECT members were validated individually on every
      // concrete alternative; only their common inventory is retained.
      // Never treat this evidence as complete SOQL or verified enforcement.
      if((mode==="USER_MODE"||mode==="SYSTEM_MODE")&&parts&&parts.length>=3){
        const [before,hole,after]=parts;
        if(before.kind==="literal"&&/^\s*SELECT\s+[\w\s.,()]+\s*$/i.test(before.text)&&hole.kind==="hole"&&hole.symbol?.type===partialEffectType&&after.kind==="literal"){
          const root=/^\s+FROM\s+([A-Za-z_]\w*)(?=\s|$)/i.exec(after.text);
          if(root){
            const tail=after.text.slice(root[0].length);
            const remainder=parts.slice(3);
            const boundary=tail.trim()===""?(remainder.length===2&&remainder[0].kind==="hole"&&remainder[0].symbol?.type===optionalWhereType&&remainder[1].kind==="literal"&&/^ ORDER BY /i.test(remainder[1].text)):
              !remainder.length&&/^\s+(?:ORDER BY|WHERE|LIMIT|OFFSET)\s+/i.test(tail);
            if(boundary){
              const evidence=(before.text+root[0]).trim(),select=simplePermissionShape(evidence,site.line);
              if(select&&select.mode==="UNSPECIFIED"&&select.fields.every(f=>f.context==="SELECT")&&matches(select,proof.annotations)){

                const suffix=tail.trim()===""&&remainder[1]?.kind==="literal"?remainder[1].text:tail;
                const retained=provenOrderSuffix(evidence,suffix,site.line)??evidence;
                queries.add(retained);partialSelectQueries.add(retained);
                note("SOQL_PARTIAL_EFFECT_PREFIX_VALIDATED",select.fields.length);
                if(remainder[0]?.kind==="hole"&&remainder[0].symbol?.type===optionalWhereType)note("SOQL_OPTIONAL_WHERE_UNVERIFIED");
                if(retained!==evidence)note("SOQL_ORDER_BY_EVIDENCE_VALIDATED");
                else note("SOQL_ORDER_BY_EVIDENCE_UNVERIFIED");
              }
            }
          }
        }
      }
      const fragments=proof.value.kind==="unknown"?proof.value.fragments:undefined;
      // Keep already proven WHERE/SELECT fields when an additional optional
      // structural predicate is opaque. Explicit AccessLevel is necessary,
      // but effective enforcement remains unknown, just as in Phase 3.
      if((mode==="USER_MODE"||mode==="SYSTEM_MODE")&&fragments&&(fragments.length===2||fragments.length===3)){
        const [prefix,hole,suffix]=fragments;
        if(prefix.kind==="literal"&&hole.kind==="hole"&&hole.symbol?.type===partialWhereType){
          const known=simplePermissionShape(prefix.text.trim(),site.line);
          const retained=suffix?.kind==="literal"?provenOrderSuffix(prefix.text.trim(),suffix.text,site.line):suffix===undefined?prefix.text.trim():undefined;
          if(known?.mode==="UNSPECIFIED"&&retained&&matches(known,proof.annotations)){
            queries.add(retained);partialSelectQueries.add(retained);
            note("SOQL_OPTIONAL_WHERE_UNVERIFIED");
            note("SOQL_KNOWN_WHERE_REFERENCES_VALIDATED",known.fields.filter(f=>f.context==="WHERE").length);
            if(suffix)note("SOQL_ORDER_BY_EVIDENCE_VALIDATED");
          }
        }
      }
      if((mode==="USER_MODE"||mode==="SYSTEM_MODE")&&!index?.hasSourceClass("String")&&fragments&&fragments.length>=3){
        const [prefix,hole,suffix]=fragments;
        if(prefix.kind==="literal"&&/^\s*SELECT\s+[\w\s.,()]+\s+FROM\s+[A-Za-z_]\w*\s*$/i.test(prefix.text)&&hole.kind==="hole"&&hole.symbol?.type===optionalWhereType&&suffix.kind==="literal"&&/^ ORDER BY /i.test(suffix.text)){
          const select=simplePermissionShape(prefix.text.trim(),site.line);
          if(select&&select.mode==="UNSPECIFIED"&&select.fields.every(f=>f.context==="SELECT")&&matches(select,proof.annotations)){

            const evidence=prefix.text.trim(),retained=provenOrderSuffix(evidence,suffix.text,site.line)??evidence;
            queries.add(retained);partialSelectQueries.add(retained);
            note("SOQL_SELECT_PREFIX_VALIDATED",select.fields.length);
            note("SOQL_OPTIONAL_WHERE_UNVERIFIED");
            if(retained!==evidence)note("SOQL_ORDER_BY_EVIDENCE_VALIDATED");
                else note("SOQL_ORDER_BY_EVIDENCE_UNVERIFIED");
          }
        }
      }
      if((mode==="USER_MODE"||mode==="SYSTEM_MODE")&&fragments?.length===2&&
        fragments[0].kind==="literal"&&fragments[1].kind==="hole"&&fragments[1].symbol?.type===optionalWhereType&&
        /^\s*SELECT\s+COUNT\s*\(\s*\)\s+FROM\s+[A-Za-z_]\w*\s*$/i.test(fragments[0].text)){
        const evidence=fragments[0].text.trim(),count=simplePermissionShape(evidence,site.line);
        if(count?.countOnly&&!count.fields.length&&count.mode==="UNSPECIFIED"&&!proof.annotations.length){
          queries.add(evidence);partialSelectQueries.add(evidence);note("SOQL_COUNT_ROOT_VALIDATED");
          note("SOQL_OPTIONAL_WHERE_UNVERIFIED");
        }
      }
      note(proof.value.kind==="unknown"?(proof.value.fragments?.length?"SOQL_RUNTIME_SLOT_UNPROVEN":"SOQL_VALUE_UNRESOLVED"):"SOQL_NON_TEXT_CANDIDATE");
    }else if(shape&&matches(shape,proof.annotations)){
      queries.add(text!.trim());
      if(runtimeObject){runtimeQueries.add(text!.trim());note("RUNTIME_SELECT_KNOWN_FIELDS_VALIDATED",shape.fields.length);}
      note("SOQL_CANDIDATE_VALIDATED",shape.fields.length);
    }else if(shape)note("SOQL_REQUIRED_REFERENCE_MISMATCH");
  }
  note("BACKWARD_VALIDATED_QUERIES",queries.size-partialSelectQueries.size);
  if(partialSelectQueries.size)note("BACKWARD_VALIDATED_SELECT_PREFIXES",partialSelectQueries.size);
  return {queries:[...queries],...(allRuntime&&runtimeQueries.size&&runtimeQueries.size===queries.size?{runtimeFieldQueries:[...runtimeQueries]}:{}),...(partialSelectQueries.size?{partialSelectQueries:[...partialSelectQueries]}:{}),bounded:trace.bounded,callerEdges:trace.callerEdges,metadataRows:trace.metadataRows};
}
