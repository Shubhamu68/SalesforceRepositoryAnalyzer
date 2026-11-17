/**
 * Single, local Salesforce session selected from Salesforce CLI authorizations.
 * The browser never receives access or refresh tokens. All analyzer features
 * share this connection and retain their existing REST/Tooling/Describe calls.
 */
import { SalesforceCliAuth, SalesforceCliError, type CliOrg } from "./SalesforceCliAuth.js";

export type SalesforceQueryApi = "data" | "tooling";

export type SalesforceConnectionStatus = {
  configured: boolean;
  connecting: boolean;
  connected: boolean;
  authMode: "salesforce_cli";
  environment: "sandbox" | "production" | "custom";
  loginHost: string;
  username?: string;
  alias?: string;
  organizationId?: string;
  userId?: string;
  instanceUrl?: string;
  connectedAt?: string;
  message?: string;
};

type SalesforceOAuthConnection = {
  accessToken: string;
  instanceUrl: string;
  organizationId?: string;
  userId?: string;
  connectedAt: string;
};

/** Minimal Salesforce REST sObject Describe shape used for relationship resolution. */
export type SalesforceSObjectDescribe = {
  name: string;
  fields: Array<{
    name: string;
    /** Compound parent as supplied by Salesforce REST Describe, when present. */
    compoundFieldName?: string | null;
    /** Salesforce field type, e.g. address or location. */
    type?: string;
    relationshipName?: string | null;
    referenceTo?: string[];
    namePointing?: boolean;
    polymorphicForeignKey?: boolean;
  }>;
  childRelationships: Array<{
    relationshipName?: string | null;
    childSObject: string;
    field?: string;
  }>;
};

type QueryResult = {
  totalSize: number;
  done: boolean;
  records: unknown[];
  nextRecordsUrl?: string;
};

const REQUEST_TIMEOUT_MS = 20000;
const RECONNECT_COOLDOWN_MS = 15000;
const MAX_QUERY_LENGTH = 10000;
const MAX_RESULTS_IN_RESPONSE = 50;
const DEFAULT_API_VERSION = "v62.0";

function isSalesforceHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["salesforce.com", "force.com", "salesforce.mil"]
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function validateSalesforceUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SalesforceConnectionError(`${label} must be a valid Salesforce HTTPS URL.`, 400);
  }
  if (url.protocol !== "https:" || !isSalesforceHostname(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== "/") {
    throw new SalesforceConnectionError(`${label} must use an approved Salesforce HTTPS origin.`, 400);
  }
  return url;
}

function getApiVersion(): string {
  const version = process.env.SALESFORCE_API_VERSION?.trim() || DEFAULT_API_VERSION;
  if (!/^v\d{2,3}\.\d$/.test(version)) {
    throw new SalesforceConnectionError("SALESFORCE_API_VERSION must look like v62.0.", 400);
  }
  return version;
}

function apiErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Salesforce returned an unexpected error.";
  const data = value as Record<string, unknown>;
  const code = typeof data.errorCode === "string" ? data.errorCode : "api_error";
  const detail = typeof data.message === "string" ? data.message : "";
  return `${code}${detail ? `: ${detail}` : ""}`.slice(0, 300);
}

/** This connector is intentionally accessible only from the local backend. */
export class SalesforceOrgConnection {
  private connection: SalesforceOAuthConnection | null = null;
  private connecting: Promise<void> | null = null;
  private lastAttemptAt = 0;
  private lastError: string | null = null;
  private sessionGeneration = 0;
  private readonly describeCache = new Map<string, { expires: number; value: SalesforceSObjectDescribe }>();
  private readonly pendingDescribes = new Map<string, Promise<SalesforceSObjectDescribe>>();

  private selectedOrg: CliOrg | null = null;
  private readonly cli: SalesforceCliAuth;

  constructor(cli: SalesforceCliAuth = new SalesforceCliAuth()) {
    this.cli = cli;
  }

  /** Stable scope for org-specific runtime and permission caches. */
  get cacheScope(): string {
    return this.selectedOrg
      ? (this.selectedOrg.orgId || this.selectedOrg.username) + "|" + this.selectedOrg.username
      : "disconnected";
  }

  get status(): SalesforceConnectionStatus {
    const active = this.selectedOrg;
    const loginHost = this.connection?.instanceUrl
      ? new URL(this.connection.instanceUrl).hostname
      : active?.instanceUrl ? new URL(active.instanceUrl).hostname : "";
    return {
      configured: Boolean(active),
      connecting: Boolean(this.connecting),
      connected: Boolean(active && this.connection),
      authMode: "salesforce_cli",
      environment: active?.environment || "custom",
      loginHost,
      ...(active ? { username: active.username, ...(active.alias ? { alias: active.alias } : {}) } : {}),
      ...(this.connection ? {
        organizationId: this.connection.organizationId,
        userId: this.connection.userId,
        instanceUrl: this.connection.instanceUrl,
        connectedAt: this.connection.connectedAt
      } : {}),
      ...(!active ? { message: "Choose an existing CLI org or sign in through Salesforce." }
        : this.lastError ? { message: this.lastError } : {})
    };
  }

  async listOrgs(): Promise<{ orgs: Array<CliOrg & { selected: boolean }> }> {
    const orgs = await this.cli.listOrgs();
    return { orgs: orgs.map(org => ({
      ...org, selected: org.username === this.selectedOrg?.username
    })) };
  }

  async login(environment: "sandbox" | "production"): Promise<SalesforceConnectionStatus> {
    const username = await this.cli.login(environment);
    await this.selectOrg(username);
    return this.status;
  }

  async selectOrg(username: string): Promise<SalesforceConnectionStatus> {
    if (this.connecting) await this.connecting.catch(() => undefined);
    const orgs = await this.cli.listOrgs();
    const target = orgs.find(org => org.username === username);
    if (!target) throw new SalesforceConnectionError("Choose an org listed by Salesforce CLI.", 400);
    if (target.status !== "connected") {
      throw new SalesforceConnectionError("This org's CLI authorization has expired. Reauthorize it with browser login.", 401);
    }
    const previousOrg = this.selectedOrg;
    const previousConnection = this.connection;
    this.selectedOrg = target;
    this.connection = null;
    this.lastError = null;
    try {
      await this.connect(true);
    } catch (error) {
      this.selectedOrg = previousOrg;
      this.connection = previousConnection;
      throw error;
    }
    this.clearMetadataCaches();
    return this.status;
  }

  disconnect(): SalesforceConnectionStatus {
    this.selectedOrg = null;
    this.connection = null;
    this.lastError = null;
    this.clearMetadataCaches();
    // Detaches the Analyzer only; user's Salesforce CLI auth remains intact.
    return this.status;
  }

  private clearMetadataCaches(): void {
    this.sessionGeneration++;
    this.describeCache.clear();
    this.pendingDescribes.clear();
  }

  /**
   * No client credentials grant. Every retry asks Salesforce CLI to supply
   * its currently valid token (refreshing it through CLI when necessary).
   */
  async connect(force = false): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.selectedOrg) {
      throw new SalesforceConnectionError("Select or sign in to a Salesforce org first.", 409);
    }
    if (this.connection && !force) return;
    if (!force && this.lastError && Date.now() - this.lastAttemptAt < RECONNECT_COOLDOWN_MS) {
      throw new SalesforceConnectionError(this.lastError, 503);
    }
    const target = this.selectedOrg.username;
    this.lastAttemptAt = Date.now();
    this.lastError = null;
    this.connecting = this.cli.session(target).then(session => {
      if (this.selectedOrg?.username !== target) {
        throw new SalesforceConnectionError("The selected Salesforce org changed during authentication.", 409);
      }
      const instanceUrl = validateSalesforceUrl(session.instanceUrl, "Salesforce instance URL").origin;
      this.connection = {
        accessToken: session.accessToken,
        instanceUrl,
        ...(session.orgId ? { organizationId: session.orgId } : {}),
        ...(session.userId ? { userId: session.userId } : {}),
        connectedAt: new Date().toISOString()
      };
      this.lastError = null;
    }).catch((error: unknown) => {
      this.connection = null;
      this.lastError = error instanceof SalesforceCliError || error instanceof SalesforceConnectionError
        ? error.message : "Salesforce CLI session could not be established.";
      throw new SalesforceConnectionError(this.lastError, 503);
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async query(soql: string, api: SalesforceQueryApi): Promise<{
    api: SalesforceQueryApi;
    totalSize: number;
    done: boolean;
    displayedCount: number;
    truncated: boolean;
    records: unknown[];
  }> {
    if (api !== "data" && api !== "tooling") {
      throw new SalesforceConnectionError("api must be 'data' or 'tooling'.", 400);
    }
    const trimmed = soql.trim();
    if (!/^SELECT\s/i.test(trimmed) || trimmed.length > MAX_QUERY_LENGTH ||
        trimmed.includes(";") || /\bFOR\s+UPDATE\b/i.test(trimmed)) {
      throw new SalesforceConnectionError("Enter one read-only SELECT SOQL query (maximum 10,000 characters).", 400);
    }
    await this.connect();
    const sessionGeneration = this.sessionGeneration;
    let response = await this.sendQuery(trimmed, api);
    let payload: unknown = await response.json().catch(() => null);
    const errors = Array.isArray(payload) ? payload : [payload];
    const sessionExpired = response.status === 401 || (response.status === 403 && errors.some((error) =>
      error && typeof error === "object" && (error as Record<string, unknown>).errorCode === "INVALID_SESSION_ID"));
    if (sessionExpired) {
      // Ask Salesforce CLI to refresh its existing org authorization.
      await this.connect(true);
      response = await this.sendQuery(trimmed, api);
      payload = await response.json().catch(() => null);
    }
    if (sessionGeneration !== this.sessionGeneration) throw new SalesforceConnectionError("Salesforce org changed during the query. Retry.", 409);
    if (!response.ok) {
      const apiErrors = Array.isArray(payload) ? payload : [payload];
      throw new SalesforceConnectionError(
        apiErrors.map(apiErrorMessage).join(" | ").slice(0, 600),
        response.status === 403 ? 403 : response.status === 401 ? 401 : 400
      );
    }
    const result = payload as QueryResult | null;
    if (!result || !Array.isArray(result.records) || typeof result.totalSize !== "number") {
      throw new SalesforceConnectionError("Salesforce returned an unexpected query result.", 502);
    }
    const records = result.records.slice(0, MAX_RESULTS_IN_RESPONSE);
    return {
      api,
      totalSize: result.totalSize,
      done: result.done,
      displayedCount: records.length,
      truncated: !result.done || result.records.length > records.length,
      records
    };
  }

  /**
   * Internal-only paginated SOQL. Unlike the small UI test-query response,
   * this never silently truncates permission inventory. An excessive result
   * fails closed so incomplete user data cannot produce an access verdict.
   */
  async queryAll<T>(
    soql: string, api: SalesforceQueryApi, limit = 20000,
    minimumVersion?: "v63.0",
  ): Promise<T[]> {
    if (api !== "data" && api !== "tooling") throw new SalesforceConnectionError("Invalid API type.", 400);
    if (!/^SELECT\s/i.test(soql.trim()) || soql.length > MAX_QUERY_LENGTH || soql.includes(";")) {
      throw new SalesforceConnectionError("Only a single read-only SELECT SOQL query is supported.", 400);
    }
    await this.connect();
    const sessionGeneration = this.sessionGeneration;
    const all: T[] = [];
    let nextPath: string | null = null;
    let retried = false;
    // View All Fields permission metadata was introduced in v63.0. The
    // targeted internal query can use that version without changing the org's
    // configured/default API version for all other analyzer operations.
    const requested = getApiVersion();
    const effectiveVersion = minimumVersion && Number(requested.slice(1)) < Number(minimumVersion.slice(1))
      ? minimumVersion : requested;
    const apiBase = `/services/data/${effectiveVersion}/${api === "tooling" ? "tooling/" : ""}query/`;
    for (;;) {
      if (sessionGeneration !== this.sessionGeneration) throw new SalesforceConnectionError("Salesforce org changed during the query. Retry.", 409);
      const conn = this.connection;
      if (!conn) throw new SalesforceConnectionError("Salesforce connection unavailable.", 503);
      const url: URL = new URL(nextPath ?? apiBase, conn.instanceUrl);
      if (!nextPath) url.searchParams.set("q", soql);
      if (url.origin !== conn.instanceUrl || !url.pathname.startsWith(apiBase) ||
          (nextPath && (url.search || url.hash))) {
        throw new SalesforceConnectionError("Salesforce returned an invalid query locator.", 502);
      }
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {
        throw new SalesforceConnectionError("Unable to retrieve Salesforce permission data.", 502);
      }
      const payload: unknown = await response.json().catch(() => null);
      if (sessionGeneration !== this.sessionGeneration) throw new SalesforceConnectionError("Salesforce org changed during the query. Retry.", 409);
      if (response.status === 401 && !retried) {
        retried = true;
        all.length = 0;
        nextPath = null;
        await this.connect(true);
        continue;
      }
      if (!response.ok) {
        const errors = Array.isArray(payload) ? payload : [payload];
        throw new SalesforceConnectionError(errors.map(apiErrorMessage).join(" | ").slice(0, 500), response.status);
      }
      const page = payload as QueryResult | null;
      if (!page || !Array.isArray(page.records) || typeof page.done !== "boolean") {
        throw new SalesforceConnectionError("Invalid Salesforce paginated query response.", 502);
      }
      if (all.length + page.records.length > limit) {
        throw new SalesforceConnectionError(`Salesforce query exceeded ${limit} records; verification is incomplete.`, 503);
      }
      all.push(...page.records as T[]);
      if (page.done) return all;
      if (!page.nextRecordsUrl || !page.nextRecordsUrl.startsWith(apiBase) ||
          page.nextRecordsUrl.includes("?") || page.nextRecordsUrl.includes("#")) {
        throw new SalesforceConnectionError("Salesforce returned an invalid pagination locator.", 502);
      }
      nextPath = page.nextRecordsUrl;
    }
  }

  /**
   * Read relationship metadata in the current org, using the selected
   * Salesforce CLI session. No token or Describe response is sent to the UI.
   * Describe results are cached briefly; failures are not cached.
   */
  async describeSObject(objectName: string): Promise<SalesforceSObjectDescribe> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(objectName)) {
      throw new SalesforceConnectionError("Invalid Salesforce object API name.", 400);
    }
    const sessionGeneration = this.sessionGeneration;
    const key = this.cacheScope + "|" + objectName.toLowerCase();
    const cached = this.describeCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const inflight = this.pendingDescribes.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      await this.connect();
      const request = async (): Promise<Response> => {
        const session = this.connection;
        if (!session) throw new SalesforceConnectionError("Salesforce connection unavailable.", 503);
        const url = new URL(`/services/data/${getApiVersion()}/sobjects/${encodeURIComponent(objectName)}/describe`, session.instanceUrl);
        return fetch(url, {
          headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      };
      let response: Response;
      try {
        response = await request();
        if (response.status === 401) {
          await this.connect(true);
          response = await request();
        }
      } catch (error) {
        if (error instanceof SalesforceConnectionError) throw error;
        throw new SalesforceConnectionError("Unable to retrieve Salesforce relationship metadata.", 502);
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errors = Array.isArray(payload) ? payload : [payload];
        throw new SalesforceConnectionError(errors.map(apiErrorMessage).join(" | ").slice(0, 500), response.status);
      }
      if (sessionGeneration !== this.sessionGeneration) throw new SalesforceConnectionError("Salesforce org changed during Describe. Retry.", 409);
      const data = payload as SalesforceSObjectDescribe | null;
      if (!data || !Array.isArray(data.fields) || !Array.isArray(data.childRelationships)) {
        throw new SalesforceConnectionError("Invalid Salesforce sObject Describe response.", 502);
      }
      this.describeCache.set(key, { expires: Date.now() + 10 * 60 * 1000, value: data });
      return data;
    })();
    this.pendingDescribes.set(key, promise);
    try { return await promise; }
    finally { this.pendingDescribes.delete(key); }
  }

  private async sendQuery(soql: string, api: SalesforceQueryApi): Promise<Response> {
    const connection = this.connection;
    if (!connection) throw new SalesforceConnectionError("No Salesforce connection is available.", 503);
    const url = new URL(
      `/services/data/${getApiVersion()}/${api === "tooling" ? "tooling/" : ""}query/`,
      connection.instanceUrl
    );
    url.searchParams.set("q", soql);
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new SalesforceConnectionError("Unable to query Salesforce. Check network/VPN access.", 502);
    }
  }
}

export class SalesforceConnectionError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
