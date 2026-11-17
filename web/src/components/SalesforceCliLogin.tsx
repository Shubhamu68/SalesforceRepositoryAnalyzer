import { useCallback, useEffect, useState } from "react";
import "./SalesforceCliLogin.css";
import { canStartBrowserLogin } from "../utils/salesforceAuthUi";

type CliOrg = {
  alias?: string;
  username: string;
  orgId?: string;
  environment: "sandbox" | "production";
  status: "saved" | "expired";
};
type OrgList = { cliVersion: string; orgs: CliOrg[]; warning?: string };
type AuthStatus = { connected: boolean; username?: string; alias?: string; organizationId?: string };

async function requestJson(path: string, options?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data: unknown = await response.json().catch(() => null);
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Unable to access Salesforce CLI.");
  }
  return payload;
}

/**
 * Local CLI authorization selector. User credentials are collected only on
 * the Salesforce-hosted browser login page, never by the Analyzer.
 */
export default function SalesforceCliLogin({
  onComplete, onSkip, onBack, autoContinueConnected = false, compact = false,
}: {
  onComplete: (status: AuthStatus) => void;
  onSkip?: () => void;
  onBack?: () => void;
  autoContinueConnected?: boolean;
  compact?: boolean;
}) {
  const [orgs, setOrgs] = useState<CliOrg[]>([]);
  const [selected, setSelected] = useState("");
  const [cliVersion, setCliVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [discoveryWarning, setDiscoveryWarning] = useState("");
  const [failedSavedSelection, setFailedSavedSelection] = useState(false);
  const [current, setCurrent] = useState<AuthStatus | null>(null);
  // A failed CLI version check must not make Sandbox/Production buttons
  // silently inert. The backend remains authoritative about compatibility.
  const cliOutdated = /Salesforce CLI [\d.]+ is too old for secure token retrieval/i.test(error);
  const detectedVersion = error.match(/Salesforce CLI (\d+\.\d+\.\d+) is too old/i)?.[1];
  const hasActiveCliOrgs = orgs.some(org => org.status === "saved");
  const canLogInWithBrowser = canStartBrowserLogin({
    checking: loading, busy: Boolean(busy),
    hasError: Boolean(error) && !failedSavedSelection,
    connected: Boolean(current?.connected),
    hasActiveCliOrgs: hasActiveCliOrgs && !failedSavedSelection,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    setDiscoveryWarning("");
    try {
      // A connected backend session is sufficient to enter the workspace.
      // Don't await unrelated saved-org discovery before deciding to enter.
      const status = await requestJson("/api/salesforce/status");
      const session = status as AuthStatus;
      setCurrent(session);
      if (autoContinueConnected && session.connected) {
        onComplete(session);
        return;
      }
      const payload = await requestJson("/api/salesforce/orgs");
      const list = payload as unknown as OrgList;
      const next = Array.isArray(list.orgs) ? list.orgs : [];
      setOrgs(next);
      setCliVersion(typeof list.cliVersion === "string" ? list.cliVersion : "");
      setDiscoveryWarning(typeof list.warning === "string" ? list.warning : "");
      setSelected(previous => next.some(org => org.username === session.username)
        ? session.username!
        : next.some(org => org.username === previous) ? previous
        : next.find(org => org.status === "saved")?.username ?? next[0]?.username ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Salesforce CLI could not be found.");
    } finally {
      setLoading(false);
    }
  }, [autoContinueConnected]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function selectExisting() {
    if (!selected) return;
    setBusy("select");
    setError("");
    try {
      const status = await requestJson("/api/salesforce/select", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: selected }),
      });
      setCurrent(status as AuthStatus);
      onComplete(status as AuthStatus);
    } catch (cause) {
      setFailedSavedSelection(true);
      setError(cause instanceof Error ? cause.message : "Could not connect this Salesforce org.");
    } finally { setBusy(""); }
  }

  async function browserLogin(environment: "sandbox" | "production") {
    if (!canLogInWithBrowser) return;
    setBusy(environment);
    setError("");
    try {
      // Salesforce CLI opens the official login in the machine's default
      // browser; this request resolves after the CLI has completed OAuth.
      const status = await requestJson("/api/salesforce/login-web", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment }),
      });
      setCurrent(status as AuthStatus);
      onComplete(status as AuthStatus);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Salesforce browser login failed.";
      await refresh();
      setError(message);
    } finally { setBusy(""); }
  }

  return (
    <div className={compact ? "sf-cli-compact" : "sf-cli-gate"}>
      <section className="sf-cli-card" aria-labelledby="sf-cli-heading">
        <div className="sf-cli-eyebrow">SALESFORCE REPOSITORY ANALYZER</div>
        <h1 id="sf-cli-heading">Connect your Salesforce account</h1>
        <p className="sf-cli-intro">
          Use an org already authorized with Salesforce CLI, or sign in to a Sandbox or
          Production org using Salesforce's normal browser login and SSO/MFA.
        </p>

        {current?.connected && (
          <div className="sf-cli-connected" role="status">
            Connected to {current.alias || current.username || "Salesforce"}
            {current.organizationId ? " · " + current.organizationId : ""}
          </div>
        )}

        <label className="sf-cli-label" htmlFor="sf-cli-org">CLI-authorized Salesforce org</label>
        <div className="sf-cli-row">
          <select id="sf-cli-org" className="sf-cli-select" value={selected}
            onChange={event => setSelected(event.target.value)}
            disabled={loading || Boolean(busy) || orgs.length === 0}>
            {orgs.length === 0 && <option value="">{cliOutdated ? "Update Salesforce CLI to load saved orgs" : discoveryWarning ? "Saved CLI orgs unavailable" : error ? "Cannot load CLI orgs" : "No saved orgs found"}</option>}
            {orgs.map(org => (
              <option key={org.username} value={org.username}>
                {org.alias ? org.alias + " — " : ""}{org.username} ({org.environment})
                {org.status === "expired" ? " · Re-login required" : ""}
              </option>
            ))}
          </select>
          <button type="button" className="primary-button" disabled={!selected || loading || Boolean(busy)}
            onClick={() => void selectExisting()}>
            {busy === "select" ? "Connecting…" : "Connect"}
          </button>
        </div>
        <div className="sf-cli-smallrow">
          <span>{loading ? "Checking Salesforce CLI…" : cliVersion ? "Installed: " + cliVersion : detectedVersion ? "Installed: " + detectedVersion + " · update required" : "Salesforce CLI status unavailable"}</span>
          <button type="button" className="sf-cli-link" disabled={loading || Boolean(busy)}
            onClick={() => void refresh()}>Refresh orgs</button>
        </div>

        <div className="sf-cli-separator"><span>OR LOG IN THROUGH SALESFORCE</span></div>
        <div className="sf-cli-row sf-cli-login-actions" aria-label="Sandbox or Production browser login">
          <button type="button" className="secondary-button" disabled={!canLogInWithBrowser}
            onClick={() => void browserLogin("sandbox")}>
            {busy === "sandbox" ? "Waiting for Sandbox login…" : "Log in to Sandbox"}
          </button>
          <button type="button" className="secondary-button" disabled={!canLogInWithBrowser}
            onClick={() => void browserLogin("production")}>
            {busy === "production" ? "Waiting for Production login…" : "Log in to Production"}
          </button>
        </div>
        {!loading && !error && hasActiveCliOrgs && !failedSavedSelection && (
          <p className="sf-cli-login-hint" role="status">
            Connected Salesforce CLI authorizations are available above. Select an org and click Connect.
            Sandbox and Production browser login is enabled only when no active CLI org is found.
          </p>
        )}
        {busy === "sandbox" || busy === "production"
          ? <p className="sf-cli-pending" role="status">
              Complete sign-in in the Salesforce browser window. The Analyzer will connect automatically afterward.
            </p> : null}
        {discoveryWarning && <p className="sf-cli-discovery-warning" role="status">{discoveryWarning}</p>}
        {failedSavedSelection && !current?.connected && (
          <p className="sf-cli-discovery-warning" role="status">
            The selected saved org could not connect. You can reauthorize using the Sandbox or Production browser login below.
          </p>
        )}
        {cliOutdated ? (
          <div className="sf-cli-upgrade" role="alert">
            <strong>Salesforce CLI update required</strong>
            <p>
              {detectedVersion ? `Version ${detectedVersion} is installed. ` : ""}
              The Analyzer needs Salesforce CLI 2.136.0 or newer to retrieve an access token securely.
              Update the CLI before connecting to either Sandbox or Production.
            </p>
            <div className="sf-cli-command"><code>sf update</code></div>
            <p>Run this command in Command Prompt or PowerShell, check the version with <code>sf --version</code>,
              then click <strong>Refresh orgs</strong> above. If the old version is still detected,
              restart the Analyzer API or desktop launcher.</p>
            <p className="sf-cli-upgrade-error">CLI response: {error}</p>
          </div>
        ) : error && <p className="sf-cli-error" role="alert">{error}</p>}
        <p className="sf-cli-note">
          Your password never enters the Analyzer. CLI maintains OAuth authorization;
          the Analyzer retains only the chosen org's access token in local backend memory.
          Expired CLI logins must be reauthorized through Salesforce.
        </p>
        {onSkip && (
          <button type="button" className="sf-cli-skip" disabled={loading || Boolean(busy) || Boolean(current?.connected)} onClick={onSkip}>
            Continue with repository-only analysis
          </button>
        )}
        {onBack && (
          <button type="button" className="sf-cli-skip" disabled={Boolean(busy)} onClick={onBack}>
            Back to workspace
          </button>
        )}
      </section>
    </div>
  );
}
