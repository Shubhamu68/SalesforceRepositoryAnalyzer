import type { SalesforceOrgConnection, SalesforceSObjectDescribe } from "./SalesforceOrgConnection.js";
import type { SalesforceFieldMetadataService } from "./SalesforceFieldMetadataService.js";
import {setImmediate as nextTurn} from "node:timers/promises";
import { recordSoqlCount } from "../services/SoqlPerformanceMetrics.js";
import {VerificationReadCache} from "./VerificationReadCache.js";

/**
 * Shared, conservative UserFieldAccess gateway for SOQL, Stack Trace,
 * Access Checker, and Access Matrix. A compound parent is only considered
 * when live Describe establishes the relationship; component access always
 * takes precedence over parent evidence.
 *
 * A parent Read=true can verify the component Read when Salesforce omits its
 * UserFieldAccess row. Parent Read=false is deliberately NOT converted to a
 * confirmed component denial. Parent Edit is never inherited: compound
 * address/location parents are read-only.
 */
type Connection = Pick<SalesforceOrgConnection, "status" | "queryAll" | "describeSObject"> &
  Partial<Pick<SalesforceOrgConnection,"queryToolingComposite"|"getReadEpoch">>;
type DescribeField = SalesforceSObjectDescribe["fields"][number];
type UserAccessRow = {
  UserId: string;
  IsAccessible?: boolean | null;
  IsUpdatable?: boolean | null;
  FieldDefinition?: { QualifiedApiName?: string | null } | null;
};
type DirectAccess = {
  state: "PRESENT" | "MISSING" | "INCONCLUSIVE";
  read: boolean | null;
  edit: boolean | null;
};


export type EffectiveUserFieldAccess = {
  read: boolean | null;
  edit: boolean | null;
  /** Non-empty only when a component's Read was inferred from an explicitly verified parent. */
  readFromCompoundParent?: string;
  /** Origin of non-permissionable field metadata, never proof of user access by itself. */
  nonPermissionableSource?: "LIVE" | "OPTIONAL_CACHE";
  /**
   * Salesforce denied Read on this confirmed compound parent while the
   * component itself had no conclusive direct UserFieldAccess result.
   * read stays null: this is a parent dependency, NOT a direct field denial.
   */
  deniedCompoundParent?: string;
};

/**
 * True only when EVERY checked user has the same independently verified
 * compound-parent denial and no conclusive direct component Read decision.
 * Partial, mixed, or conflicting evidence must remain UNVERIFIED.
 */
export function uniformlyDeniedCompoundParent(
  results: readonly EffectiveUserFieldAccess[],
): string | null {
  if (!results.length || results.some((result) => result.read !== null || !result.deniedCompoundParent)) return null;
  const parent = results[0].deniedCompoundParent!;
  return results.every((result) => result.deniedCompoundParent?.toLowerCase() === parent.toLowerCase())
    ? parent : null;
}

const CACHE_MS = 60_000;
const EXACT_BATCH_SIZE=20;
type ExactRequest={field:string;resolve:(value:DirectAccess)=>void;reject:(error:unknown)=>void};
type ExactGroup={scope:string;userId:string;object:string;requests:ExactRequest[]};
type CompositeExactRequest=ExactRequest&{scope:string;userId:string;object:string};
const COMPOSITE_SIZE=5;
const COMPOSITE_WINDOW_MS=8;
const MAX_CACHE_ENTRIES = 2000;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const standardAddressSuffixes = [
  "GeocodeAccuracy", "PostalCode", "CountryCode", "StateCode",
  "Latitude", "Longitude", "Country", "Street", "State", "City",
];

const norm = (value: string): string => value.trim().toLowerCase();
const userKey = (id: string) => id.slice(0, 15);
const isCompoundType = (type: string | undefined): boolean =>
  ["address", "location", "name"].includes(type?.toLowerCase() ?? "");

/** Only a recognized compound field in Describe may become an FLS parent. */
function compoundParentFromIndexedDescribe(
  fields: ReadonlyMap<string, DescribeField>,
  requestedField: string,
): string | null {
  const component = fields.get(norm(requestedField));
  if (!component) return null;
  if (typeof component.compoundFieldName === "string" && component.compoundFieldName.trim()) {
    const parent = fields.get(norm(component.compoundFieldName));
    if (!parent || norm(parent.name) === norm(component.name)) return null;
    // Explicit Salesforce metadata is authoritative even if the parent has no
    // type in a minimal Describe response.
    if (parent.type && !isCompoundType(parent.type)) return null;
    return parent.name;
  }
  // Some REST Describe versions omit compoundFieldName. Recognize standard
  // and custom address/geolocation syntax only when a live Describe field of
  // compound type is present. Never infer from naming alone.
  const name = component.name;
  const custom = /^(.*)__(City|Country|Street|State|PostalCode|CountryCode|StateCode|GeocodeAccuracy|Latitude|Longitude)__s$/i.exec(name);
  if (custom) {
    const parent = fields.get(norm(custom[1] + "__c"));
    return parent && isCompoundType(parent.type) ? parent.name : null;
  }
  for (const suffix of standardAddressSuffixes) {
    if (!name.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    const candidate = name.slice(0, -suffix.length) + "Address";
    const parent = fields.get(norm(candidate));
    if (parent?.type?.toLowerCase() === "address") return parent.name;
  }
  return null;
}

/** Public single-field helper; the full-object path shares one index instead. */
export function compoundParentFromDescribe(
  describe: Pick<SalesforceSObjectDescribe, "fields">,
  requestedField: string,
): string | null {
  const index = new Map(describe.fields.filter((item) => typeof item.name === "string")
    .map((item) => [norm(item.name), item]));
  return compoundParentFromIndexedDescribe(index, requestedField);
}

function toAccess(rows: UserAccessRow[], userId: string, field: string): DirectAccess {
  if (rows.length === 0) return { state: "MISSING", read: null, edit: null };
  if (rows.some((row) =>
    userKey(row.UserId ?? "") !== userKey(userId) ||
    norm(row.FieldDefinition?.QualifiedApiName ?? "") !== norm(field))) {
    return { state: "INCONCLUSIVE", read: null, edit: null };
  }
  const values = rows.map((row) => ({
    read: typeof row.IsAccessible === "boolean" ? row.IsAccessible : null,
    edit: typeof row.IsUpdatable === "boolean" ? row.IsUpdatable : null,
  }));
  const first = values[0];
  if (values.some((value) => value.read !== first.read || value.edit !== first.edit)) {
    return { state: "INCONCLUSIVE", read: null, edit: null };
  }
  return { state: "PRESENT", read: first.read, edit: first.edit };
}

export class SalesforceUserFieldAccessGateway {
  private readonly fullCache = new VerificationReadCache<Map<string,DirectAccess>>(CACHE_MS,MAX_CACHE_ENTRIES,"org.user_field_gateway");
  private readonly exactCache = new VerificationReadCache<DirectAccess>(CACHE_MS,MAX_CACHE_ENTRIES,"org.user_field_gateway");
  private readonly pendingExact=new Map<string,ExactGroup>();
  private readonly unsupportedBatchUntil=new Map<string,number>();
  private readonly unproductiveBatchUntil=new Map<string,number>();
  private readonly parentCache = new VerificationReadCache<Map<string,string>>(CACHE_MS,MAX_CACHE_ENTRIES,"org.user_field_gateway");
  private readonly compositePending=new Map<string,CompositeExactRequest[]>();
  private readonly compositeDisabledUntil=new Map<string,number>();

  constructor(
    private readonly connection: Connection,
    private readonly metadata?: SalesforceFieldMetadataService,
    private readonly options: {targetedBatching?:boolean;compositeExact?:boolean} = {},
  ) {}

  private scope(): string {
    const status = this.connection.status;
    return [status?.organizationId??"not-connected",status?.instanceUrl??"",status?.userId??"",this.connection.getReadEpoch?.()??""].join("|");
  }

  private async allFields(userId: string, object: string): Promise<Map<string, DirectAccess>> {
    const cacheKey = this.scope() + "|" + userKey(userId) + "|" + norm(object);
    return this.fullCache.read(cacheKey, async () => {
      const soql =
        `SELECT UserId, FieldDefinition.QualifiedApiName, IsAccessible, IsUpdatable FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}'`;
      recordSoqlCount("org.user_field_gateway.object_wide_queries");
      const records = await this.connection.queryAll<UserAccessRow>(soql, "tooling", 20000);
      const byField = new Map<string, UserAccessRow[]>();
      for (const row of records) {
        const name = row.FieldDefinition?.QualifiedApiName;
        if (!name || !FIELD_NAME.test(name)) continue;
        const key = norm(name);
        const previous = byField.get(key) ?? [];
        previous.push(row);
        byField.set(key, previous);
      }
      return new Map([...byField].map(([name, rows]) => [name, toAccess(rows, userId, name)]));
    });
  }

  private async exact(userId: string, object: string, field: string): Promise<DirectAccess> {
    const key = this.scope() + "|" + userKey(userId) + "|" + norm(object) + "|" + norm(field);
    return this.exactCache.read(key, async () => {
      // Preserve exact equality semantics. Composite is an opt-in transport
      // experiment; do not revive the previously unproductive IN filter.
      if((this.options.compositeExact??process.env.SALESFORCE_USER_FIELD_COMPOSITE==="1")&&
        typeof this.connection.queryToolingComposite==="function")
        return this.enqueueCompositeExact(userId,object,field);
      return this.options.targetedBatching===true
        ?this.enqueueExact(userId,object,field):this.singleExact(this.scope(),userId,object,field);
    });
  }

  private exactQuery(userId:string,object:string,field:string):string{
    return `SELECT UserId, IsAccessible, IsUpdatable, FieldDefinition.QualifiedApiName FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}' AND FieldDefinition.QualifiedApiName = '${field}'`;
  }

  private async singleExact(scope:string,userId:string,object:string,field:string):Promise<DirectAccess>{
    if(this.scope()!==scope)throw new Error("Salesforce scope changed before field verification.");
    const soql=this.exactQuery(userId,object,field);
    recordSoqlCount("org.user_field_gateway.exact_queries");
    const rows=await this.connection.queryAll<UserAccessRow>(soql,"tooling",5);
    if(this.scope()!==scope)throw new Error("Salesforce scope changed during field verification.");
    return toAccess(rows,userId,field);
  }

  /** A short bounded coalescing window across independent user/object
   * requests. A composite contains exact GETs, not one widened SOQL query.
   * Each request stays correlated to its own user/object/field identity. */
  private enqueueCompositeExact(userId:string,object:string,field:string):Promise<DirectAccess>{
    const scope=this.scope();
    if((this.compositeDisabledUntil.get(scope)??0)>Date.now())
      return this.singleExact(scope,userId,object,field);
    return new Promise((resolve,reject)=>{
      let group=this.compositePending.get(scope);
      if(!group){
        group=[];this.compositePending.set(scope,group);
        const scheduled=group;
        setTimeout(()=>{if(this.compositePending.get(scope)===scheduled){
          this.compositePending.delete(scope);void this.flushCompositeExact(scheduled);
        }},COMPOSITE_WINDOW_MS);
      }
      group.push({scope,userId,object,field,resolve,reject});
      if(group.length===COMPOSITE_SIZE){
        this.compositePending.delete(scope);void this.flushCompositeExact(group);
      }
    });
  }

  private async flushCompositeExact(group:CompositeExactRequest[]):Promise<void>{
    const scope=group[0].scope;
    const remaining=new Set(group);
    if(group.length>1&&(this.compositeDisabledUntil.get(scope)??0)<=Date.now()){
      try{
        if(this.scope()!==scope)throw Error("Salesforce scope changed before composite verification.");
        const results=await this.connection.queryToolingComposite!<UserAccessRow>(
          group.map(item=>this.exactQuery(item.userId,item.object,item.field)),5);
        if(this.scope()!==scope)throw Error("Salesforce scope changed during composite verification.");
        recordSoqlCount("org.user_field_gateway.composite_batches");
        recordSoqlCount("org.user_field_gateway.composite_subqueries",group.length);
        for(let i=0;i<group.length;i++){
          const item=group[i],rows=results.get(i);
          // A successful, explicitly complete zero-row exact result is
          // MISSING, never DENIED. It follows the same compound fallback.
          if(!rows||rows.length>5||rows.some(row=>!row||typeof row!=="object"))continue;
          const direct=toAccess(rows,item.userId,item.field);
          if(direct.state==="INCONCLUSIVE")continue;
          remaining.delete(item);item.resolve(direct);
          recordSoqlCount("org.user_field_gateway.composite_resolved");
        }
        if(remaining.size===group.length){
          this.disableComposite(scope);
          recordSoqlCount("org.user_field_gateway.composite_unproductive");
        }
      }catch{
        // Unsupported endpoint, session failure, malformed response, etc.
        // Avoid repeating a failed experiment for the same scope and TTL.
        this.disableComposite(scope);
        recordSoqlCount("org.user_field_gateway.composite_failures");
      }
    }
    await Promise.all([...remaining].map(async item=>{
      try{
        if(group.length>1)recordSoqlCount("org.user_field_gateway.composite_exact_fallbacks");
        item.resolve(await this.singleExact(item.scope,item.userId,item.object,item.field));
      }catch(error){item.reject(error);}
    }));
  }
  private disableComposite(scope:string):void{
    if(this.compositeDisabledUntil.size>=32)this.compositeDisabledUntil.clear();
    this.compositeDisabledUntil.set(scope,Date.now()+CACHE_MS);
  }

  private enqueueExact(userId:string,object:string,field:string):Promise<DirectAccess>{
    const scope=this.scope(),key=scope+"|"+userKey(userId)+"|"+norm(object);
    if((this.unsupportedBatchUntil.get(scope)??0)>Date.now()||(this.unproductiveBatchUntil.get(key)??0)>Date.now())
      return this.singleExact(scope,userId,object,field);
    return new Promise((resolve,reject)=>{
      let group=this.pendingExact.get(key);
      if(!group){
        group={scope,userId,object,requests:[]};this.pendingExact.set(key,group);
        const current=group;
        void nextTurn().then(()=>{
          if(this.pendingExact.get(key)===current)this.pendingExact.delete(key);
          return this.flushExact(current);
        }).catch(error=>{for(const item of current.requests)item.reject(error);});
      }
      group.requests.push({field,resolve,reject});
    });
  }

  /** Try bounded same-user/object targeted IN requests. A missing/conflicting
   * row, unsupported filter or failed batch never replaces exact evidence.
   * Retain the original equality fallback, including compound parent rules. */
  private async flushExact(group:ExactGroup):Promise<void>{
    const {scope,userId,object,requests}=group;
    const key=scope+"|"+userKey(userId)+"|"+norm(object);
    for(let i=0;i<requests.length;i+=EXACT_BATCH_SIZE){
      const chunk=requests.slice(i,i+EXACT_BATCH_SIZE);
      const unresolved=new Set(chunk);
      if(chunk.length>1&&(this.unsupportedBatchUntil.get(scope)??0)<=Date.now()&&(this.unproductiveBatchUntil.get(key)??0)<=Date.now()){
        try{
          if(this.scope()!==scope)throw new Error("Salesforce scope changed before field verification.");
          const names=chunk.map(item=>"'"+item.field+"'").join(",");
          const soql=`SELECT UserId, IsAccessible, IsUpdatable, FieldDefinition.QualifiedApiName FROM UserFieldAccess WHERE User.Id = '${userId}' AND FieldDefinition.EntityDefinition.QualifiedApiName = '${object}' AND FieldDefinition.QualifiedApiName IN (${names})`;
          recordSoqlCount("org.user_field_gateway.targeted_batch_queries");
          recordSoqlCount("org.user_field_gateway.targeted_batch_fields",chunk.length);
          const rows=await this.connection.queryAll<UserAccessRow>(soql,"tooling",chunk.length*5);
          if(this.scope()!==scope)throw new Error("Salesforce scope changed during field verification.");
          const requested=new Set(chunk.map(item=>norm(item.field)));
          // Any out-of-scope row means the batch response is unreliable.
          if(rows.every(row=>userKey(row.UserId??"")===userKey(userId)&&requested.has(norm(row.FieldDefinition?.QualifiedApiName??"")))){
            for(const item of chunk){
              const direct=toAccess(rows.filter(row=>norm(row.FieldDefinition?.QualifiedApiName??"")===norm(item.field)),userId,item.field);
              if(direct.state==="PRESENT"&&direct.read!==null&&direct.edit!==null){
                unresolved.delete(item);item.resolve(direct);
                recordSoqlCount("org.user_field_gateway.targeted_batch_resolved");
              }
            }
          }
          if(unresolved.size===chunk.length){
            // No saved equality lookups: avoid repeating a speculative batch
            // for this object/user during the existing freshness window.
            if(this.unproductiveBatchUntil.size>=MAX_CACHE_ENTRIES)this.unproductiveBatchUntil.clear();
            this.unproductiveBatchUntil.set(key,Date.now()+CACHE_MS);
            recordSoqlCount("org.user_field_gateway.targeted_batch_unproductive");
          }
        }catch(error){
          recordSoqlCount("org.user_field_gateway.targeted_batch_failures");
          const status=(error as {statusCode?:number}|null)?.statusCode;
          if(status===400){
            // Some org/API versions reject IN for this virtual object.
            if(this.unsupportedBatchUntil.size>=32)this.unsupportedBatchUntil.clear();
            this.unsupportedBatchUntil.set(scope,Date.now()+CACHE_MS);
          }
        }
      }
      await Promise.all([...unresolved].map(async item=>{
        try{item.resolve(await this.singleExact(scope,userId,object,item.field));}
        catch(error){item.reject(error);}
      }));
    }
  }

  private async direct(userId: string, object: string, field: string): Promise<DirectAccess> {
    try {
      const record = (await this.allFields(userId, object)).get(norm(field));
      if (record) return record; // Direct denials and conflicts always win.
      recordSoqlCount("org.user_field_gateway.missing_row_fallbacks");
    } catch {
      recordSoqlCount("org.user_field_gateway.object_wide_failures");
      // Some orgs reject object-wide queries. A field-specific query may work.
    }
    try {
      return await this.exact(userId, object, field);
    } catch {
      return { state: "INCONCLUSIVE", read: null, edit: null };
    }
  }

  private async compoundParents(object: string): Promise<Map<string, string>> {
    const key = this.scope() + "|" + norm(object);
    return this.parentCache.read(key, async () => {
      const describe = await this.connection.describeSObject(object);
      // The previous per-field helper rebuilt a Map of *every field* for
      // each field in the Describe. On large objects that was O(fields²).
      // A single shared index makes this pass O(fields).
      const index = new Map(describe.fields.filter((item) => typeof item.name === "string")
        .map((item) => [norm(item.name), item]));
      const parents = new Map<string, string>();
      for (const field of describe.fields) {
        const parent = compoundParentFromIndexedDescribe(index, field.name);
        if (parent) parents.set(norm(field.name), parent);
      }
      return parents;
    });
  }

  /** Returns null when Describe is unavailable, ambiguous, or not a compound field. */
  async compoundParent(object: string, field: string): Promise<string | null> {
    if (!FIELD_NAME.test(object) || !FIELD_NAME.test(field)) return null;
    try {
      return (await this.compoundParents(object)).get(norm(field)) ?? null;
    } catch {
      return null;
    }
  }

  async verifyUserField(userId: string, object: string, field: string): Promise<EffectiveUserFieldAccess> {
    const unknown = { read: null, edit: null };
    if (!USER_ID.test(userId) || !FIELD_NAME.test(object) || !FIELD_NAME.test(field)) return unknown;
    // Live EntityParticle proves the absence of configurable individual FLS.
    // An explicitly opted offline cache is NOT direct Salesforce user-access
    // evidence; it must not be misreported as an org-verified user grant.
    const fieldMetadata = await this.metadata?.getField(object, field);
    if (fieldMetadata?.permissionable === false) {
      return fieldMetadata.source === "LIVE"
        ? { read: true, edit: null, nonPermissionableSource: "LIVE" }
        : { read: null, edit: null, nonPermissionableSource: "OPTIONAL_CACHE" };
    }
    const direct = await this.direct(userId, object, field);
    // A confirmed direct grant/denial always wins. A present row with null
    // IsAccessible is not a denial: try a verified compound parent instead.
    // Conflicting or failed direct evidence remains inconclusive.
    if (direct.state === "INCONCLUSIVE" ||
        (direct.state === "PRESENT" && direct.read !== null)) {
      return { read: direct.read, edit: direct.edit };
    }
    const parent = await this.compoundParent(object, field)
      ?? await this.metadata?.getCompoundParent(object, field)
      ?? await this.metadata?.getCompoundNameParent(object, field) ?? null;
    if (!parent) return unknown;
    const parentAccess = await this.direct(userId, object, parent);
    if (parentAccess.state === "PRESENT" && parentAccess.read === true) {
      // Only promote positive, metadata-backed parent READ; parent Edit is
      // irrelevant to a component's independently configurable Edit FLS.
      return { read: true, edit: null, readFromCompoundParent: parent };
    }
    if (parentAccess.state === "PRESENT" && parentAccess.read === false) {
      // Preserve a confirmed dependency without asserting that Salesforce
      // returned an explicit denial for the individual component field.
      return { ...unknown, deniedCompoundParent: parent };
    }
    return unknown;
  }
}
