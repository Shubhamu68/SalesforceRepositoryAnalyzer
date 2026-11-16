/**
 * Local, server-side Salesforce connection using OAuth client credentials.
 * A single Run As user is configured on the Salesforce External Client App.
 * Tokens are held only in process memory; no browser OAuth flow is involved.
 */
export type SalesforceQueryApi = "data" | "tooling";

export type SalesforceConnectionStatus = {
  configured: boolean;
  connecting: boolean;
  connected: boolean;
  authMode: "client_credentials";
  environment: "sandbox" | "production" | "custom";
  loginHost: string;
  organizationId?: string;
  userId?: string;
  instanceUrl?: string;
  connectedAt?: string;
  message?: string;
};

type SalesforceOAuthToken = {
  access_token?: string;
  instance_url?: string;
  id?: string;
  token_type?: string;
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

// Do not reflect arbitrary Salesforce responses into public error messages.
function oauthErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Salesforce returned an unexpected OAuth response.";
  const data = value as Record<string, unknown>;
  const error = typeof data.error === "string" ? data.error : "oauth_error";
  const detail = typeof data.error_description === "string" ? data.error_description : "";
  return `${error}${detail ? `: ${detail}` : ""}`.slice(0, 300);
}

function apiErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Salesforce returned an unexpected error.";
  const data = value as Record<string, unknown>;
  const code = typeof data.errorCode === "string" ? data.errorCode : "api_error";
  const detail = typeof data.message === "string" ? data.message : "";
  return `${code}${detail ? `: ${detail}` : ""}`.slice(0, 300);
}

function extractIdentity(identityUrl?: string): { organizationId?: string; userId?: string } {
  if (!identityUrl) return {};
  let identity: URL;
  try {
    identity = new URL(identityUrl);
  } catch {
    return {};
  }
  // Identity URL may be on login.salesforce.com or the org My Domain.
  if (identity.protocol !== "https:" || !isSalesforceHostname(identity.hostname)) return {};
  const match = identity.pathname.match(/^\/id\/(00D[A-Za-z0-9]{12,15})\/(005[A-Za-z0-9]{12,15})\/?$/);
  return match ? { organizationId: match[1], userId: match[2] } : {};
}

/** This connector is intentionally accessible only from the local backend. */
export class SalesforceOrgConnection {
  private connection: SalesforceOAuthConnection | null = null;
  private connecting: Promise<void> | null = null;
  private lastAttemptAt = 0;
  private lastError: string | null = null;
  private readonly describeCache = new Map<string, { expires: number; value: SalesforceSObjectDescribe }>();
  private readonly pendingDescribes = new Map<string, Promise<SalesforceSObjectDescribe>>();

  private get loginUrl(): URL {
    return validateSalesforceUrl(
      process.env.SALESFORCE_LOGIN_URL || "https://test.salesforce.com",
      "SALESFORCE_LOGIN_URL"
    );
  }

  private get clientId(): string {
    const value = process.env.SALESFORCE_CLIENT_ID?.trim();
    if (!value) throw new SalesforceConnectionError("SALESFORCE_CLIENT_ID is missing in the backend .env file.", 400);
    return value;
  }

  private get clientSecret(): string {
    const value = process.env.SALESFORCE_CLIENT_SECRET?.trim();
    if (!value) throw new SalesforceConnectionError("SALESFORCE_CLIENT_SECRET is missing in the backend .env file.", 400);
    return value;
  }

  get status(): SalesforceConnectionStatus {
    const loginUrl = this.loginUrl;
    const configured = Boolean(process.env.SALESFORCE_CLIENT_ID?.trim() && process.env.SALESFORCE_CLIENT_SECRET?.trim());
    const environment = loginUrl.hostname === "test.salesforce.com" || loginUrl.hostname.includes(".sandbox.")
      ? "sandbox" : loginUrl.hostname === "login.salesforce.com" ? "production" : "custom";
    return {
      configured,
      connecting: Boolean(this.connecting),
      connected: Boolean(this.connection),
      authMode: "client_credentials",
      environment,
      loginHost: loginUrl.hostname,
      ...(this.connection ? {
        organizationId: this.connection.organizationId,
        userId: this.connection.userId,
        instanceUrl: this.connection.instanceUrl,
        connectedAt: this.connection.connectedAt
      } : {}),
      ...(!configured ? { message: "Add SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET to the backend .env file." }
        : this.lastError ? { message: this.lastError } : {})
    };
  }

  /**
   * Safe to call from backend startup, the status route, and a query.
   * Concurrent calls share one token request. Failed attempts are throttled,
   * but a manual reconnect can bypass the cooldown.
   */
  async connect(force = false): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.connection && !force) return;
    if (!force && this.lastError && Date.now() - this.lastAttemptAt < RECONNECT_COOLDOWN_MS) {
      throw new SalesforceConnectionError(this.lastError, 503);
    }
    this.lastAttemptAt = Date.now();
    this.lastError = null;
    this.connecting = this.acquireToken().then((connection) => {
      this.connection = connection;
      this.lastError = null;
    }).catch((err: unknown) => {
      this.connection = null;
      this.lastError = err instanceof Error ? err.message : "Salesforce authentication failed.";
      throw err;
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async acquireToken(): Promise<SalesforceOAuthConnection> {
    const endpoint = new URL("/services/oauth2/token", this.loginUrl);
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new SalesforceConnectionError("Unable to reach the Salesforce OAuth endpoint. Check VPN/network and login URL.", 502);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SalesforceConnectionError(`Salesforce authentication failed: ${oauthErrorMessage(payload)}`, 502);
    }
    const token = payload as SalesforceOAuthToken | null;
    if (!token?.access_token || !token.instance_url ||
        (token.token_type && token.token_type.toLowerCase() !== "bearer")) {
      throw new SalesforceConnectionError("Salesforce OAuth response was missing a bearer token or instance URL.", 502);
    }
    // Never send bearer tokens to an untrusted host received in a response.
    const instanceUrl = validateSalesforceUrl(token.instance_url, "Salesforce instance URL").origin;
    return {
      accessToken: token.access_token,
      instanceUrl,
      ...extractIdentity(token.id),
      connectedAt: new Date().toISOString()
    };
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
    let response = await this.sendQuery(trimmed, api);
    let payload: unknown = await response.json().catch(() => null);
    const errors = Array.isArray(payload) ? payload : [payload];
    const sessionExpired = response.status === 401 || (response.status === 403 && errors.some((error) =>
      error && typeof error === "object" && (error as Record<string, unknown>).errorCode === "INVALID_SESSION_ID"));
    if (sessionExpired) {
      // Client Credentials has no refresh token; issue a fresh credentials grant.
      await this.connect(true);
      response = await this.sendQuery(trimmed, api);
      payload = await response.json().catch(() => null);
    }
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
   * Read relationship metadata in the current org, using the existing
   * Client Credentials session. No token or Describe response is sent to the UI.
   * Describe results are cached briefly; failures are not cached.
   */
  async describeSObject(objectName: string): Promise<SalesforceSObjectDescribe> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(objectName)) {
      throw new SalesforceConnectionError("Invalid Salesforce object API name.", 400);
    }
    const key = objectName.toLowerCase();
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
