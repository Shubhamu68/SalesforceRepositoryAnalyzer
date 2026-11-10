type AnalysisLoadingOverlayProps = {
  title: string;
  description: string;
  hint?: string;
};

function AnalysisLoadingOverlay({ title, description, hint }: AnalysisLoadingOverlayProps) {
  return (
    <div className="analysis-overlay" role="alert" aria-live="assertive" aria-busy="true">
      <div className="analysis-overlay__backdrop" aria-hidden="true" />
      <div className="analysis-overlay__dialog">
        <div className="analysis-overlay__illustration" aria-hidden="true">
          <div className="analysis-overlay__halo analysis-overlay__halo--outer" />
          <div className="analysis-overlay__halo analysis-overlay__halo--inner" />
          <div className="analysis-overlay__device">
            <div className="analysis-overlay__screen">
              <span>&lt;/&gt;</span>
            </div>
          </div>
          <div className="analysis-overlay__lens">
            <div className="analysis-overlay__glass" />
          </div>
        </div>

        <h2>{title}</h2>
        <p>{description}</p>

        <div className="analysis-overlay__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        {hint && <div className="analysis-overlay__hint">⏱ {hint}</div>}
      </div>
    </div>
  );
}

export default AnalysisLoadingOverlay;
