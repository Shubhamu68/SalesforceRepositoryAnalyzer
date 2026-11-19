import type { Persona } from "../models/Persona.js";
import { recordSoqlCount, timeSoqlPhase } from "./SoqlPerformanceMetrics.js";
import type { OrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import { isStatusNeutralOrgObjectRead } from "../config/orgVerificationStatusPolicy.js";
import { isFieldLevelSecurityApplicable, PLATFORM_EVENT_FLS_REASON } from "../config/fieldSecurityPolicy.js";
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from "../salesforce/SalesforcePersonaAccessVerifier.js";
import type { SalesforceFieldMetadataService } from "../salesforce/SalesforceFieldMetadataService.js";

/**
 * Single org-verification gateway for every analyzer.
 *
 * A repository grant is sufficient evidence of a grant. A missing repository
 * grant is NOT a denial: verify against matching active users in Salesforce.
 * Salesforce DENIED is the only source of a confirmed missing permission.
 */
export type ReadDecisionSource = "REPOSITORY" | "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
export type ObjectReadDecisionSource = ReadDecisionSource;

export interface ObjectReadDecision {
  source: ReadDecisionSource;
  readable: boolean;
  /** A configured object Read may count as green in Stack Trace, never its fields. */
  statusNeutral: boolean;
  message: string;
  checkedUsers?: number;
  /** Original Salesforce evidence, including matched usernames, if available. */
  orgEvidence?: OrgObjectAccessEvidence;
}

export interface FieldReadDecision extends Omit<ObjectReadDecision, "statusNeutral"> {
  field: string;
}

// Retained for compatibility with older rules/tests. No longer an exception
// list: EVERY repository-missing object or permissionable field is eligible
// for org verification, regardless of API name.
const ACCOUNT_ADDRESS_FIELDS = new Set([
  "billingaddress", "billingstreet", "billingcity", "billingstate", "billingstatecode",
  "billingpostalcode", "billingcountry", "billingcountrycode", "billinglatitude",
  "billinglongitude", "billinggeocodeaccuracy", "shippingaddress", "shippingstreet",
  "shippingcity", "shippingstate", "shippingstatecode", "shippingpostalcode",
  "shippingcountry", "shippingcountrycode", "shippinglatitude", "shippinglongitude",
  "shippinggeocodeaccuracy",
]);
export function isAccountStandardAddressField(object: string, field: string): boolean {
  return object.trim().toLowerCase() === "account" && ACCOUNT_ADDRESS_FIELDS.has(field.trim().toLowerCase());
}

const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 4000;
const MAX_INFLIGHT_ORG_CHECKS = 3;
type CacheEntry<T> = { until: number; value: Promise<T> };

export class OrgObjectReadVerificationService {
  private readonly objectChecks = new Map<string, CacheEntry<OrgObjectAccessEvidence | undefined>>();
  private readonly fieldChecks = new Map<string, CacheEntry<OrgObjectAccessEvidence | undefined>>();
  private inflight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly policy: OrgVerificationStatusPolicy,
    private readonly verifier?: SalesforcePersonaAccessVerifier,
    private readonly fieldMetadata?: SalesforceFieldMetadataService,
  ) {}

  /** Status-neutral reporting is separate from access verification eligibility. */
  isConfigured(object: string): boolean {
    return isStatusNeutralOrgObjectRead(this.policy, object);
  }

  /** All missing repository FLS grants must be checked, not only Account fields. */
  shouldVerifyMissingRepositoryField(object: string, _field: string): boolean {
    return isFieldLevelSecurityApplicable(object);
  }

  private cacheKey(persona: Persona, object: string, field?: string): string {
    const scope = this.verifier?.getVerificationScope?.() ?? "unknown-org";
    return JSON.stringify([
      scope,
      persona.name.trim().toLowerCase(),
      (persona.profile ?? "").trim().toLowerCase(),
      [...persona.permissionSets].map((name) => name.toLowerCase()).sort(),
      [...persona.permissionSetGroups].map((name) => name.toLowerCase()).sort(),
      object.trim().toLowerCase(), (field ?? "").trim().toLowerCase(),
    ]);
  }

  private cached<T>(cache: Map<string, CacheEntry<T>>, key: string, lookup: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    const prefix = cache === this.objectChecks ? "org.object_checks" : "org.field_checks";
    if (hit && hit.until > Date.now()) {
      recordSoqlCount(prefix + ".cache_hits");
      return hit.value;
    }
    recordSoqlCount(prefix + ".cache_misses");
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    const promise = lookup();
    cache.set(key, { until: Date.now() + CACHE_MS, value: promise });
    return promise;
  }

  /** Bound Salesforce verification calls across ALL analyzers, not per feature. */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.inflight >= MAX_INFLIGHT_ORG_CHECKS) {
      recordSoqlCount("org.verification.queue_waits");
      // The finishing worker hands its slot directly to this waiter.
      // Do not increment inFlight again after waking: doing so can exceed
      // the limit if another request arrives between release and resume.
      await timeSoqlPhase("org.verification.queue_cumulative_ms",
        () => new Promise<void>((resume) => this.waiting.push(resume)));
    } else {
      this.inflight++;
    }
    try { return await timeSoqlPhase("org.verification.work_cumulative_ms", work); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.inflight--;
    }
  }

  /** The same cached Salesforce UserEntityAccess check is used everywhere. */
  async verifyObject(persona: Persona, object: string): Promise<OrgObjectAccessEvidence | undefined> {
    if (!this.verifier) return undefined;
    return this.cached(this.objectChecks, this.cacheKey(persona, object),
      () => this.limited(() => this.verifier!.verifyObjectRead(persona, object)));
  }

  /** Repository-first object permission resolution; no object-name restrictions. */
  async resolve(persona: Persona, object: string, repositoryRead: boolean): Promise<ObjectReadDecision> {
    if (repositoryRead) return {
      source: "REPOSITORY", readable: true, statusNeutral: false,
      message: "Object Read permission established from repository metadata.",
    };
    const evidence = await this.verifyObject(persona, object);
    const source: ReadDecisionSource = !evidence ? "UNVERIFIED"
      : evidence.outcome === "VERIFIED" ? "ORG_VERIFIED"
      : evidence.outcome === "DENIED" ? "ORG_DENIED" : "UNVERIFIED";
    return {
      source, readable: source === "ORG_VERIFIED",
      statusNeutral: source === "ORG_VERIFIED" && this.isConfigured(object),
      message: evidence?.message ?? "Repository object Read is not established and Salesforce verification is unavailable.",
      ...(evidence ? { checkedUsers: evidence.checkedUsers, orgEvidence: evidence } : {}),
    };
  }

  /** Cached raw field evidence, shared by SOQL, Stack Trace, Access Checker and future features. */
  async resolveField(persona: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence | undefined> {
    if (!isFieldLevelSecurityApplicable(object) || !this.verifier) return undefined;
    return this.cached(this.fieldChecks, this.cacheKey(persona, object, field),
      () => this.limited(() => this.verifier!.verifyFieldRead(persona, object, field)));
  }

  /**
   * Always check FLS independently of object Read. Call after object Read was
   * established; callers supply true for repository FLS, schema-required or
   * proven non-permissionable fields. Do not infer a grant from a missing org row.
   */
  async resolveFieldRead(persona: Persona, object: string, field: string, repositoryRead: boolean): Promise<FieldReadDecision> {
    if (!isFieldLevelSecurityApplicable(object)) return {
      source: "REPOSITORY", readable: true, field, message: PLATFORM_EVENT_FLS_REASON,
    };
    // Current-org EntityParticle is authoritative for FLS applicability.
    // Callers have already checked object Read independently.
    const metadata = await this.fieldMetadata?.getField(object, field);
    if (metadata?.permissionable === false) return {
      source: metadata.source === "LIVE" ? "ORG_VERIFIED" : "REPOSITORY",
      readable: true, field,
      message: `${object}.${field} is non-permissionable (${metadata.source.toLowerCase()} field metadata); no individual FLS Read grant is needed.`,
    };
    if (repositoryRead) return {
      source: "REPOSITORY", readable: true, field,
      message: "Field Read permission established from repository metadata.",
    };
    const evidence = await this.resolveField(persona, object, field);
    const source: ReadDecisionSource = !evidence ? "UNVERIFIED"
      : evidence.outcome === "VERIFIED" ? "ORG_VERIFIED"
      : evidence.outcome === "DENIED" ? "ORG_DENIED" : "UNVERIFIED";
    return {
      field, source, readable: source === "ORG_VERIFIED",
      message: evidence?.message ?? "Repository field Read is not established and Salesforce verification is unavailable.",
      ...(evidence ? { checkedUsers: evidence.checkedUsers, orgEvidence: evidence } : {}),
    };
  }
}
