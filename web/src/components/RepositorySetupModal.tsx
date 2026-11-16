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
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => { select.current?.focus(); }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    // The expandable requirements summary is keyboard focusable as well as
    // the folder button. Keep both reachable inside this required setup modal.
    const items = [...(modal.current?.querySelectorAll<HTMLElement>("summary, button:not(:disabled)") ?? [])];
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
      event.preventDefault();
      items[0].focus();
    }
  }
  return (
    <div className="report-folder-backdrop">
      <div className="report-folder-dialog" role="dialog" aria-modal="true"
        aria-labelledby="repository-setup-title" aria-describedby="repository-setup-description"
        ref={modal} onKeyDown={onKeyDown}>
        <div className="report-folder-heading">
          <span className="report-folder-symbol" aria-hidden="true">▣</span>
          <div>
            <span className="report-folder-kicker">REQUIRED SETUP</span>
            <h2 id="repository-setup-title">Choose Salesforce repository</h2>
          </div>
        </div>
        <p id="repository-setup-description">
          Select the repository root containing <code>force-app/main/default</code>.
          The path is validated and saved in <code>.env</code>.
        </p>
        <details className="report-folder-requirements">
          <summary>Required metadata folders</summary>
          <p><code>classes</code>, <code>objects</code>, <code>permissionsets</code>,
            <code>permissionsetgroups</code>, and <code>mutingpermissionsets</code>.
            <code>flows</code> is optional.</p>
        </details>
        {currentPath && <p className="report-folder-current-path"><strong>Previously selected:</strong> {currentPath}</p>}
        {error && <div className="report-folder-error" role="alert">{error}</div>}
        <div className="report-folder-actions">
          <button ref={select} type="button" className="primary-button" disabled={busy} onClick={onChoose}>
            {busy ? "Opening folder picker…" : "Choose repository folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
