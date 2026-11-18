import { useCallback, useEffect, useRef, useState } from "react";
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
  const [loading, setLoading] = useState(false);
  const [savedOrgsLoaded, setSavedOrgsLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [discoveryWarning, setDiscoveryWarning] = useState("");
  const [current, setCurrent] = useState<AuthStatus | null>(null);
  // Ignore responses from abandoned browser logins so they cannot overwrite
  // the user's newer Sandbox/Production choice.
  const browserRequest = useRef<AbortController | null>(null);
  const loginAttempt = useRef(0);
  // Saved-org discovery is explicitly requested by the user, never started
  // just because the login screen appeared. Direct browser login still uses
  // the CLI token command and validates the Salesforce session and org.
  const cliOutdated = /Salesforce CLI [\d.]+ is too old for secure token retrieval/i.test(error);
  const detectedVersion = error.match(/Salesforce CLI (\d+\.\d+\.\d+) is too old/i)?.[1];
  const canLogInWithBrowser = canStartBrowserLogin({
    // The other environment remains clickable during a browser login.
    busy: busy === "select" || busy === "switching" || busy === "cancelling",
  });

  // This local status request does not launch any CLI process.
  // Keep a verified current session available without loading saved orgs.
  useEffect(() => {
    let active = true;
    void requestJson("/api/salesforce/status").then(status => {
      if (!active) return;
      const session = status as AuthStatus;
      setCurrent(session);
      if (autoContinueConnected && session.connected && loginAttempt.current === 0) {
        onComplete(session);
      }
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to check Analyzer connection.");
    });
    return () => { active = false; };
  }, [autoContinueConnected]);

  const loadSavedOrgs = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    setDiscoveryWarning("");
    try {
      const payload = await requestJson(force ? "/api/salesforce/orgs?refresh=1" : "/api/salesforce/orgs");
      const list = payload as unknown as OrgList;
      const next = Array.isArray(list.orgs) ? list.orgs : [];
      setOrgs(next);
      setCliVersion(typeof list.cliVersion === "string" ? list.cliVersion : "");
      setDiscoveryWarning(typeof list.warning === "string" ? list.warning : "");
      setSelected(previous => next.some(org => org.username === current?.username)
        ? current!.username!
        : next.some(org => org.username === previous) ? previous
        : next.find(org => org.status === "saved")?.username ?? next[0]?.username ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Salesforce CLI could not be found.");
    } finally {
      setSavedOrgsLoaded(true);
      setLoading(false);
    }
  }, [current?.username]);

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

  const loginRequestOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  };

  async function cancelBrowserLogin() {
    const previous = browserRequest.current;
    if (!previous) return;
    const attempt = ++loginAttempt.current;
    previous.abort(); // Stop waiting for the old HTTP response immediately.
    browserRequest.current = null;
    setBusy("cancelling");
    setError("");
    try {
      // This also terminates the Salesforce CLI OAuth subprocess. Cancelling
      // fetch alone would leave sf.cmd waiting for up to five minutes.
      await requestJson("/api/salesforce/login-web/cancel", loginRequestOptions);
    } catch (cause) {
      if (attempt === loginAttempt.current) {
        setError(cause instanceof Error ? cause.message : "Unable to cancel Salesforce login.");
      }
    } finally {
      if (attempt === loginAttempt.current) setBusy("");
    }
  }

  async function browserLogin(environment: "sandbox" | "production") {
    if (!canLogInWithBrowser || busy === environment) return;
    const attempt = ++loginAttempt.current;
    const previous = browserRequest.current;
    previous?.abort();
    browserRequest.current = null;
    setBusy(previous ? "switching" : environment);
    setError("");
    try {
      if (previous) {
        // Wait for the old CLI process tree to exit before opening a new
        // Salesforce OAuth listener (which may reuse the same callback port).
        await requestJson("/api/salesforce/login-web/cancel", loginRequestOptions);
      }
      if (attempt !== loginAttempt.current) return;
      const controller = new AbortController();
      browserRequest.current = controller;
      setBusy(environment);
      const status = await requestJson("/api/salesforce/login-web", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment }),
        signal: controller.signal,
      });
      if (attempt !== loginAttempt.current || controller.signal.aborted) return;
      setCurrent(status as AuthStatus);
      onComplete(status as AuthStatus);
    } catch (cause) {
      if (attempt !== loginAttempt.current ||
          (cause instanceof Error && cause.name === "AbortError")) return;
      setError(cause instanceof Error ? cause.message : "Salesforce browser login failed.");
    } finally {
      if (attempt === loginAttempt.current) {
        browserRequest.current = null;
        setBusy("");
      }
    }
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
            {orgs.length === 0 && <option value="">{loading ? "Loading saved CLI orgs…" : !savedOrgsLoaded ? "Click Load saved orgs" : cliOutdated ? "Update Salesforce CLI to load saved orgs" : discoveryWarning ? "Saved CLI orgs unavailable" : error ? "Cannot load CLI orgs" : "No saved orgs found"}</option>}
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
          <span>{loading ? "Discovering saved orgs… (sign-in is available)" : !savedOrgsLoaded ? "Saved orgs load on demand; browser sign-in is ready." : cliVersion ? "CLI " + (cliVersion.match(/@salesforce\/cli\/(\d+\.\d+\.\d+)/)?.[1] ?? cliVersion) : detectedVersion ? "CLI " + detectedVersion + " · update required" : "CLI status unavailable"}</span>
          <button type="button" className="sf-cli-link" disabled={loading || Boolean(busy)}
            onClick={() => void loadSavedOrgs(savedOrgsLoaded)}>{savedOrgsLoaded ? "Refresh orgs" : "Load saved orgs"}</button>
        </div>

        <div className="sf-cli-separator"><span>OR SIGN IN</span></div>
        <div className="sf-cli-row sf-cli-login-actions" aria-label="Sandbox or Production browser login">
          <button type="button" className="secondary-button" disabled={!canLogInWithBrowser || busy === "sandbox"}
            onClick={() => void browserLogin("sandbox")}>
            {busy === "sandbox" ? "Waiting for Sandbox login…" : "Log in to Sandbox"}
          </button>
          <button type="button" className="secondary-button" disabled={!canLogInWithBrowser || busy === "production"}
            onClick={() => void browserLogin("production")}>
            {busy === "production" ? "Waiting for Production login…" : "Log in to Production"}
          </button>
        </div>
        {busy === "sandbox" || busy === "production"
          ? <div className="sf-cli-pending" role="status">
              <span>Complete sign-in in your browser, or choose the other environment.</span>
              <button type="button" className="sf-cli-link" onClick={() => void cancelBrowserLogin()}>
                Cancel login
              </button>
            </div> : null}
        {busy === "switching" || busy === "cancelling"
          ? <p className="sf-cli-pending" role="status">Stopping previous Salesforce login…</p> : null}
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
          <button type="button" className="sf-cli-skip" disabled={Boolean(busy) || Boolean(current?.connected)} onClick={onSkip}>
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
