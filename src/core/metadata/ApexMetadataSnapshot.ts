import {randomUUID,createHash} from "node:crypto";
import {mkdir,open,readFile,rename,rm,stat} from "node:fs/promises";
import path from "node:path";
import {fieldSetIdentityKey,type FieldSetIdentity,type ApexMetadataProvider,type MetadataResult,type ApexObjectSchema,type CustomMetadataFilter,type CustomMetadataResult} from "./ApexMetadataProvider.js";

const MAX_ENTRIES=2000,MAX_BYTES=32*1024*1024;
type Request=
  | {kind:"fields"|"schema"|"label";name:string}
  | {kind:"fieldSet";name:string;fieldSet:string}
  | {kind:"customMetadata";name:string;fields:readonly string[];filters:readonly CustomMetadataFilter[]};
type Result=MetadataResult<unknown>&{filterEvidence?:"SERVER_FILTERED"};
type Entry={request:Request;result:Result};
export interface ApexMetadataSnapshot {
  version:1;capturedAt:string;capabilities:{schema:boolean;label:boolean;fieldSet:boolean};
  entries:Entry[];
}
const apiName=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z_]\w*$/.test(v);
const fieldPath=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(v);
const scalar=(v:unknown)=>v===null||typeof v==="string"||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v);
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const key=(r:Request)=>JSON.stringify(r);
function validRequest(r:unknown):r is Request{
  if(!plain(r)||!apiName(r.name))return false;
  if(r.kind==="fields"||r.kind==="schema"||r.kind==="label")return only(r,["kind","name"]);
  if(r.kind==="fieldSet")return only(r,["kind","name","fieldSet"])&&apiName(r.fieldSet);
  return r.kind==="customMetadata"&&only(r,["kind","name","fields","filters"])&&/__mdt$/i.test(r.name)&&
    Array.isArray(r.fields)&&r.fields.length>0&&r.fields.every(apiName)&&Array.isArray(r.filters)&&
    r.filters.every(f=>plain(f)&&only(f,["field","value"])&&apiName(f.field)&&f.value!==null&&scalar(f.value));
}
function validResult(r:Request,v:unknown):v is Result{
  if(!plain(v)||!only(v,["complete","source","value","reason","filterEvidence"])||
    typeof v.complete!=="boolean"||(v.source!=="LIVE_ORG"&&v.source!=="REPOSITORY")||
    (v.reason!==undefined&&typeof v.reason!=="string")||
    (v.filterEvidence!==undefined&&(r.kind!=="customMetadata"||!v.complete||v.filterEvidence!=="SERVER_FILTERED")))return false;
  // Incomplete provider results must never be promoted into usable values.
  if(!v.complete)return v.value===undefined;
  const value=v.value;
  if(r.kind==="fields"||r.kind==="fieldSet")return Array.isArray(value)&&value.every(r.kind==="fields"?apiName:fieldPath);
  if(r.kind==="label")return typeof value==="string";
  if(r.kind==="schema")return plain(value)&&only(value,["name","fields"])&&apiName(value.name)&&
    value.name.toLowerCase()===r.name.toLowerCase()&&Array.isArray(value.fields)&&
    value.fields.every(f=>plain(f)&&only(f,["name","type","relationshipName","referenceTo","nameField"])&&apiName(f.name)&&
      (f.type===undefined||typeof f.type==="string")&&(f.relationshipName===undefined||f.relationshipName===null||apiName(f.relationshipName))&&
      (f.referenceTo===undefined||Array.isArray(f.referenceTo)&&f.referenceTo.every(apiName))&&
      (f.nameField===undefined||typeof f.nameField==="boolean"))&&
    new Set(value.fields.map(f=>f.name.toLowerCase())).size===value.fields.length;
  return Array.isArray(value)&&value.every(row=>plain(row)&&Object.keys(row).every(apiName)&&Object.values(row).every(scalar));
}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
function safeResult(r:Request,result:Result):Result{
  // Provider errors can include server URLs or credentials. Do not store
  // their text. Completeness and usable values are preserved, not error prose.
  const projected:Result={complete:result.complete,source:result.source,
    ...(result.complete?{value:result.value}:{reason:"Captured metadata read was incomplete."}),
    ...(result.complete&&result.filterEvidence?{filterEvidence:result.filterEvidence}:{})};
  if(!validResult(r,projected))throw new Error("Unsupported metadata snapshot response.");
  const copy=clone(projected);
  if(!validResult(r,copy))throw new Error("Metadata response is not JSON-replayable.");
  return copy;
}
function validateSnapshot(value:unknown):ApexMetadataSnapshot{
  if(!plain(value)||!only(value,["version","capturedAt","capabilities","entries"])||value.version!==1||
    typeof value.capturedAt!=="string"||!Number.isFinite(Date.parse(value.capturedAt))||
    !plain(value.capabilities)||!only(value.capabilities,["schema","label","fieldSet"])||
    ["schema","label","fieldSet"].some(k=>typeof (value.capabilities as Record<string,unknown>)[k]!=="boolean")||
    !Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES)throw new Error("Invalid or unsupported metadata snapshot.");
  const seen=new Set<string>();
  for(const entry of value.entries){
    if(!plain(entry)||!only(entry,["request","result"])||!validRequest(entry.request)||!validResult(entry.request,entry.result))
      throw new Error("Invalid metadata snapshot entry.");
    const r=entry.request;
    if((r.kind==="schema"||r.kind==="label"||r.kind==="fieldSet")&&!value.capabilities[r.kind])
      throw new Error("Snapshot entry conflicts with provider capabilities.");
    // Rebuild the key using the canonical property layout, preserving the
    // exact spelling, projection order and typed filter values.
    const k=key(normalize(r));if(seen.has(k))throw new Error("Duplicate metadata snapshot request.");seen.add(k);
  }
  return value as unknown as ApexMetadataSnapshot;
}
function normalize(r:Request):Request{
  if(r.kind==="customMetadata")return {kind:r.kind,name:r.name,fields:[...r.fields],filters:r.filters.map(f=>({field:f.field,value:f.value}))};
  if(r.kind==="fieldSet")return {kind:r.kind,name:r.name,fieldSet:r.fieldSet};
  return {kind:r.kind,name:r.name};
}
function boundedJson(snapshot:ApexMetadataSnapshot):string{
  const json=JSON.stringify(snapshot);
  if(Buffer.byteLength(json)>MAX_BYTES)throw new Error("Metadata snapshot exceeds size limit.");
  return json;
}
/** Per-scan recording wrapper. Delegates every read exactly once; never
 * changes live responses or memoization. A failed capture is not a partial
 * snapshot and cannot alter the analysis verdict. */
export class ApexMetadataCapture {
  readonly provider:ApexMetadataProvider;
  private readonly entries=new Map<string,Entry>();
  private failure=false;
  private bytes=0;
  private readonly capturedAt=new Date().toISOString();
  private readonly capabilities;
  constructor(delegate:ApexMetadataProvider){
    this.capabilities={schema:!!delegate.getObjectSchema,label:!!delegate.getCustomLabelValue,fieldSet:!!delegate.getFieldSetFields};
    const read=async<T extends Result>(request:Request,operation:()=>Promise<T>):Promise<T>=>{
      const result=await operation();
      if(!this.failure)try{
        if(!validRequest(request))throw new Error("Invalid metadata request.");
        const entry={request:normalize(request),result:safeResult(request,result)},k=key(entry.request);
        const previous=this.entries.get(k);
        if(previous&&JSON.stringify(previous.result)!==JSON.stringify(entry.result))throw new Error("Conflicting repeated metadata response.");
        if(!previous){
          this.bytes+=Buffer.byteLength(JSON.stringify(entry));
          if(this.entries.size>=MAX_ENTRIES||this.bytes>MAX_BYTES)throw new Error("Metadata snapshot limit exceeded.");
          this.entries.set(k,entry);
        }
      }catch{this.failure=true;this.entries.clear();}
      return result;
    };
    this.provider={scopeKey:delegate.scopeKey,
      getObjectFieldNames:name=>read({kind:"fields",name},()=>delegate.getObjectFieldNames(name)),
      ...(delegate.getObjectSchema?{getObjectSchema:(name:string)=>read({kind:"schema",name},()=>delegate.getObjectSchema!(name))}:{}),
      ...(delegate.getCustomLabelValue?{getCustomLabelValue:(name:string)=>read({kind:"label",name},()=>delegate.getCustomLabelValue!(name))}:{}),
      ...(delegate.getFieldSetFields?{getFieldSetFields:(name:string,fieldSet:string)=>read({kind:"fieldSet",name,fieldSet},()=>delegate.getFieldSetFields!(name,fieldSet))}:{}),
      ...(delegate.getCustomLabelValue&&delegate.getCustomLabelValues?{getCustomLabelValues:async(names:readonly string[])=>{
        const results=await delegate.getCustomLabelValues!(names);
        const accepted=new Map<string,MetadataResult<string>>();
        for(const name of names){const value=results.get(name);
          if(value?.complete&&typeof value.value==="string")accepted.set(name,await read({kind:"label",name},async()=>value));
        }
        return accepted;
      }}:{}),
      ...(delegate.getFieldSetFields&&delegate.getFieldSetFieldsBatch?{getFieldSetFieldsBatch:async(identities:readonly FieldSetIdentity[])=>{
        const results=await delegate.getFieldSetFieldsBatch!(identities);
        const accepted=new Map<string,MetadataResult<string[]>>();
        for(const identity of identities){const k=fieldSetIdentityKey(identity),value=results.get(k);
          if(value?.complete&&Array.isArray(value.value)&&value.value.length<=200&&value.value.every(fieldPath))
            accepted.set(k,await read({kind:"fieldSet",name:identity.objectApiName,fieldSet:identity.fieldSetDeveloperName},async()=>value));
        }
        return accepted;
      }}:{}),
      getCustomMetadataRecords:(name,fields,filters=[])=>read({kind:"customMetadata",name,fields,filters},()=>delegate.getCustomMetadataRecords(name,fields,filters))};
  }
  snapshot():ApexMetadataSnapshot{
    if(this.failure)throw new Error("Metadata capture incomplete or conflicting; no snapshot saved.");
    return clone({version:1,capturedAt:this.capturedAt,capabilities:this.capabilities,entries:[...this.entries.values()].sort((a,b)=>key(a.request).localeCompare(key(b.request)))});
  }
  async save(directory:string):Promise<string>{
    const json=boundedJson(this.snapshot());
    await mkdir(directory,{recursive:true,mode:0o700});
    const destination=path.resolve(directory,"apex-metadata-"+randomUUID()+".local.json");
    const temp=destination+".tmp";
    try{
      const file=await open(temp,"wx",0o600);
      try{await file.writeFile(json,"utf8");}finally{await file.close();}
      await rename(temp,destination);
      return destination;
    }finally{await rm(temp,{force:true});}
  }
}
/** Offline-only provider, no connection or fallback. Unrecorded requests
 * are incomplete; an exact captured empty result is not a cache miss.
 * Historical source tags describe the recorded input, not live verification. */
export class ApexMetadataReplay {
  readonly provider:ApexMetadataProvider;
  private readonly absent=new Set<string>();
  private readonly used=new Set<string>();
  private readonly entries:Map<string,Entry>;
  constructor(snapshot:ApexMetadataSnapshot){
    const data=validateSnapshot(JSON.parse(boundedJson(snapshot)));
    this.entries=new Map(data.entries.map(e=>[key(normalize(e.request)),e]));
    const read=async<T extends Result>(r:Request):Promise<T>=>{
      const k=key(normalize(r)),found=this.entries.get(k);
      if(found){this.used.add(k);return clone(found.result) as T;}
      this.absent.add(k);
      return {complete:false,source:"REPOSITORY",reason:"Metadata request was not captured; offline replay has no fallback."} as T;
    };
    this.provider={scopeKey:"OFFLINE_REPLAY:"+createHash("sha256").update(boundedJson(data)).digest("hex"),
      getObjectFieldNames:name=>read<MetadataResult<string[]>>({kind:"fields",name}),
      ...(data.capabilities.schema?{getObjectSchema:(name:string)=>read<MetadataResult<ApexObjectSchema>>({kind:"schema",name})}:{}),
      ...(data.capabilities.label?{getCustomLabelValue:(name:string)=>read<MetadataResult<string>>({kind:"label",name})}:{}),
      ...(data.capabilities.fieldSet?{getFieldSetFields:(name:string,fieldSet:string)=>read<MetadataResult<string[]>>({kind:"fieldSet",name,fieldSet})}:{}),
      getCustomMetadataRecords:(name,fields,filters=[])=>read<CustomMetadataResult>({kind:"customMetadata",name,fields,filters})};
  }
  get stats(){return {captured:this.entries.size,used:this.used.size,missing:this.absent.size};}
  /** Request identities only; filter values and label contents stay private. */
  get missingRequests(){return [...this.absent].map(k=>{const r=JSON.parse(k) as Request;return {kind:r.kind,name:r.name,...(r.kind==="fieldSet"?{fieldSet:r.fieldSet}:{})};});}
  static async load(file:string):Promise<ApexMetadataReplay>{
    if((await stat(file)).size>MAX_BYTES)throw new Error("Metadata snapshot exceeds size limit.");
    const raw=await readFile(file,"utf8");
    if(Buffer.byteLength(raw)>MAX_BYTES)throw new Error("Metadata snapshot exceeds size limit.");
    return new ApexMetadataReplay(validateSnapshot(JSON.parse(raw)));
  }
}
