import { useEffect, useRef, type KeyboardEvent } from "react";
import "./ReportOutputSetupModal.css";

type Props = {
  busy: boolean;
  explanation: string;
  error: string;
  onCancel: () => void;
  onChoose: () => void;
};

/**
 * The native dialog runs in the local Windows backend. A browser directory
 * input cannot provide the absolute path needed by the backend.
 */
export default function ReportOutputSetupModal({
  busy, explanation, error, onCancel, onChoose,
}: Props) {
  const chooseButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    chooseButton.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
    }
    if (event.key !== "Tab") return;
    const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length < 2) return;
    if (event.shiftKey && document.activeElement === buttons[0]) {
      event.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
      event.preventDefault();
      buttons[0].focus();
    }
  }

  return (
    <div className="report-folder-backdrop">
      <div className="report-folder-dialog" role="dialog" aria-modal="true"
        aria-labelledby="report-folder-title" aria-describedby="report-folder-description"
        ref={dialog} onKeyDown={onKeyDown}>
        <div className="report-folder-heading">
          <span className="report-folder-symbol" aria-hidden="true">▣</span>
          <div>
            <span className="report-folder-kicker">ONE-TIME SETUP</span>
            <h2 id="report-folder-title">Choose Report Output Folder</h2>
          </div>
        </div>
        <p id="report-folder-description">
          Choose where the Salesforce Repository Analyzer should save its Excel and TXT reports.
          The selected location will be saved in your project's <code>.env</code> file for future runs.
        </p>
        {explanation && <p className="report-folder-hint">{explanation}</p>}
        <div className="report-folder-selection">
          <span className="report-folder-label">Output directory</span>
          <span className="report-folder-empty">Not configured</span>
          <p>Click below to open the Windows folder picker. You can select an existing folder or create a new one.</p>
        </div>
        {error && <div role="alert" className="report-folder-error">{error}</div>}
        <div className="report-folder-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" ref={chooseButton}
            disabled={busy} onClick={onChoose}>
            {busy ? "Opening Windows folder picker..." : "Choose Folder & Run Analysis"}
          </button>
        </div>
      </div>
    </div>
  );
}
