import { useEffect, useState } from "react";
import "./SalesforceOrgLogin.css";

type Environment = "sandbox" | "production";
type Org = {
  username: string;
  alias?: string;
  orgId?: string;
  instanceUrl?: string;
  environment: Environment;
  status: "connected" | "expired";
  selected: boolean;
};
type ConnectionStatus = {
  connected: boolean;
  username?: string;
  alias?: string;
  environment: Environment | "custom";
};
type Props = {
  firstLaunch?: boolean;
  onConnected?: () => void;
  onChanged?: () => void;
  onContinueRepositoryOnly?: () => void;
};

async function request<T>(url: string, method: "GET" | "POST" = "GET", body?: object): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new Error(typeof item.error === "string" ? item.error : "Salesforce CLI request failed.");
  }
  return payload as T;
}

export default function SalesforceOrgLogin({
  firstLaunch = false, onConnected, onChanged, onContinueRepositoryOnly,
}: Props) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const [listing, current] = await Promise.all([
      request<{ orgs: Org[] }>("/api/salesforce/orgs"),
      request<ConnectionStatus>("/api/salesforce/status"),
    ]);
    setOrgs(listing.orgs);
    setStatus(current);
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      request<{ orgs: Org[] }>("/api/salesforce/orgs"),
      request<ConnectionStatus>("/api/salesforce/status"),
    ]).then(([listing, current]) => {
      if (active) { setOrgs(listing.orgs); setStatus(current); }
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "Cannot reach Salesforce CLI.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function perform(action: string, url: string, body?: object) {
    setBusy(action);
    setError("");
    try {
      const updated = await request<ConnectionStatus>(url, "POST", body);
      setStatus(updated);
      await refresh().catch(() => undefined);
      onChanged?.();
      if (updated.connected) onConnected?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Salesforce authentication failed.");
      await refresh().catch(() => undefined);
    } finally { setBusy(""); }
  }

  const content = (
    <div className="sf-login-card">
      <div className="sf-login-heading">
        <div>
          <span className="sf-login-kicker">SALESFORCE AUTHENTICATION</span>
          <h2>{firstLaunch ? "Connect a Salesforce org" : "Choose your Salesforce org"}</h2>
          <p>Sign in securely in the Salesforce browser page, or use a login already saved by Salesforce CLI. Passwords and tokens are never entered into this Analyzer screen.</p>
        </div>
        {status?.connected && <span className="sf-connection-pill sf-connection-on">Connected</span>}
      </div>
      <div className="sf-login-actions">
        <button className="primary-button" type="button" disabled={Boolean(busy)}
          onClick={() => void perform("sandbox", "/api/salesforce/login", { environment: "sandbox" })}>
          {busy === "sandbox" ? "Complete sign in in browser…" : "Sign in to Sandbox"}
        </button>
        <button className="secondary-button" type="button" disabled={Boolean(busy)}
          onClick={() => void perform("production", "/api/salesforce/login", { environment: "production" })}>
          {busy === "production" ? "Complete sign in in browser…" : "Sign in to Production"}
        </button>
      </div>
      <p className="sf-login-hint">The browser handles Salesforce username/password, MFA or SSO. Production and Sandbox use separate login endpoints. Your login is stored by Salesforce CLI on this computer.</p>
      <div className="sf-login-list-head">
        <h3>Existing CLI authorizations</h3>
        <button type="button" className="secondary-button" disabled={Boolean(busy)}
          onClick={() => { setError(""); setLoading(true); void refresh().catch(cause =>
            setError(cause instanceof Error ? cause.message : "Could not refresh org list.")
          ).finally(() => setLoading(false)); }}>Refresh list</button>
      </div>
      {loading ? <p className="sf-login-empty">Checking installed Salesforce CLI logins…</p> :
        orgs.length === 0 ? <p className="sf-login-empty">No existing CLI orgs found. Sign in to a Sandbox or Production org above.</p> :
          <div className="sf-login-orgs">
            {orgs.map(org => (
              <div className="sf-login-org" key={org.username}>
                <div className="sf-login-org-info">
                  <strong>{org.alias || org.username}</strong>
                  {org.alias && <span>{org.username}</span>}
                  <small>{org.environment === "sandbox" ? "Sandbox" : "Production"} · {org.orgId || "Org ID unavailable"}</small>
                </div>
                <span className={org.status === "connected" ? "sf-login-state connected" : "sf-login-state expired"}>
                  {org.status === "connected" ? "CLI connected" : "Expired"}
                </span>
                <button type="button" className="secondary-button" disabled={Boolean(busy) || org.selected && status?.connected}
                  onClick={() => {
                    if (org.status === "expired") {
                      void perform(org.environment, "/api/salesforce/login", { environment: org.environment });
                    } else {
                      void perform(org.username, "/api/salesforce/select", { username: org.username });
                    }
                  }}>
                  {org.selected && status?.connected ? "Active" : org.status === "expired" ? "Sign in again" : "Use this org"}
                </button>
              </div>
            ))}
          </div>
      }
      {status?.connected && !firstLaunch && (
        <div className="sf-login-footer">
          <span>Active: <strong>{status.alias || status.username}</strong></span>
          <button className="secondary-button" type="button" disabled={Boolean(busy)}
            onClick={() => void perform("disconnect", "/api/salesforce/disconnect")}>
            Disconnect from Analyzer
          </button>
        </div>
      )}
      {error && <div className="sf-feedback sf-error" role="alert">{error}</div>}
      {firstLaunch && (
        <div className="sf-login-footer">
          <span>Repository-only analysis is still available without an org connection.</span>
          <button type="button" className="secondary-button" disabled={Boolean(busy)}
            onClick={onContinueRepositoryOnly}>Continue without org</button>
        </div>
      )}
    </div>
  );

  return firstLaunch ? (
    <div className="sf-login-overlay" role="dialog" aria-modal="true" aria-label="Salesforce org login">
      {content}
    </div>
  ) : content;
}
