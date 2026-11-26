import type {ApexCallResolver,ApexArgumentTypes} from "./ApexTypeSystem.js";
import {countApex,timeApex} from "./ApexPerformance.js";
import {ApexDataFlowEngine,type ApexFlowOptions} from "./ApexDataFlowEngine.js";
import type {ApexInvocationSelector} from "./ApexInvocationModel.js";
import {listValue,textValue,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import type {ApexRepositoryMethodIndex} from "./ApexRepositoryMethodIndex.js";
import {planCustomMetadataRequest,planCustomMetadataSelectorCandidates,resolveCustomMetadataRows,type CustomMetadataRequest,type CustomMetadataInventory} from "./ApexCustomMetadataQueries.js";
import {fieldSetIdentityKey,type ApexMetadataProvider,type FieldSetIdentity} from "../metadata/ApexMetadataProvider.js";
import {ScanMetadataBatcher} from "../metadata/ScanMetadataBatcher.js";
import {resolveSchemaSnapshot,resolveSchemaFieldMap} from "./ApexSchemaModel.js";
import {exactMetadataStringList} from "./ApexCollectionOperations.js";

type LabelResult=Awaited<ReturnType<NonNullable<ApexMetadataProvider["getCustomLabelValue"]>>>;
type FieldSetResult=Awaited<ReturnType<NonNullable<ApexMetadataProvider["getFieldSetFields"]>>>;
type DescribeResult=Awaited<ReturnType<ApexMetadataProvider["getObjectFieldNames"]>>;
type SchemaResult=Awaited<ReturnType<NonNullable<ApexMetadataProvider["getObjectSchema"]>>>;

// Fresh for each repository scan. Concurrent consumers share a read, but
// changing a label between user-triggered scans never reuses its old value.
interface ScanMetadataReads {
  labels:Map<string,Promise<LabelResult>>;
  fieldSets:Map<string,Promise<FieldSetResult>>;
  describes:Map<string,Promise<DescribeResult>>;
  schemas:Map<string,Promise<SchemaResult>>;
  customMetadata:Map<string,Promise<CustomMetadataInventory>>;
}
function memoRead<T>(cache:Map<string,Promise<T>>,key:string,read:()=>Promise<T>):Promise<T>{
  let pending=cache.get(key);
  if(!pending){pending=read();cache.set(key,pending);}
  return pending;
}
export type ApexExternalResolver=ApexCallResolver;
export type ApexInvocationAnalysis=ReturnType<ApexDataFlowEngine["analyze"]>&{sites:ApexDataFlowEngine["sites"]};
/** Feature-independent synchronous invocation analysis using a supplied resolver. */
export function analyzeApexInvocations(source:string,filePath:string,select:ApexInvocationSelector,
  resolveExternal?:ApexExternalResolver,repositoryIndex?:ApexRepositoryMethodIndex,
  limits?:Pick<ApexFlowOptions,"maxOperations"|"maxPaths"|"maxDepth">):ApexInvocationAnalysis{
  const resolver:ApexExternalResolver=(name,args,types)=>{
    if(name==="Apex.construct"&&args[0]?.kind==="text"&&args[0].values.length===1)
      return repositoryIndex?.constructInstance(filePath,args[0].values[0],args.slice(1),resolveExternal,types?.slice(1))??resolveExternal?.(name,args,types);
    return resolveExternal?.(name,args,types);
  };
  const engine=new ApexDataFlowEngine(source,{...limits,sourceMethods:repositoryIndex?.indexedMethods(filePath,source),selectInvocation:select,resolveExternal:resolver,
    resolvePrivateContexts:owner=>repositoryIndex?.resolvePrivateContexts(filePath,owner,resolveExternal)});
  return {...timeApex("invocation.analysis_ms",()=>engine.analyze()),sites:engine.sites};
}
/** Known caller variants do not imply complete coverage of a public method. */
export function inspectApexInvocationContexts(filePath:string,offset:number,expressions:readonly string[],
  resolveExternal?:ApexExternalResolver,repositoryIndex?:ApexRepositoryMethodIndex){
  return repositoryIndex?.probeInvocationContexts(filePath,offset,expressions,resolveExternal);
}
export interface ApexAnalysisContext {
  readonly repositoryIndex?:ApexRepositoryMethodIndex;
  readonly resolveExternal:ApexExternalResolver;
  /** Local-only resolver retained for diagnostics, not alternative verdicts. */
  readonly resolveLocal:ApexExternalResolver;
}

/** One instance per scan: metadata snapshots are shared within the scan only.
 * The caller supplies an analysis consumer; no security/reporting dependency. */
export class ApexAnalysisEngine {
  private readonly reads:ScanMetadataReads={
    labels:new Map(),fieldSets:new Map(),describes:new Map(),schemas:new Map(),customMetadata:new Map()
  };
  private readonly labelBatch?:ScanMetadataBatcher<string,string>;
  private readonly fieldSetBatch?:ScanMetadataBatcher<FieldSetIdentity,string[]>;
  constructor(readonly repositoryIndex?:ApexRepositoryMethodIndex,
    private readonly metadata?:ApexMetadataProvider){
    if(metadata?.getCustomLabelValue)this.labelBatch=new ScanMetadataBatcher(
      name=>name,name=>metadata.getCustomLabelValue!(name),
      metadata.getCustomLabelValues?names=>metadata.getCustomLabelValues!(names):undefined,
      20,value=>typeof value==="string");
    if(metadata?.getFieldSetFields)this.fieldSetBatch=new ScanMetadataBatcher(
      fieldSetIdentityKey,identity=>metadata.getFieldSetFields!(identity.objectApiName,identity.fieldSetDeveloperName),
      metadata.getFieldSetFieldsBatch?identities=>metadata.getFieldSetFieldsBatch!(identities):undefined,
      10,value=>Array.isArray(value)&&value.length<=200&&value.every(field=>typeof field==="string"&&/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(field)));
  }
  /** Resolve metadata on demand, then return generic selected call arguments. */
  analyzeInvocations(source:string,filePath:string,select:ApexInvocationSelector):Promise<ApexInvocationAnalysis>{
    return this.analyze(filePath,context=>analyzeApexInvocations(source,filePath,select,
      context.resolveExternal,context.repositoryIndex));
  }
  async analyze<T>(filePath:string,consumer:(context:ApexAnalysisContext)=>T):Promise<T>{
  const {repositoryIndex,metadata,reads}=this;
  // Discover the actual metadata dependencies while interpreting a query and
  // its helpers. Unlike source-local regex preloading, a caller can reach a
  // label (or known Field Set) in any indexed helper/member declaration.
  const labelResults=new Map<string,LabelResult>();
  const fieldSetValues=new Map<string,FieldSetResult>();
  const describeSnapshots=new Map<string,DescribeResult>();
  const schemaSnapshots=new Map<string,SchemaResult>();
  const requestedSchemas=new Map<string,string>();
  const requestedLabels=new Set<string>();
  const requestedFieldSets=new Map<string,[string,string]>();
  const requested=new Set<string>();
  const metadataInventories=new Map<string,CustomMetadataInventory>();
  const requestedMetadata=new Map<string,CustomMetadataRequest>();
  // A new resolver identity for each pass invalidates cached helper/member summaries.
  const makeResolver=()=>{
  const baseResolver=(name:string,args:ApexValue[],types?:ApexArgumentTypes):ApexValue|undefined=>{
    if(name==="System.Label"){
      if(args.length!==1||args[0].kind!=="text"||args[0].values.length!==1)
        return unknown("Custom Label identity is not proven.");
      const label=args[0].values[0];
      if(!labelResults.has(label)&&/^[A-Za-z_]\w*$/.test(label))requestedLabels.add(label);
      const result=labelResults.get(label);
      return result?.complete&&typeof result.value==="string"
        ?{kind:"text",values:[result.value]}
        :unknown("Custom Label "+label+" unavailable or incomplete in connected org: "+
          (result?.reason??"No authoritative Tooling API value."));
    }
    if(name==="Apex.scopeField"){
      if(args.length!==4||args.some(item=>
        item.kind!=="text"||item.values.length!==1))
        return unknown("Member field source/owner is not proven.");
      const [owner,field,mode,staticMethod]=args.map(item=>
        item.kind==="text"?item.values[0]:"");
      if(mode!=="this"&&mode!=="unqualified")
        return unknown("Unsupported field member access mode.");
      return repositoryIndex?.evaluateScopeField(owner,field,mode,staticMethod==="true",baseResolver);
    }
    if(name==="Apex.construct"){
      const type=args[0];
      if(type?.kind!=="text"||type.values.length!==1)return unknown("Instance type is not proven.");
      return repositoryIndex?.constructInstance(filePath,type.values[0],args.slice(1),baseResolver,types?.slice(1));
    }
    if(name==="Apex.lazyGetter"){
      if(args.length!==2||args[0].kind!=="text"||args[1].kind!=="text"||args[0].values.length!==1||args[1].values.length!==1)return undefined;
      return repositoryIndex?.evaluateLazyGetter(args[0].values[0],args[1].values[0]);
    }
    if(name==="Apex.constant"){
      const expr=args[0];
      return expr?.kind==="text"&&expr.values.length===1
        ?repositoryIndex?.evaluateConstant(expr.values[0],baseResolver)
        :undefined;
    }
    if(name==="Schema.fieldSetFields"||name==="Utils.getFieldListFromFieldSet"){
      if(args.length!==2||args.some(x=>x.kind!=="text"||x.values.length!==1))
        return unknown("Field Set object and developer name must be proven.");
      const object=(args[0] as Extract<ApexValue,{kind:"text"}>).values[0];
      const fieldSet=(args[1] as Extract<ApexValue,{kind:"text"}>).values[0];
      const key=object+"|"+fieldSet;
      if(!fieldSetValues.has(key)&&/^[A-Za-z_]\w*$/.test(object)&&/^[A-Za-z_]\w*$/.test(fieldSet))
        requestedFieldSets.set(key,[object,fieldSet]);
      const selected=fieldSetValues.get(key);
      return selected?.complete&&selected.value
        ?exactMetadataStringList(selected.value)
        :unknown("Complete Field Set "+object+"."+fieldSet+
          " unavailable from org metadata: "+
          (selected?.reason??"Runtime Field Set identity not proven in this scan."));
    }
    if(name==="Apex.metadataGetInstance"){
      if((args.length!==2&&args.length!==3)||args.some(v=>v.kind!=="text"||v.values.length!==1))return unknown("Custom Metadata getInstance requires a proven developer name.");
      const [type,developerName,field]=args.map(v=>v.kind==="text"?v.values[0]:"");
      if(!/^[A-Za-z_]\w*__mdt$/i.test(type)||!/^[A-Za-z_]\w*$/.test(developerName)||field&&!/^[A-Za-z_]\w*$/.test(field))
        return unknown("Unsupported Custom Metadata getInstance identity or member.");
      // The same provider, exact filters, scan-local memoization and row
      // completeness checks as the Custom Metadata SOQL interpreter.
      const request=planCustomMetadataRequest("[SELECT "+(field??"DeveloperName")+" FROM "+type+" WHERE DeveloperName = :developerName LIMIT 1]",[textValue(developerName)]);
      if("kind" in request)return request;
      const found=metadataInventories.get(request.key);
      if(!found){requestedMetadata.set(request.key,request);return unknown("Custom Metadata getInstance requires authoritative metadata.");}
      const rows=resolveCustomMetadataRows(request,found);
      if(rows.kind!=="records")return rows;
      if(!rows.items.length)return field?unknown("Custom Metadata record is absent."):{kind:"null"};
      if(rows.items.length!==1)return unknown("Custom Metadata getInstance record identity is ambiguous.");
      if(field)return rows.items[0].find(([key])=>key.toLowerCase()===field.toLowerCase())?.[1]??unknown("Custom Metadata record omitted requested field.");
      return {kind:"record",entries:rows.items[0],metadataIdentity:{type,developerName}};
    }
    if(name==="Apex.metadataSelectorCandidates"){
      if(args.length!==1||args[0]?.kind!=="text"||args[0].scalarType||args[0].values.length!==1)
        return unknown("Custom Metadata candidate selector identity is unresolved.");
      const request=planCustomMetadataSelectorCandidates(args[0].values[0]);
      if("kind" in request)return request;
      const found=metadataInventories.get(request.key);
      if(found)return resolveCustomMetadataRows(request,found);
      requestedMetadata.set(request.key,request);
      return unknown("Complete Custom Metadata selector candidates require authoritative metadata.");
    }
    if(name==="Apex.metadataRows"){
      if(args[0]?.kind!=="text"||args[0].values.length!==1)
        return unknown("Custom Metadata SOQL iterator identity is unresolved.");
      const request=planCustomMetadataRequest(args[0].values[0],args.slice(1));
      if("kind" in request)return request;
      const found=metadataInventories.get(request.key);
      if(found)return resolveCustomMetadataRows(request,found);
      requestedMetadata.set(request.key,request);
      return unknown("Complete Custom Metadata "+request.type+
        (metadata?" rows have not been loaded for this filter context.":" requires a connected authoritative org."));
    }
    if(name==="Schema.objectSchema"||name==="Schema.fieldMap"){
      if((name==="Schema.fieldMap"?args.length!==1:args.length!==1&&args.length!==2)||args.some(v=>v.kind!=="text"||v.scalarType||v.values.length!==1||!/^[A-Za-z_]\w*$/.test(v.values[0])))
        return unknown("Schema object or field identity is not proven.");
      const [object,field]=args.map(v=>v.kind==="text"?v.values[0]:"");
      if(repositoryIndex?.hasSourceClass("Schema")||repositoryIndex?.hasSourceClass(object))
        return unknown("Schema token may be shadowed by repository Apex.");
      const key=object.toLowerCase();
      if(!schemaSnapshots.has(key))requestedSchemas.set(key,object);
      return name==="Schema.fieldMap"?resolveSchemaFieldMap(schemaSnapshots.get(key),object):resolveSchemaSnapshot(schemaSnapshots.get(key),object,field);
    }
    if(name==="Schema.describeFields"){
      const object=args[0];
      if(object?.kind!=="text"||object.values.length!==1)
        return unknown("Schema Describe object is not proven.");
      const objectName=object.values[0];
      if(!describeSnapshots.has(objectName)&&/^[A-Za-z_]\w*$/.test(objectName))requested.add(objectName);
      const found=describeSnapshots.get(objectName);
      return found?.complete&&found.value
        ?listValue(found.value,true)
        :unknown("Complete Salesforce Describe unavailable for "+objectName+": "+
          (found?.reason??"Metadata dependency not loaded."));
    }
    return undefined;
  };
  // Backward caller traversal can enter a different source class. Preserve
  // that lexical caller for existing repository accessibility checks.
  const resolver:ApexExternalResolver=(name,args,types,fromFilePath=filePath)=>
    baseResolver(name,args,types) ??
    repositoryIndex?.evaluateReturn(fromFilePath,name,args,baseResolver,types);
    return {baseResolver,resolver};
  };
  // Bound metadata discovery by passes and distinct requests per query class.
  // Never fabricate data for failed lookups or silently use partial results.
  const MAX_PASSES=8,MAX_LABELS=40,MAX_FIELDSETS=30,MAX_DESCRIBES=40,MAX_METADATA=30;
  for(let pass=0;;pass++){
    requestedLabels.clear();requestedFieldSets.clear();requested.clear();requestedSchemas.clear();requestedMetadata.clear();
    const {baseResolver,resolver}=makeResolver();
    countApex("metadata.analysis_passes");
    const analysis=consumer({repositoryIndex,resolveExternal:resolver,resolveLocal:baseResolver});
    if(!metadata||pass>=MAX_PASSES-1)
      return analysis;
    const labels=[...requestedLabels].filter(k=>!labelResults.has(k));
    const sets=[...requestedFieldSets].filter(([k])=>!fieldSetValues.has(k));
    const objects=[...requested].filter(k=>!describeSnapshots.has(k));
    const schemas=[...requestedSchemas].filter(([k])=>!schemaSnapshots.has(k));
    const mdts=[...requestedMetadata.values()].filter(r=>!metadataInventories.has(r.key));
    const canReadLabels=!!metadata.getCustomLabelValue&&labels.length>0&&
      labelResults.size+labels.length<=MAX_LABELS;
    const canReadSets=!!metadata.getFieldSetFields&&sets.length>0&&
      fieldSetValues.size+sets.length<=MAX_FIELDSETS;
    const canReadObjects=objects.length>0&&describeSnapshots.size+objects.length<=MAX_DESCRIBES;
    const canReadSchemas=!!metadata.getObjectSchema&&schemas.length>0&&schemaSnapshots.size+schemas.length<=MAX_DESCRIBES;
    const canReadMetadata=mdts.length>0&&metadataInventories.size+mdts.length<=MAX_METADATA;
    if(!canReadLabels&&!canReadSets&&!canReadObjects&&!canReadSchemas&&!canReadMetadata)
      return analysis;
    await Promise.all([
      ...(canReadLabels?labels.map(async name=>labelResults.set(name,
        await memoRead(reads.labels,name,()=>this.labelBatch!.read(name)))):[]),
      ...(canReadSets?sets.map(async ([key,[object,name]])=>fieldSetValues.set(key,
        await memoRead(reads.fieldSets,key,()=>this.fieldSetBatch!.read({objectApiName:object,fieldSetDeveloperName:name})))):[]),
      ...(canReadObjects?objects.map(async object=>describeSnapshots.set(object,
        await memoRead(reads.describes,object,()=>metadata.getObjectFieldNames(object)))):[]),
      ...(canReadSchemas?schemas.map(async ([key,object])=>schemaSnapshots.set(key,
        await memoRead(reads.schemas,key,()=>metadata.getObjectSchema!(object)))):[]),
      ...(canReadMetadata?mdts.map(async request=>metadataInventories.set(request.key,
        await memoRead(reads.customMetadata,request.key,()=>metadata.getCustomMetadataRecords(request.type,request.selected,request.filters)))):[]),
    ]);
  }
}
}
