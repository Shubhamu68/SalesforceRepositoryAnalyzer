import type { ApexMetadataProvider, MetadataResult, CustomMetadataFilter, CustomMetadataResult, ApexObjectSchema } from "../core/metadata/ApexMetadataProvider.js";
import type { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";
import {recordSoqlCount,timeSoqlPhase} from "../services/SoqlPerformanceMetrics.js";

const VALID_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RECORDS=20000;

/** Uses the Analyzer's existing verified CLI-backed Salesforce connection. */
export class SalesforceApexMetadataProvider implements ApexMetadataProvider {
  private readonly fieldsCache=new Map<string,Promise<MetadataResult<string[]>>>();
  // Metadata row sets are mutable org configuration; refresh on every scan.
  readonly scopeKey:string;
  constructor(private readonly connection:SalesforceOrgConnection){
    const status=connection.status;
    this.scopeKey=[
      status.organizationId??"",status.userId??"",status.instanceUrl??"",status.connectedAt??"",
    ].join("|");
  }
  async getObjectFieldNames(objectApiName:string):Promise<MetadataResult<string[]>>{
    if(!VALID_NAME.test(objectApiName))return {
      complete:false,source:"LIVE_ORG",reason:"Invalid object API name.",
    };
    let cached=this.fieldsCache.get(objectApiName.toLowerCase());
    if(!cached){
      cached=(async()=>{
        try{
          const result=await this.connection.describeSObject(objectApiName);
          if(!Array.isArray(result.fields)||!result.name)return {
            complete:false,source:"LIVE_ORG" as const,reason:"Salesforce Describe did not contain a complete fields array.",
          };
          return {complete:true,source:"LIVE_ORG" as const,
            value:[...new Set(result.fields.map(f=>f.name))].sort()};
        }catch(error){
          return {complete:false,source:"LIVE_ORG" as const,
            reason:error instanceof Error?error.message:"Salesforce Describe unavailable."};
        }
      })();
      this.fieldsCache.set(objectApiName.toLowerCase(),cached);
    }
    return cached;
  }
  /** Reuse the connection's org/epoch-scoped Describe cache. No new endpoint. */
  async getObjectSchema(objectApiName:string):Promise<MetadataResult<ApexObjectSchema>>{
    if(!VALID_NAME.test(objectApiName))return {complete:false,source:"LIVE_ORG",reason:"Invalid object API name."};
    try{
      const result=await this.connection.describeSObject(objectApiName);
      if(typeof result.name!=="string"||result.name.toLowerCase()!==objectApiName.toLowerCase()||
        !Array.isArray(result.fields)||result.fields.some(f=>!f||typeof f.name!=="string"||!VALID_NAME.test(f.name))||
        new Set(result.fields.map(f=>f.name.toLowerCase())).size!==result.fields.length)
        return {complete:false,source:"LIVE_ORG",reason:"Object Describe identity or field list is incomplete."};
      return {complete:true,source:"LIVE_ORG",value:{name:result.name,fields:result.fields.map(f=>({
        name:f.name,
        ...(typeof f.type==="string"?{type:f.type}:{}),
        ...(f.relationshipName===null||typeof f.relationshipName==="string"?{relationshipName:f.relationshipName}:{}),
        ...(Array.isArray(f.referenceTo)&&f.referenceTo.every(v=>typeof v==="string"&&VALID_NAME.test(v))?{referenceTo:[...f.referenceTo]}:{}),
        ...(typeof f.nameField==="boolean"?{nameField:f.nameField}:{})
      }))}};
    }catch(error){
      return {complete:false,source:"LIVE_ORG",reason:error instanceof Error?error.message:"Salesforce Describe unavailable."};
    }
  }
  async getCustomLabelValue(labelApiName:string):Promise<MetadataResult<string>>{
    if(!VALID_NAME.test(labelApiName))return {
      complete:false,source:"LIVE_ORG",reason:"Custom Label API name is invalid.",
    };
    try{
      // Never cache mutable label values across user-triggered analyses.
      // A changed org label must not retain an obsolete SELECT list.
      const soql="SELECT Id, Name, Value, NamespacePrefix FROM ExternalString WHERE Name = '"+
        labelApiName+"' LIMIT 10";
      const rows=await this.connection.queryAll<Record<string,unknown>>(soql,"tooling",10);
      const exact=rows.filter(row=>row.Name===labelApiName);
      if(exact.length!==1||typeof exact[0].Value!=="string")
        return {complete:false,source:"LIVE_ORG",
          reason:exact.length===0
            ?"Custom Label was not found in the selected Salesforce org."
            :"Custom Label is ambiguous or has an invalid value."};
      // Repository snapshot policy uses the org master value, independent
      // of execution locale. Translation Workbench is not a prerequisite.
      return {complete:true,source:"LIVE_ORG",value:exact[0].Value as string};
    }catch(error){
      return {complete:false,source:"LIVE_ORG",
        reason:error instanceof Error?error.message:"Tooling API Custom Label lookup failed."};
    }
  }

  /** Resolve ordered Field Set members from read-only, org-backed metadata. */
  async getFieldSetFields(objectApiName:string,fieldSetDeveloperName:string):
    Promise<MetadataResult<string[]>> {
    if(!VALID_NAME.test(objectApiName)||!VALID_NAME.test(fieldSetDeveloperName))
      return {complete:false,source:"LIVE_ORG",reason:"Invalid Field Set object/name."};
    // Metadata API accepts the full object-qualified identity directly.
    // Prefer it over a two-step Tooling inventory/Metadata lookup: live
    // profiling found eight INVALID_FIELD responses in that older route.
    // Keep the fallback for connections where Metadata API is unavailable.
    let metadataIssue="Metadata API Field Set reader unavailable.";
    if(typeof this.connection.readFieldSetMetadata==="function"){
      recordSoqlCount("org.field_set.soap.calls");
      try{
        const fields=await timeSoqlPhase("org.field_set.soap.cumulative_ms",()=>
          this.connection.readFieldSetMetadata(objectApiName,fieldSetDeveloperName));
        if(!Array.isArray(fields)||fields.length>200||fields.some(field=>
          typeof field!=="string"||!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(field)))
          throw new Error("Metadata API Field Set members are invalid.");
        recordSoqlCount("org.field_set.soap.successes");
        return {complete:true,source:"LIVE_ORG",value:fields};
      }catch(error){
        recordSoqlCount("org.field_set.soap.failures");
        metadataIssue=error instanceof Error?error.message:"Field Set metadata read unavailable.";
      }
    }
    recordSoqlCount("org.field_set.tooling_fallbacks");
    let toolingIssue="Field Set Tooling inventory unavailable.";
    try{
      const q="SELECT Id, DeveloperName, EntityDefinition.QualifiedApiName "+
        "FROM FieldSet WHERE DeveloperName = '"+fieldSetDeveloperName+"' LIMIT 100";
      recordSoqlCount("org.field_set.tooling_inventory.calls");
      const all=await this.connection.queryAll<Record<string,unknown>>(q,"tooling",100);
      const matches=all.filter(row=>row.DeveloperName===fieldSetDeveloperName &&
        row.EntityDefinition!==null && typeof row.EntityDefinition==="object" &&
        (row.EntityDefinition as Record<string,unknown>).QualifiedApiName===objectApiName);
      if(matches.length===1 && typeof matches[0].Id==="string" &&
         /^[A-Za-z0-9]{15,18}$/.test(matches[0].Id)){
        try{
          recordSoqlCount("org.field_set.tooling_detail.calls");
          const full=await this.connection.queryAll<Record<string,unknown>>(
            "SELECT Metadata FROM FieldSet WHERE Id = '"+matches[0].Id+"' LIMIT 1",
            "tooling",1);
          const meta=full.length===1&&full[0].Metadata&&
            typeof full[0].Metadata==="object"
            ?full[0].Metadata as Record<string,unknown>:null;
          if(meta && Array.isArray(meta.displayedFields) &&
             meta.displayedFields.length<=200){
            const fields:string[]=[];
            let valid=true;
            for(const member of meta.displayedFields){
              const field=member && typeof member==="object"
                ?(member as Record<string,unknown>).field:undefined;
              if(typeof field!=="string"||
                 !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(field)){
                valid=false;break;
              }
              fields.push(field);
            }
            if(valid){
              recordSoqlCount("org.field_set.tooling_fallback_successes");
              return {complete:true,source:"LIVE_ORG",value:fields};
            }
          }
          toolingIssue="Field Set displayedFields was incomplete or invalid in Tooling API.";
        }catch(error){
          recordSoqlCount("org.field_set.tooling_detail.failures");
          toolingIssue=error instanceof Error?error.message:"Field Set Tooling metadata query unavailable.";
        }
      }else toolingIssue="Field Set not found or ambiguous in Tooling API for the specified object.";
    }catch(error){
      recordSoqlCount("org.field_set.tooling_inventory.failures");
      toolingIssue=error instanceof Error?error.message:"Field Set Tooling API unavailable.";
    }
    recordSoqlCount("org.field_set.unresolved");
    return {complete:false,source:"LIVE_ORG",
      reason:"Metadata API: "+metadataIssue+" Tooling API fallback: "+toolingIssue};
  }

  async getCustomMetadataRecords(objectApiName:string,fields:readonly string[],filters:readonly CustomMetadataFilter[]=[]):
    Promise<CustomMetadataResult>{
    if(!VALID_NAME.test(objectApiName)||!/__mdt$/i.test(objectApiName) ||
       !fields.length||fields.some(field=>!VALID_NAME.test(field))||filters.length>20||
       filters.some(filter=>!VALID_NAME.test(filter.field)||
         (typeof filter.value!=="string"&&typeof filter.value!=="boolean"&&
           !(typeof filter.value==="number"&&Number.isFinite(filter.value)))))return {
      complete:false,source:"LIVE_ORG",reason:"Custom Metadata query object or fields invalid.",
    };
    const fieldMap=new Map<string,string>();
    for(const field of ["DeveloperName",...fields,...filters.map(filter=>filter.field)])
      fieldMap.set(field.toLowerCase(),field);
    const selected=[...fieldMap.values()].sort();
    try{
      const literal=(value:CustomMetadataFilter["value"]):string=>{
        if(typeof value!=="string")return String(value);
        // Escape SOQL string delimiters; control characters are serialized,
        // never inserted as raw query syntax.
        return "'"+value.replace(/\\/g,"\\\\").replace(/'/g,"\\'")
          .replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/\t/g,"\\t")+"'";
      };
      const where=filters.length?" WHERE "+filters.map(f=>f.field+" = "+literal(f.value)).join(" AND "):"";
      const query="SELECT "+selected.join(",")+" FROM "+objectApiName+where;
      const data=await this.connection.queryAll<Record<string,unknown>>(query,"data",MAX_RECORDS);
      // Salesforce can return canonical field casing even when the Apex
      // query uses a different case (e.g. type__c versus Type__c).
      if(data.some(item=>!item||typeof item!=="object"))
        return {complete:false,source:"LIVE_ORG",reason:"Invalid Custom Metadata row."};
      const normalized:Array<Record<string,unknown>>=[];
      for(const item of data){
        const keys=new Map(Object.keys(item).map(k=>[k.toLowerCase(),k]));
        const row:Record<string,unknown>={};
        for(const field of selected){
          const key=keys.get(field.toLowerCase());
          if(key===undefined)
            return {complete:false,source:"LIVE_ORG",
              reason:"Custom Metadata query omitted selected field "+field+"."};
          row[field]=item[key];
        }
        normalized.push(row);
      }
      return {complete:true,source:"LIVE_ORG",value:normalized,filterEvidence:"SERVER_FILTERED"};
    }catch(error){
      return {complete:false,source:"LIVE_ORG",
        reason:error instanceof Error?error.message:
          "Custom Metadata retrieval incomplete."};
    }
  }
}
