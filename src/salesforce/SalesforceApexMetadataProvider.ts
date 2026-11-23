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
