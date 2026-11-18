import { SalesforceCliAuthProvider, SalesforceCliLoginCancelledError, type CliOrg, type CliWebLogin } from "./SalesforceCliAuthProvider.js";
import { timedAuthStep } from "./SalesforceAuthTiming.js";
/**
 * Local Salesforce CLI browser authorization: no Analyzer-owned client secret
 * or integration Run As identity. Tokens stay in backend process memory.
 */
export type SalesforceQueryApi = "data" | "tooling";

export type SalesforceConnectionStatus = {
  configured: boolean;
  connecting: boolean;
  connected: boolean;
  authMode: "salesforce_cli";
  environment: "sandbox" | "production" | "custom";
  loginHost: string;
  organizationId?: string;
  userId?: string;
  instanceUrl?: string;
  connectedAt?: string;
  alias?: string;
  username?: string;
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

// Do not reflect arbitrary Salesforce responses into public error messages.
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
  private selectedOrg: CliOrg | null = null;
  private epoch = 0;
  private pendingBrowserLogin: { controller: AbortController; work: Promise<void> } | null = null;
  constructor(private readonly cli = new SalesforceCliAuthProvider()) {}
  private readonly describeCache = new Map<string, { expires: number; value: SalesforceSObjectDescribe }>();
  private readonly pendingDescribes = new Map<string, Promise<SalesforceSObjectDescribe>>();

  get status(): SalesforceConnectionStatus {
    const selected = this.selectedOrg;
    return {
      configured: Boolean(selected),
      connecting: Boolean(this.connecting),
      connected: Boolean(this.connection),
      authMode: "salesforce_cli",
      environment: selected?.environment ?? "sandbox",
      loginHost: selected?.environment === "production" ? "login.salesforce.com" : "test.salesforce.com",
      ...(selected?.alias ? { alias: selected.alias } : {}),
      ...(selected ? { username: selected.username } : {}),
      ...(this.connection ? {
        organizationId: this.connection.organizationId,
        userId: this.connection.userId,
        instanceUrl: this.connection.instanceUrl,
        connectedAt: this.connection.connectedAt,
      } : {}),
      ...(!selected ? { message: "Select a Salesforce CLI org or sign in with your browser." } :
        this.lastError ? { message: this.lastError } : {}),
    };
  }

  async listAuthorizedOrgs(refresh = false): Promise<{
    cliVersion: string;
    orgs: CliOrg[];
    warning?: string;
  }> {
    let cliVersion: string;
    try {
      cliVersion = await this.cli.version();
    } catch (error) {
      // A slow CLI version check is not proof that Salesforce is unavailable
      // or that a saved session is invalid. Keep browser login available;
      // its own version and token checks still enforce minimum CLI support.
      if (error instanceof Error && /timed out/i.test(error.message)) {
        return {
          cliVersion: "",
          orgs: [],
          warning: "Salesforce CLI is taking longer than expected to respond. You can try Sandbox/Production login or Refresh orgs to retry.",
        };
      }
      // A genuinely missing or outdated CLI still reports an actionable error.
      throw error;
    }
    try {
      return { cliVersion, orgs: await this.cli.listOrgs(refresh) };
    } catch {
      // A local org-discovery failure isn't an authentication failure.
      // Don't trap the user with an empty list AND disabled browser buttons.
      return {
        cliVersion,
        orgs: [],
        warning: "Saved CLI orgs could not be loaded. Retry Refresh orgs, or sign in to Sandbox/Production below.",
      };
    }
  }

  /**
   * Cancel the pending CLI browser authorization without logging out a saved
   * Salesforce org. The abort signal terminates the CLI OAuth listener on
   * Windows as well as releasing any waiting API request.
   */
  async cancelLoginWeb(): Promise<boolean> {
    const pending = this.pendingBrowserLogin;
    if (!pending) return false;
    this.pendingBrowserLogin = null;
    // Also invalidate a connection attempt that was activated just before
    // cancellation, preventing a stale login from becoming the active org.
    this.epoch++;
    pending.controller.abort();
    // Wait until the CLI process tree has actually terminated. A replacement
    // OAuth login must not reuse the same callback port while it is occupied.
    await pending.work.catch(() => undefined);
    return true;
  }

  async loginWeb(environment: "sandbox" | "production"): Promise<void> {
    await this.cancelLoginWeb();
    const controller = new AbortController();
    const work = timedAuthStep("auth.totalLogin", async () => {
      const browserOrg = await timedAuthStep("auth.browserLogin",
        () => this.cli.loginWeb(environment, controller.signal));
      if (controller.signal.aborted) throw new SalesforceCliLoginCancelledError();
      // No saved-org enumeration after browser login; the selected token
      // and Salesforce user identity are still verified by activateOrg().
      await timedAuthStep("auth.activateOrg",
        () => this.activateOrg({ ...browserOrg, environment, status: "saved" }, controller.signal, browserOrg));
      if (controller.signal.aborted) throw new SalesforceCliLoginCancelledError();
    }).catch(error => {
      if (controller.signal.aborted || error instanceof SalesforceCliLoginCancelledError) {
        throw new SalesforceConnectionError("Salesforce browser login was cancelled.", 409);
      }
      throw error;
    }).finally(() => {
      if (this.pendingBrowserLogin?.controller === controller) this.pendingBrowserLogin = null;
    });
    this.pendingBrowserLogin = { controller, work };
    return work;
  }

  async selectOrg(target: string): Promise<void> {
    await this.cancelLoginWeb();
    return timedAuthStep("auth.selectOrg", async () => {
      // Switching to the already-active org is a no-op. Its token and
      // Salesforce identity were verified during connect(), and later API
      // calls still enforce session expiry. Don't spawn another 14s CLI pair.
      const current = this.selectedOrg;
      if (this.connection && current && (
        current.username.toLowerCase() === target.toLowerCase() ||
        current.alias?.toLowerCase() === target.toLowerCase()
      )) return;
      // The UI already listed this org. Avoid another expensive CLI process
      // before the secure token and Salesforce identity verification.
      const cached = this.cli.findListedOrg(target);
      const orgs = cached ? [cached] : await this.cli.listOrgs();
      const selected = orgs.find(org =>
        org.username.toLowerCase() === target.toLowerCase() ||
        org.alias?.toLowerCase() === target.toLowerCase());
      if (!selected) throw new SalesforceConnectionError(
        "The selected Salesforce org is not authorized in CLI. Sign in through the browser.", 400);
      await this.activateOrg(selected);
    });
  }

  private async activateOrg(selected: CliOrg, signal?: AbortSignal, completedWebLogin?: CliWebLogin): Promise<void> {
    if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
    const previousOrg = this.selectedOrg;
    const previousConnection = this.connection;
    const previousError = this.lastError;
    const previousAttempt = this.lastAttemptAt;
    const transition = ++this.epoch;
    this.selectedOrg = selected;
    this.connection = null;
    this.lastError = null;
    this.lastAttemptAt = 0;
    this.describeCache.clear();
    this.pendingDescribes.clear();
    try {
      await this.connect(true, completedWebLogin);
      if (signal?.aborted) throw new SalesforceCliLoginCancelledError();
    } catch (error) {
      // Restore the previously verified org only if the old operation still
      // owns the selection. A newer org switch must always win.
      const ownsSelection = this.epoch === transition ||
        (signal?.aborted === true && this.epoch === transition + 1);
      if (ownsSelection && previousOrg && previousConnection) {
        this.epoch++;
        this.selectedOrg = previousOrg;
        this.connection = previousConnection;
        this.lastError = previousError;
        this.lastAttemptAt = previousAttempt;
        this.describeCache.clear();
        this.pendingDescribes.clear();
      } else if (ownsSelection && signal?.aborted === true) {
        this.epoch++;
        this.selectedOrg = previousOrg;
        this.connection = previousConnection;
        this.lastError = previousError;
        this.lastAttemptAt = previousAttempt;
        this.describeCache.clear();
        this.pendingDescribes.clear();
      }
      throw error;
    }
  }

  disconnect(): void {
    void this.cancelLoginWeb();
    // Never run sf org logout: VS Code and other tools share the CLI session.
    this.epoch++;
    this.selectedOrg = null;
    this.connection = null;
    this.lastError = null;
    this.lastAttemptAt = 0;
    this.describeCache.clear();
    this.pendingDescribes.clear();
  }

  /** Same public connection contract; CLI now manages refresh and SSO/MFA. */
  async connect(force = false, completedWebLogin?: CliWebLogin): Promise<void> {
    if (!this.selectedOrg) throw new SalesforceConnectionError(
      "Select an authorized Salesforce org in the Analyzer first.", 409);
    if (this.connecting) {
      try { await this.connecting; } catch { /* Connection may have been superseded. */ }
      if (this.connection && !force) return;
    }
    if (this.connection && !force) return;
    if (!force && this.lastError && Date.now() - this.lastAttemptAt < RECONNECT_COOLDOWN_MS) {
      throw new SalesforceConnectionError(this.lastError, 503);
    }
    const epoch = this.epoch;
    const selected = this.selectedOrg;
    this.lastAttemptAt = Date.now();
    this.lastError = null;
    const work = (async () => {
      try {
        const session = await timedAuthStep("auth.session", () => this.cli.showToken(selected.username, completedWebLogin));
        const instanceUrl = validateSalesforceUrl(session.instanceUrl, "Salesforce instance URL").origin;
        let organizationId = /^00D[A-Za-z0-9]{12,15}$/.test(session.orgId ?? "") ? session.orgId : selected.orgId;
        let userId: string | undefined;
        // Retain user-ID diagnostic support; a failed optional identity lookup
        // cannot promote or bypass any actual object/FLS permission check.
        try {
          await timedAuthStep("auth.userInfo", async () => {
            const response = await fetch(new URL("/services/oauth2/userinfo", instanceUrl), {
              headers: { Authorization: "Bearer " + session.accessToken, Accept: "application/json" },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (response.status === 401) {
              throw new SalesforceConnectionError("Salesforce CLI session expired. Sign in through the Salesforce browser again.", 401);
            }
            if (response.ok) {
              const identity = await response.json() as Record<string, unknown>;
              if (typeof identity.organization_id === "string" && /^00D[A-Za-z0-9]{12,15}$/.test(identity.organization_id)) {
                if (organizationId && identity.organization_id.slice(0, 15) !== organizationId.slice(0, 15)) {
                  throw new SalesforceConnectionError("Salesforce CLI returned a session from a different org. Reauthenticate the selected org.", 409);
                }
                organizationId = identity.organization_id;
              }
              if (typeof identity.user_id === "string" && /^005[A-Za-z0-9]{12,15}$/.test(identity.user_id)) {
                userId = identity.user_id;
              }
            }
          });
        } catch (cause) {
          // UserInfo may be unavailable for some org policies, but explicit
          // invalid-session and org-identity mismatches must never be ignored.
          if (cause instanceof SalesforceConnectionError) throw cause;
        }
        if (epoch !== this.epoch) throw new SalesforceConnectionError(
          "Salesforce org changed during authentication. Retry.", 409);
        this.connection = {
          accessToken: session.accessToken,
          instanceUrl,
          organizationId,
          userId,
          connectedAt: new Date().toISOString(),
        };
        this.describeCache.clear();
      } catch (error) {
        if (epoch === this.epoch) {
          this.connection = null;
          this.lastError = error instanceof Error ? error.message : "Salesforce CLI login failed.";
        }
        throw error;
      }
    })();
    this.connecting = work;
    try { await work; }
    finally { if (this.connecting === work) this.connecting = null; }
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
    const originEpoch = this.epoch;
    let response = await this.sendQuery(trimmed, api);
    let payload: unknown = await response.json().catch(() => null);
    const errors = Array.isArray(payload) ? payload : [payload];
    const sessionExpired = response.status === 401 || (response.status === 403 && errors.some((error) =>
      error && typeof error === "object" && (error as Record<string, unknown>).errorCode === "INVALID_SESSION_ID"));
    if (sessionExpired) {
      // CLI owns refresh tokens; request a renewed CLI access session.
      await this.connect(true);
      response = await this.sendQuery(trimmed, api);
      payload = await response.json().catch(() => null);
    }
    if (this.epoch !== originEpoch) {
      throw new SalesforceConnectionError("Salesforce org changed during this query. Retry analysis.", 409);
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
    const originEpoch = this.epoch;
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
      if (this.epoch !== originEpoch) throw new SalesforceConnectionError(
        "Salesforce org changed during this analysis. Rerun against the selected org.", 409);
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
      if (this.epoch !== originEpoch) throw new SalesforceConnectionError(
        "Salesforce org changed during this analysis. Rerun against the selected org.", 409);
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
   * Salesforce CLI session. No token or Describe response is sent to the UI.
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
      const originEpoch = this.epoch;
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
      if (this.epoch !== originEpoch) throw new SalesforceConnectionError(
        "Salesforce org changed during Describe. Rerun analysis.", 409);
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
