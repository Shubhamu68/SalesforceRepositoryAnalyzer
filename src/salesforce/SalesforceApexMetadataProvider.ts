import type { ApexMetadataProvider, MetadataResult } from "../core/metadata/ApexMetadataProvider.js";
import type { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";

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
      const record=exact[0];
      const masterValue=record.Value as string; // checked as String above
      if(typeof record.Id!=="string"||!/^[A-Za-z0-9]{15,18}$/.test(record.Id))
        return {complete:false,source:"LIVE_ORG",
          reason:"Custom Label Tooling API identity is missing or invalid."};
      // System.Label is locale-sensitive. Without a proven execution locale,
      // labels with distinct translated values cannot be assigned a single
      // complete structural field list.
      const translations=await this.connection.queryAll<Record<string,unknown>>(
        "SELECT Value FROM ExternalStringLocalization WHERE ExternalStringId = '"+
        record.Id+"'", "tooling", 2000);
      if(translations.some(row=>typeof row.Value!=="string"||row.Value!==masterValue))
        return {complete:false,source:"LIVE_ORG",
          reason:"Custom Label has locale-dependent translations; query structure is not unique."};
      return {complete:true,source:"LIVE_ORG",value:masterValue};
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
    let toolingIssue="Field Set Tooling inventory unavailable.";
    try{
      const q="SELECT Id, DeveloperName, EntityDefinition.QualifiedApiName "+
        "FROM FieldSet WHERE DeveloperName = '"+fieldSetDeveloperName+"' LIMIT 100";
      const all=await this.connection.queryAll<Record<string,unknown>>(q,"tooling",100);
      const matches=all.filter(row=>row.DeveloperName===fieldSetDeveloperName &&
        row.EntityDefinition!==null && typeof row.EntityDefinition==="object" &&
        (row.EntityDefinition as Record<string,unknown>).QualifiedApiName===objectApiName);
      if(matches.length===1 && typeof matches[0].Id==="string" &&
         /^[A-Za-z0-9]{15,18}$/.test(matches[0].Id)){
        try{
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
            if(valid)return {complete:true,source:"LIVE_ORG",value:fields};
          }
          toolingIssue="Field Set displayedFields was incomplete or invalid in Tooling API.";
        }catch(error){
          toolingIssue=error instanceof Error?error.message:"Field Set Tooling metadata query unavailable.";
        }
      }else toolingIssue="Field Set not found or ambiguous in Tooling API for the specified object.";
    }catch(error){
      toolingIssue=error instanceof Error?error.message:"Field Set Tooling API unavailable.";
    }
    // Some orgs expose the FieldSet record through Tooling but omit complete
    // displayedFields. The Metadata API readMetadata SOAP call is read-only;
    // it requires metadata permissions of the already connected Salesforce user.
    try{
      if(typeof this.connection.readFieldSetMetadata!=="function")
        return {complete:false,source:"LIVE_ORG",reason:toolingIssue};
      const fields=await this.connection.readFieldSetMetadata(objectApiName,fieldSetDeveloperName);
      return {complete:true,source:"LIVE_ORG",value:fields};
    }catch(error){
      return {complete:false,source:"LIVE_ORG",
        reason:toolingIssue+" Metadata API fallback: "+
          (error instanceof Error?error.message:"Field Set metadata read unavailable.")};
    }
  }

  async getCustomMetadataRecords(objectApiName:string,fields:readonly string[]):
    Promise<MetadataResult<Array<Record<string,unknown>>>>{
    if(!VALID_NAME.test(objectApiName)||!objectApiName.endsWith("__mdt") ||
       !fields.length||fields.some(field=>!VALID_NAME.test(field)))return {
      complete:false,source:"LIVE_ORG",reason:"Custom Metadata query object or fields invalid.",
    };
    const selected=[...new Set(["DeveloperName",...fields])].sort();
    try{
      const query="SELECT "+selected.join(",")+" FROM "+objectApiName;
      const data=await this.connection.queryAll<Record<string,unknown>>(query,"data",MAX_RECORDS);
      if(data.some(item=>!item||typeof item!=="object"||
         selected.some(field=>!Object.prototype.hasOwnProperty.call(item,field))))
        return {complete:false,source:"LIVE_ORG",
          reason:"Custom Metadata query omitted one or more selected fields."};
      return {complete:true,source:"LIVE_ORG",value:data};
    }catch(error){
      return {complete:false,source:"LIVE_ORG",
        reason:error instanceof Error?error.message:
          "Custom Metadata retrieval incomplete."};
    }
  }
}
