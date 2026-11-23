import type { ApexMetadataProvider, MetadataResult } from "../core/metadata/ApexMetadataProvider.js";
import type { SalesforceOrgConnection } from "./SalesforceOrgConnection.js";

const VALID_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RECORDS=20000;

/** Uses the Analyzer's existing verified CLI-backed Salesforce connection. */
export class SalesforceApexMetadataProvider implements ApexMetadataProvider {
  private readonly fieldsCache=new Map<string,Promise<MetadataResult<string[]>>>();
  private readonly recordsCache=new Map<string,Promise<MetadataResult<Array<Record<string,unknown>>>>>();
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

  async getCustomMetadataRecords(objectApiName:string,fields:readonly string[]):
    Promise<MetadataResult<Array<Record<string,unknown>>>>{
    if(!VALID_NAME.test(objectApiName)||!objectApiName.endsWith("__mdt") ||
       !fields.length||fields.some(field=>!VALID_NAME.test(field)))return {
      complete:false,source:"LIVE_ORG",reason:"Custom Metadata query object or fields invalid.",
    };
    const selected=[...new Set(["DeveloperName",...fields])].sort();
    const key=objectApiName.toLowerCase()+"|"+selected.join(",").toLowerCase();
    let cached=this.recordsCache.get(key);
    if(!cached){
      cached=(async()=>{
        try{
          const query="SELECT "+selected.join(",")+" FROM "+objectApiName;
          const data=await this.connection.queryAll<Record<string,unknown>>(query,"data",MAX_RECORDS);
          return {complete:true,source:"LIVE_ORG" as const,value:data};
        }catch(error){
          return {complete:false,source:"LIVE_ORG" as const,
            reason:error instanceof Error?error.message:"Custom Metadata retrieval incomplete."};
        }
      })();
      this.recordsCache.set(key,cached);
    }
    return cached;
  }
}
