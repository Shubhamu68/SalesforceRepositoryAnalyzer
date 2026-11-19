import type { SoqlProgressSnapshot } from "../hooks/useSoqlAnalysisProgress";

type AnalysisLoadingOverlayProps = {
  title: string;
  description: string;
  hint?: string;
  progress?: SoqlProgressSnapshot | null;
};

type StepState = "complete" | "active" | "pending" | "skipped";
const order = ["starting", "scanning", "preparing", "permissions", "excel", "complete"] as const;

function stepState(stage: SoqlProgressSnapshot["stage"], step: typeof order[number]): StepState {
  if (stage === "failed") return "pending";
  const currentIndex = (order as readonly string[]).indexOf(stage);
  const stepIndex = order.indexOf(step);
  if (currentIndex > stepIndex) return "complete";
  return currentIndex === stepIndex ? "active" : "pending";
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function ProgressStep({ label, state, detail }: {
  label: string;
  state: StepState;
  detail?: string;
}) {
  return (
    <li className={`soql-progress-step soql-progress-step--${state}`}>
      <span className="soql-progress-step-icon" aria-hidden="true">
        {state === "complete" ? "✓" : state === "active" ? <span className="soql-progress-spin" /> : "○"}
      </span>
      <span className="soql-progress-step-label">{label}{detail && <small>{detail}</small>}</span>
      <span className="soql-progress-step-status">
        {state === "complete" ? "Complete" : state === "active" ? "In progress" : state === "skipped" ? "Not needed" : "Pending"}
      </span>
    </li>
  );
}

function AnalysisLoadingOverlay({ title, description, hint, progress }: AnalysisLoadingOverlayProps) {
  const stage = progress?.stage ?? "starting";
  const kind = progress?.kind ?? (title === "Analyzing all personas" ? "all" : "single");
  const personaTotal = progress?.totalPersonas ?? 0;
  const personaDone = progress?.completedPersonas ?? 0;
  const permissions = stepState(stage, "permissions");
  const personaDetail = kind === "all" && personaTotal > 0
    ? `${personaDone} of ${personaTotal} personas completed · ${Math.max(0, personaTotal - personaDone)} remaining`
    : undefined;
  // Only display this optional step when an actual Salesforce matching lookup occurred.
  const includeMatching = progress?.mode === "ORG_AND_REPOSITORY" &&
    (progress.userMatching === "in_progress" || progress.userMatching === "complete");
  const matchingState: StepState = progress?.userMatching === "complete" ? "complete"
    : progress?.userMatching === "in_progress" ? "active"
    : "pending";
  const percent = Math.max(0, Math.min(100, Math.floor(progress?.percent ?? 0)));

  return (
    <div className="analysis-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="analysis-overlay__backdrop" aria-hidden="true" />
      <div className="analysis-overlay__dialog analysis-overlay__dialog--progress">
        <div className="analysis-overlay__illustration analysis-overlay__illustration--compact" aria-hidden="true">
          <div className="analysis-overlay__halo analysis-overlay__halo--outer" />
          <div className="analysis-overlay__halo analysis-overlay__halo--inner" />
          <div className="analysis-overlay__device">
            <div className="analysis-overlay__screen"><span>&lt;/&gt;</span></div>
          </div>
          <div className="analysis-overlay__lens"><div className="analysis-overlay__glass" /></div>
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="soql-progress-summary">
          <div className="soql-progress-summary-heading">
            <strong>Estimated progress</strong>
            <strong className="soql-progress-percent">{percent}%</strong>
          </div>
          <div className="soql-progress-bar" role="progressbar" aria-label="Estimated analysis progress"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
          {personaDetail && permissions === "active" && (
            <div className="soql-progress-personas">
              <strong>Checking permissions — {personaDone} of {personaTotal} personas completed</strong>
              <small>{personaDone} personas evaluated · {Math.max(0, personaTotal - personaDone)} remaining</small>
            </div>
          )}
        </div>
        <ol className="soql-progress-steps" aria-label="Analysis steps">
          <ProgressStep label="Scanning Apex code" state={stepState(stage, "scanning")} />
          <ProgressStep label="Preparing analysis" state={stepState(stage, "preparing")} />
          {includeMatching && <ProgressStep label="Finding matching Salesforce users" state={matchingState} />}
          <ProgressStep label="Checking permissions" state={permissions}
            detail={kind === "all" ? personaDetail : undefined} />
          <ProgressStep label={kind === "all" ? "Generating consolidated Excel" : "Generating Excel report"}
            state={stepState(stage, "excel")} />
        </ol>
        <div className="soql-progress-footer">
          <span>Please wait while the analysis completes.</span>
          <span>Elapsed: {duration(progress?.elapsedSeconds ?? 0)}</span>
        </div>
        {hint && <div className="analysis-overlay__hint">{hint}</div>}
      </div>
    </div>
  );
}

export default AnalysisLoadingOverlay;
