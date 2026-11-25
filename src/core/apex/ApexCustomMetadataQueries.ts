import { evaluateApexExpression, textValue, booleanValue, unknown, type ApexValue }
  from "./ApexValueEvaluator.js";
import { maskApexSource, matchingPair, stripApexComments } from "./ApexSourceModel.js";
import { parseCustomMetadataQuery, type MetadataLoopQuery } from "./ApexCustomMetadataQueryModel.js";
import type { ApexMetadataProvider, CustomMetadataResult, CustomMetadataFilter } from "../metadata/ApexMetadataProvider.js";

const MAX_ROWS=100;
const MAX_REFERENCES=30;

export function findCustomMetadataLoops(source:string):MetadataLoopQuery[] {
  const clean=stripApexComments(source), visible=maskApexSource(clean);
  const result:MetadataLoopQuery[]=[];
  for(let i=0;i<visible.length;i++){
    if(visible[i]!=="[")continue;
    const end=matchingPair(visible,i,"[","]");
    if(end<0)continue;
    const query=parseCustomMetadataQuery(clean.slice(i,end+1));
    if(query)result.push(query);
    i=end;
    if(result.length>MAX_REFERENCES)break;
  }
  return result;
}

function scalar(value:unknown):ApexValue {
  if(typeof value==="string")return textValue(value);
  if(typeof value==="boolean")return booleanValue(value);
  if(typeof value==="number"&&Number.isFinite(value))return {kind:"number",value};
  return unknown("Custom Metadata value is null or not a scalar.");
}
function single(value:ApexValue):string|undefined {
  if(value.kind==="text"&&value.values.length===1)return value.values[0];
  if(value.kind==="number"&&Number.isFinite(value.value))return String(value.value);
  return undefined;
}

export interface CustomMetadataRequest {
  key:string;
  type:string;
  selected:string[];
  query:MetadataLoopQuery;
  filters:CustomMetadataFilter[];
}
export type CustomMetadataInventory=CustomMetadataResult;

/** Cache the exact typed filter context, not a broader inventory. */
export function planCustomMetadataRequest(expression:string,values:readonly ApexValue[]):
  CustomMetadataRequest|{kind:"unknown";reason:string} {
  const query=parseCustomMetadataQuery(expression);
  if(!query||values.length!==query.predicates.length)
    return {kind:"unknown",reason:"Custom Metadata WHERE or SELECT expression is unsupported."};
  const filters:CustomMetadataRequest["filters"]=[];
  for(const [i,predicate] of query.predicates.entries()){
    const value=single(values[i]);
    if(value===undefined)return {kind:"unknown",reason:"Custom Metadata WHERE "+predicate.field+" has an unresolved runtime bind."};
    const item=values[i];
    const typed=item.kind==="number"?item.value:
      item.kind==="text"&&item.scalarType==="boolean"?value==="true":value;
    filters.push({field:predicate.field,value:typed});
  }
  const selectedMap=new Map<string,string>();
  for(const field of [...query.fields,...query.predicates.map(p=>p.field)])
    selectedMap.set(field.toLowerCase(),field);
  const selected=[...selectedMap.values()].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
  const filterKey=filters.map(f=>[f.field.toLowerCase(),typeof f.value,f.value])
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {key:JSON.stringify([query.type.toLowerCase(),[...selectedMap.keys()].sort(),filterKey]),
    type:query.type,selected,query,filters};
}

/** Apply the current invocation's filters to complete org rows. Never
 * substitute all metadata records for an unknown bind or truncate the set. */
export function resolveCustomMetadataRows(request:CustomMetadataRequest,found:CustomMetadataInventory):ApexValue {
  if(!found.complete||!found.value)
    return unknown("Complete Custom Metadata "+request.type+" rows unavailable: "+
      (found.reason??"Live org metadata not verified."));
  const matching:Array<Array<[string,ApexValue]>>=[];
  for(const raw of found.value){
    if(!raw||typeof raw!=="object")return unknown("Invalid Custom Metadata row.");
    const keys=new Map(Object.keys(raw).map(k=>[k.toLowerCase(),k]));
    const read=(field:string)=>raw[keys.get(field.toLowerCase())!];
    if(request.selected.some(field=>!keys.has(field.toLowerCase())))
      return unknown("Custom Metadata "+request.type+" row omitted selected/filter fields.");
    let included=true;
    // A complete server-filtered result is authoritative, including the
    // platform-specific treatment of empty strings and null field values.
    // Unfiltered/legacy providers must still prove the local predicates.
    for(const {field,value} of found.source==="LIVE_ORG"&&found.filterEvidence==="SERVER_FILTERED"?[]:request.filters){
      const actual=read(field);
      // A null field cannot equal a known non-null scalar. Missing fields
      // are separately rejected above, not silently treated as null.
      if(actual===null){included=false;break;}
      const converted=single(scalar(actual));
      if(converted===undefined)return unknown("Custom Metadata "+request.type+" WHERE "+field+" is not a supported scalar.");
      if(typeof value==="string"?converted.toLowerCase()!==value.toLowerCase():actual!==value){included=false;break;}
    }
    if(!included)continue;
    const values:Array<[string,ApexValue]>=[];
    for(const field of request.query.fields){
      // A singleton configuration row may contain optional null fields or
      // text templates, not only field-path identifiers. Consumers must
      // prove their use before treating those values as query structure.
      const actual=read(field);
      const item:ApexValue=request.query.singletonLimit&&actual===null?{kind:"null"}:scalar(actual);
      if(item.kind==="unknown")return unknown("Custom Metadata "+request.type+" selected field "+field+" is null or unsupported.");
      if(!request.query.singletonLimit&&/(?:^|_)Field__c$/i.test(field)){
        const value=single(item);
        if(!value||!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value))
          return unknown("Custom Metadata "+request.type+" field path "+field+" is invalid.");
      }
      values.push([field,item]);
    }
    matching.push(values);
    if(request.query.singletonLimit&&matching.length>1)
      return unknown("Custom Metadata LIMIT 1 has multiple matching rows without proven ordering.");
    if(matching.length>MAX_ROWS)return unknown("Custom Metadata "+request.type+" exceeds the bounded matching row limit.");
  }
  // No ORDER BY is accepted; deterministic order for field inventory.
  matching.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {kind:"records",items:matching};
}

/** Compatibility utility for consumers resolving source-level literal binds.
 * The main analyzer discovers requests on demand from lexical execution. */
export async function buildCustomMetadataRows(
  source:string,metadata:ApexMetadataProvider|undefined,
  resolveConstant:(name:string)=>ApexValue|undefined,
):Promise<Map<string,ApexValue>>{
  const descriptors=findCustomMetadataLoops(source),outputs=new Map<string,ApexValue>();
  for(const descriptor of descriptors){
    if(!metadata||descriptors.length>MAX_REFERENCES){
      outputs.set(descriptor.expression,unknown(!metadata?"Custom Metadata requires a connected authoritative org.":"Too many Custom Metadata query references."));continue;
    }
    const values=descriptor.predicates.map(p=>evaluateApexExpression(p.right,{
      values:new Map(),resolveCall:(name,args)=>name==="Apex.constant"&&args[0]?.kind==="text"&&args[0].values.length===1?
        resolveConstant(args[0].values[0]):undefined,
    }));
    const request=planCustomMetadataRequest(descriptor.expression,values);
    if("kind" in request){outputs.set(descriptor.expression,request);continue;}
    outputs.set(descriptor.expression,resolveCustomMetadataRows(request,
      await metadata.getCustomMetadataRecords(request.type,request.selected,request.filters)));
  }
  return outputs;
}
