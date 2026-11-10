import type { Persona } from "../models/Persona.js";
import type { OrgVerificationStatusPolicy } from "../config/orgVerificationStatusPolicy.js";
import { isStatusNeutralOrgObjectRead } from "../config/orgVerificationStatusPolicy.js";
import type { SalesforcePersonaAccessVerifier, OrgObjectAccessEvidence } from "../salesforce/SalesforcePersonaAccessVerifier.js";

/**
 * Reusable, repository-first read decision for Salesforce-managed objects.
 * A policy entry never grants access. The org must confirm it for the persona.
 * Use the same service in SOQL analysis, Access Checker, Matrix and future flows.
 */
export type ObjectReadDecisionSource = "REPOSITORY" | "ORG_VERIFIED" | "ORG_DENIED" | "UNVERIFIED";
export interface ObjectReadDecision {
  source: ObjectReadDecisionSource;
  readable: boolean;
  /** Verified org access does not escalate green -> orange for configured object Read. */
  statusNeutral: boolean;
  message: string;
  checkedUsers?: number;
}

export class OrgObjectReadVerificationService {
  private readonly objectChecks = new Map<string, { until: number; value: Promise<ObjectReadDecision> }>();
  private readonly fieldChecks = new Map<string, { until: number; value: Promise<OrgObjectAccessEvidence | undefined> }>();
  // Do not retain historical org decisions for the entire life of the server.
  private readonly cacheMs = 60_000;

  constructor(
    private readonly policy: OrgVerificationStatusPolicy,
    private readonly verifier?: SalesforcePersonaAccessVerifier,
  ) {}

  /** Only configured managed objects get the special missing-XML treatment. */
  isConfigured(object: string): boolean {
    return isStatusNeutralOrgObjectRead(this.policy, object);
  }

  async resolve(persona: Persona, object: string, repositoryRead: boolean): Promise<ObjectReadDecision> {
    if (repositoryRead) return {
      source: "REPOSITORY", readable: true, statusNeutral: false,
      message: "Read access established from repository metadata.",
    };
    const key = `${persona.name.toLowerCase()}|${object.toLowerCase()}`;
    const entry = this.objectChecks.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    const pending = this.lookupObject(persona, object);
    this.objectChecks.set(key, { until: Date.now() + this.cacheMs, value: pending });
    return pending;
  }

  private async lookupObject(persona: Persona, object: string): Promise<ObjectReadDecision> {
    if (!this.verifier) return {
      source: "UNVERIFIED", readable: false, statusNeutral: false,
      message: `Repository Read is not established for ${object}; live Salesforce verification is unavailable.`,
    };
    const evidence = await this.verifier.verifyObjectRead(persona, object);
    if (evidence.outcome === "VERIFIED") return {
      source: "ORG_VERIFIED", readable: true,
      statusNeutral: this.isConfigured(object), message: evidence.message,
      checkedUsers: evidence.checkedUsers,
    };
    return {
      source: evidence.outcome === "DENIED" ? "ORG_DENIED" : "UNVERIFIED",
      readable: false, statusNeutral: false, message: evidence.message,
      checkedUsers: evidence.checkedUsers,
    };
  }

  /** Independent FLS verification: object Read must never imply field Read. */
  async resolveField(persona: Persona, object: string, field: string): Promise<OrgObjectAccessEvidence | undefined> {
    if (!this.verifier) return undefined;
    const key = `${persona.name.toLowerCase()}|${object.toLowerCase()}|${field.toLowerCase()}`;
    const entry = this.fieldChecks.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    const pending = this.verifier.verifyFieldRead(persona, object, field);
    this.fieldChecks.set(key, { until: Date.now() + this.cacheMs, value: pending });
    return pending;
  }
}
