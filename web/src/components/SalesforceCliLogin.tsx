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
  const [current, setCurrent] = useState<AuthStatus | null>(null);
  // Discovery, not the presence of another org, controls button availability.
  // The backend remains responsible for CLI version and OAuth validation.
  const cliOutdated = /Salesforce CLI [\d.]+ is too old for secure token retrieval/i.test(error);
  const detectedVersion = error.match(/Salesforce CLI (\d+\.\d+\.\d+) is too old/i)?.[1];
  const canLogInWithBrowser = canStartBrowserLogin({
    checking: loading, busy: Boolean(busy),
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
        <h1 id="sf-cli-heading">{onBack ? "Change Salesforce org" : "Connect Salesforce org"}</h1>
        <p className="sf-cli-intro">Choose a saved org or sign in through Salesforce.</p>

        {current?.connected && (
          <div className="sf-cli-connected" role="status">
            Current org: {current.alias || current.username || "Salesforce"}
          </div>
        )}

        <label className="sf-cli-label" htmlFor="sf-cli-org">Saved CLI orgs</label>
        <div className="sf-cli-row">
          <select id="sf-cli-org" className="sf-cli-select" value={selected}
            onChange={event => setSelected(event.target.value)}
            disabled={loading || Boolean(busy) || orgs.length === 0}>
            {orgs.length === 0 && <option value="">{cliOutdated ? "Update Salesforce CLI to load saved orgs" : discoveryWarning ? "Saved CLI orgs unavailable" : error ? "Cannot load CLI orgs" : "No saved orgs found"}</option>}
            {orgs.map(org => (
              <option key={org.username} value={org.username}>
                {org.alias || org.username} ({org.environment})
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
          <span>{loading ? "Checking CLI…" : cliVersion ? "CLI " + (cliVersion.match(/@salesforce\/cli\/(\d+\.\d+\.\d+)/)?.[1] ?? cliVersion) : detectedVersion ? "CLI " + detectedVersion + " · update required" : "CLI status unavailable"}</span>
          <button type="button" className="sf-cli-link" disabled={loading || Boolean(busy)}
            onClick={() => void refresh()}>Refresh orgs</button>
        </div>

        <div className="sf-cli-separator"><span>OR SIGN IN</span></div>
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
        {busy === "sandbox" || busy === "production"
          ? <p className="sf-cli-pending" role="status">
              Complete sign-in in your browser.
            </p> : null}
        {discoveryWarning && <p className="sf-cli-discovery-warning" role="status">{discoveryWarning}</p>}
        {cliOutdated ? (
          <div className="sf-cli-upgrade" role="alert">
            <strong>Salesforce CLI update required</strong>
            <p>{detectedVersion ? `Installed: ${detectedVersion}. ` : ""}
              Run <code>sf update</code> (requires 2.136+), verify with <code>sf --version</code>,
              restart the Analyzer, and select Refresh orgs.</p>
          </div>
        ) : error && <p className="sf-cli-error" role="alert">{error}</p>}
        <p className="sf-cli-note">
          Salesforce handles sign-in. Your password is not stored in the Analyzer.
        </p>
        {onSkip && (
          <button type="button" className="sf-cli-skip" disabled={loading || Boolean(busy) || Boolean(current?.connected)} onClick={onSkip}>
            Use repository-only analysis
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
