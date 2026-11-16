import { useEffect, useRef, type KeyboardEvent } from "react";
import "./ReportOutputSetupModal.css";

export type AnalysisWarning = {
  kind: "WARNING" | "ERROR";
  title: string;
  message: string;
};

type Props = {
  warning: AnalysisWarning;
  onContinue: () => void;
  onCancel: () => void;
};

export default function OrgAnalysisWarningModal({ warning, onContinue, onCancel }: Props) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, [warning.kind]);
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    if (event.key === "Tab") {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      if (buttons.length === 1) { event.preventDefault(); buttons[0].focus(); }
      else if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault(); buttons[buttons.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
        event.preventDefault(); buttons[0].focus();
      }
    }
  }
  return (
    <div className="report-folder-backdrop">
      <div className="report-folder-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="org-preflight-title" aria-describedby="org-preflight-description"
        onKeyDown={handleKeyDown}>
        <div className="report-folder-heading">
          <span className="report-folder-symbol" aria-hidden="true">{warning.kind === "ERROR" ? "!" : "i"}</span>
          <div>
            <span className="report-folder-kicker">SALESFORCE ORG VERIFICATION</span>
            <h2 id="org-preflight-title">{warning.title}</h2>
          </div>
        </div>
        <p id="org-preflight-description">{warning.message}</p>
        <div className="report-folder-actions">
          <button ref={first} type="button" className="secondary-button" onClick={onCancel}>
            {warning.kind === "ERROR" ? "Close" : "Cancel"}
          </button>
          {warning.kind === "WARNING" &&
            <button type="button" className="primary-button" onClick={onContinue}>Run repository-only</button>}
        </div>
      </div>
    </div>
  );
}
