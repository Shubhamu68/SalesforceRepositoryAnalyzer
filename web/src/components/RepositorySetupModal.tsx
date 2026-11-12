import { useEffect, useRef, type KeyboardEvent } from "react";
import "./ReportOutputSetupModal.css";

interface Props {
  busy: boolean;
  error: string;
  currentPath?: string | null;
  onChoose: () => void;
}

export default function RepositorySetupModal({ busy, error, currentPath, onChoose }: Props) {
  const select = useRef<HTMLButtonElement>(null);
  useEffect(() => { select.current?.focus(); }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      // The only focusable control is Choose Folder, so keep focus there.
      event.preventDefault();
      select.current?.focus();
    }
  }
  return (
    <div className="report-folder-backdrop">
      <div className="report-folder-dialog" role="dialog" aria-modal="true"
        aria-labelledby="repository-setup-title" aria-describedby="repository-setup-description"
        onKeyDown={onKeyDown}>
        <div className="report-folder-heading">
          <span className="report-folder-symbol" aria-hidden="true">▣</span>
          <div>
            <span className="report-folder-kicker">REQUIRED SETUP</span>
            <h2 id="repository-setup-title">Choose Salesforce Repository</h2>
          </div>
        </div>
        <p id="repository-setup-description">
          Select the root of your Salesforce source repository. The Analyzer checks its
          metadata folders before allowing analysis and saves the validated path in <code>.env</code>.
        </p>
        <div className="report-folder-selection">
          <strong className="report-folder-label">Required: force-app/main/default</strong>
          <p>Must contain <code>classes</code>, <code>objects</code>, <code>permissionsets</code>,
            <code>permissionsetgroups</code> and <code>mutingpermissionsets</code>.
            <code>flows</code> is optional.</p>
          {currentPath && <p><strong>Current selection:</strong> {currentPath}</p>}
        </div>
        {error && <div className="report-folder-error" role="alert">{error}</div>}
        <div className="report-folder-actions">
          <button ref={select} type="button" className="primary-button" disabled={busy} onClick={onChoose}>
            {busy ? "Opening Windows folder picker…" : "Browse & Validate Repository"}
          </button>
        </div>
        <p>Invalid folders are rejected. No analysis will run until a valid repository is selected.</p>
      </div>
    </div>
  );
}
