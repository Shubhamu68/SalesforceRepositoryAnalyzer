import { useEffect, useState } from "react";
import "./SalesforceOrgConnection.css";
import SalesforceCliLogin from "./SalesforceCliLogin";

type ConnectionStatus = {
  configured: boolean;
  connecting: boolean;
  connected: boolean;
  authMode: "salesforce_cli";
  alias?: string;
  username?: string;
  environment: "sandbox" | "production" | "custom";
  loginHost: string;
  organizationId?: string;
  userId?: string;
  instanceUrl?: string;
  connectedAt?: string;
  message?: string;
};

type QueryApi = "data" | "tooling";
type QueryResult = {
  api: QueryApi;
  totalSize: number;
  displayedCount: number;
  done: boolean;
  truncated: boolean;
  records: unknown[];
};

const DATA_SAMPLE = "SELECT Id, Name, OrganizationType FROM Organization LIMIT 1";
const TOOLING_SAMPLE = "SELECT Id, Name FROM ApexClass LIMIT 5";
function orderItemSummaryAccessQuery(userId: string): string {
  return `SELECT UserId, EntityDefinition.QualifiedApiName, IsReadable, IsCreatable, IsEditable, IsDeletable FROM UserEntityAccess WHERE UserId = '${userId}' AND EntityDefinition.QualifiedApiName = 'OrderItemSummary'`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return result && typeof result === "object" ? result as Record<string, unknown> : {};
}

export default function SalesforceOrgConnection() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [api, setApi] = useState<QueryApi>("data");
  const [soql, setSoql] = useState(DATA_SAMPLE);
  const [result, setResult] = useState<QueryResult | null>(null);

  async function refreshStatus() {
    const response = await fetch("/api/salesforce/status", { cache: "no-store" });
    const data = await readJson(response);
    setStatus(data as unknown as ConnectionStatus);
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/salesforce/status", { cache: "no-store" });
        const data = await readJson(response);
        if (active) setStatus(data as unknown as ConnectionStatus);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load Salesforce connection status.");
      }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  async function reconnect() {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/salesforce/reconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await readJson(response);
      setStatus(data as unknown as ConnectionStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salesforce authentication failed.");
      await refreshStatus().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError("");
    setBusy(true);
    try {
      await readJson(await fetch("/api/salesforce/disconnect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      setResult(null);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect local session.");
    } finally { setBusy(false); }
  }

  async function runQuery(query: string, queryApi: QueryApi) {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/salesforce/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soql: query, api: queryApi })
      });
      const data = await readJson(response);
      setResult(data as unknown as QueryResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "SOQL execution failed.");
      await refreshStatus().catch(() => undefined);
    } finally {
      setRunning(false);
    }
  }

  const connectionLabel = !status ? "Checking…" : status.connected ? "Connected" :
    status.connecting ? "Connecting…" : status.configured ? "Connection unavailable" : "Not configured";

  return (
    <div className="sf-page">
      <SalesforceCliLogin compact onComplete={() => { setResult(null); void refreshStatus(); }} />
      <section className="panel sf-connection-panel">
        <div className="panel-heading">
          <div>
            <h2>Connection</h2>
            <p>Uses your individual Salesforce CLI browser authorization, with no shared secret.</p>
          </div>
          <span role="status" className={`sf-connection-pill ${status?.connected ? "sf-connection-on" : status?.connecting ? "sf-connection-pending" : "sf-connection-off"}`}>
            {connectionLabel}
          </span>
        </div>
        <div className="sf-connection-content">
          <details className="sf-detail-disclosure"><summary>Connection details</summary>
          <div className="sf-connection-details">
            <div><span>Environment</span><strong>{status?.environment || "—"}</strong></div>
            <div><span>Authentication</span><strong>Salesforce CLI browser login</strong></div>
            <div><span>CLI alias</span><strong>{status?.alias || "—"}</strong></div>
            <div><span>Login domain</span><strong>{status?.loginHost || "—"}</strong></div>
            <div><span>Salesforce org ID</span><strong>{status?.organizationId || "—"}</strong></div>
            <div><span>Username</span><strong>{status?.username || "—"}</strong></div>
            <div><span>Authenticated user ID</span><strong>{status?.userId || "—"}</strong></div>
            <div><span>Instance</span><strong>{status?.instanceUrl || "—"}</strong></div>
          </div></details>
          {status?.message && <p className="sf-warning" role="status">{status.message}</p>}
          <div className="sf-actions">
            <button className="secondary-button" type="button" disabled={busy || !status?.configured} onClick={() => void reconnect()}>
              {busy ? "Reconnecting…" : "Refresh CLI session"}
            </button>
            <button className="secondary-button" type="button" disabled={busy || !status?.configured} onClick={() => void disconnect()}>
              Disconnect Analyzer
            </button>
          </div>
        </div>
      </section>

      <section className="panel sf-connection-panel">
        <div className="panel-heading">
          <div>
            <h2>Test Salesforce query</h2>
            <p>Run read-only SOQL through REST or Tooling API.</p>
          </div>
          
        </div>
        <div className="sf-connection-content">
          <div className="sf-preset-actions">
            <button type="button" className="secondary-button" disabled={!status?.connected || running} onClick={() => { setApi("data"); setSoql(DATA_SAMPLE); void runQuery(DATA_SAMPLE, "data"); }}>Test standard SOQL</button>
            <button type="button" className="secondary-button" disabled={!status?.connected || running} onClick={() => { setApi("tooling"); setSoql(TOOLING_SAMPLE); void runQuery(TOOLING_SAMPLE, "tooling"); }}>Test Tooling API SOQL</button>
            <button type="button" className="secondary-button" disabled={!status?.connected || !status.userId || running} onClick={() => { if (!status?.userId) return; const query = orderItemSummaryAccessQuery(status.userId); setApi("tooling"); setSoql(query); void runQuery(query, "tooling"); }}>Test OrderItemSummary access</button>
          </div>
          <div className="sf-query-controls">
            <label htmlFor="sf-query-api">API</label>
            <select id="sf-query-api" value={api} onChange={(event) => setApi(event.target.value as QueryApi)} disabled={running}>
              <option value="data">Standard REST</option>
              <option value="tooling">Tooling API</option>
            </select>
          </div>
          <label htmlFor="sf-soql" className="sf-field-label">SOQL query</label>
          <textarea id="sf-soql" rows={5} spellCheck={false} value={soql} disabled={running} onChange={(event) => setSoql(event.target.value)} placeholder="SELECT Id, Name FROM Account LIMIT 5" />
          <div className="sf-actions">
            <span className="sf-description">SELECT only · first 50 records shown</span>
            <button type="button" className="primary-button" disabled={!status?.connected || running || !soql.trim()} onClick={() => void runQuery(soql, api)}>{running ? "Running query…" : "Run SOQL"}</button>
          </div>
          {result && (
            <div className="sf-result" aria-live="polite">
              <div className="sf-result-header"><strong>Query successful</strong><span>{result.totalSize} matched · {result.displayedCount} shown · {result.api === "tooling" ? "Tooling API" : "Standard REST"}</span></div>
              {result.truncated && <p className="sf-warning">Additional records exist; showing {result.displayedCount}.</p>}
              <pre>{JSON.stringify(result.records, null, 2)}</pre>
            </div>
          )}
        </div>
      </section>
      {error && <div className="sf-feedback sf-error" role="alert">{error}</div>}
    </div>
  );
}
