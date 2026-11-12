import { permissionPresentation, type PermissionEvidence } from "./permissionPresentation";

export default function PermissionIndicator({
  granted, evidence, matrix = false,
}: { granted: boolean; evidence?: PermissionEvidence; matrix?: boolean }) {
  const result = permissionPresentation(granted, evidence);
  const className = matrix
    ? `matrix-access-chip ${result.tone === "allowed" ? (result.orgWarning ? "matrix-org-verified" : "matrix-allowed") : result.tone === "review" ? "matrix-org-unverified" : "matrix-denied"}`
    : `status ${result.tone === "allowed" ? "yes" : result.tone === "denied" ? "no" : ""}`;
  return (
    <span className={className} title={result.title} aria-label={result.title}>
      {matrix && <span aria-hidden="true">{result.label === "Yes" ? "✓" : "—"}</span>}
      <span className={matrix ? "matrix-chip-text" : undefined}>{result.label}</span>
      {result.orgWarning && (
        <span className="permission-org-warning" tabIndex={0}
          aria-label={result.title} title={result.title}>⚠</span>
      )}
    </span>
  );
}
