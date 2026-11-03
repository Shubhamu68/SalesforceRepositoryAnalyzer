import { useMemo, useState, type FormEvent } from "react";

const PERMISSIONS = [
  { key: "read", label: "Read", shortLabel: "Read" },
  { key: "create", label: "Create", shortLabel: "Create" },
  { key: "edit", label: "Edit", shortLabel: "Edit" },
  { key: "delete", label: "Delete", shortLabel: "Delete" },
  { key: "viewAllRecords", label: "View All Records", shortLabel: "View All" },
  { key: "modifyAllRecords", label: "Modify All Records", shortLabel: "Modify All" },
  { key: "viewAllFields", label: "View All Fields", shortLabel: "View All Fields" },
] as const;

type PermissionKey = (typeof PERMISSIONS)[number]["key"];
type PermissionAccess = Record<PermissionKey, boolean>;

type PermissionSource = {
  permissionSet: string;
  type: "permissionSetGroup" | "directPermissionSet";
  permissionSetGroup?: string;
};

type MutedPermissionSource = {
  permissionSetGroup: string;
  mutingPermissionSet: string;
  affectedPermissionSets: string[];
};

type PermissionSourceDetail = {
  grantedBy: PermissionSource[];
  mutedBy: MutedPermissionSource[];
};

type MatrixPersona = {
  personaName: string;
  access: PermissionAccess;
  sources: Record<PermissionKey, PermissionSourceDetail>;
  warnings: string[];
};

type MatrixResult = {
  object: string;
  personas: MatrixPersona[];
  totalPersonas: number;
  personasWithRead: number;
  warnings: string[];
};

type Props = {
  objects: string[];
  loadingObjects: boolean;
};

function AccessIndicator({ granted }: { granted: boolean }) {
  return (
    <span
      className={`matrix-access-chip ${granted ? "matrix-allowed" : "matrix-denied"}`}
      title={granted ? "Granted" : "Not granted"}
      aria-label={granted ? "Granted" : "Not granted"}
    >
      <span aria-hidden="true">{granted ? "✓" : "—"}</span>
      <span className="matrix-chip-text">{granted ? "Yes" : "No"}</span>
    </span>
  );
}

function PermissionDetail({
  label,
  granted,
  detail,
}: {
  label: string;
  granted: boolean;
  detail: PermissionSourceDetail;
}) {
  return (
    <div className="matrix-permission-detail">
      <div className="matrix-detail-topline">
        <strong>{label}</strong>
        <AccessIndicator granted={granted} />
      </div>

      {detail.grantedBy.length > 0 ? (
        <div className="matrix-source-stack">
          <span className="matrix-source-caption">Effective grants from</span>
          {detail.grantedBy.map((source, index) => (
            <div className="matrix-source-line" key={`${source.type}-${source.permissionSetGroup ?? "direct"}-${source.permissionSet}-${index}`}>
              <span className="matrix-source-bullet" aria-hidden="true">●</span>
              <span>
                <strong>{source.permissionSet}</strong>
                <small>
                  {source.type === "permissionSetGroup"
                    ? `Through PSG: ${source.permissionSetGroup}`
                    : "Direct Permission Set"}
                </small>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="matrix-empty-grant">No effective Permission Set grant</p>
      )}

      {detail.mutedBy.map((mute, index) => (
        <div className="matrix-mute-line" key={`${mute.permissionSetGroup}-${mute.mutingPermissionSet}-${index}`}>
          <span className="matrix-source-caption">Muted within {mute.permissionSetGroup}</span>
          <strong>{mute.mutingPermissionSet}</strong>
          {mute.affectedPermissionSets.length > 0 && (
            <small>Suppresses: {mute.affectedPermissionSets.join(", ")}</small>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ObjectAccessMatrix({ objects, loadingObjects }: Props) {
  const [objectName, setObjectName] = useState("");
  const [data, setData] = useState<MatrixResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailed, setDetailed] = useState(false);
  const [personaSearch, setPersonaSearch] = useState("");

  const visiblePersonas = useMemo(() => {
    const search = personaSearch.trim().toLowerCase();
    return data?.personas.filter((persona) =>
      persona.personaName.toLowerCase().includes(search)
    ) ?? [];
  }, [data, personaSearch]);

  async function runAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = objectName.trim();
    if (!name) {
      setError("Enter an object API name to analyze.");
      return;
    }

    setLoading(true);
    setError("");
    setData(null);
    setDetailed(false);
    setPersonaSearch("");

    try {
      const response = await fetch(
        `/api/objects/${encodeURIComponent(name)}/persona-access`
      );
      const payload: MatrixResult | { error?: string } = await response.json();
      if (!response.ok) {
        throw new Error("error" in payload ? payload.error || "Unable to analyze object access." : "Unable to analyze object access.");
      }
      setData(payload as MatrixResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Object access analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="matrix-page">
      <form className="panel matrix-query-panel" onSubmit={runAnalysis}>
        <div className="panel-heading">
          <div>
            <h2>Analyze object access across personas</h2>
            <p>Enter one Salesforce object API name to compare all configured personas.</p>
          </div>
          <span className="mini-tag">Repository metadata</span>
        </div>
        <div className="matrix-query-row">
          <div className="form-field matrix-object-input">
            <label htmlFor="matrix-object-name">Object API name</label>
            <input
              id="matrix-object-name"
              type="text"
              list="matrix-object-suggestions"
              autoComplete="off"
              placeholder={loadingObjects ? "Loading available objects…" : "e.g., Account or OrderSummary"}
              value={objectName}
              onChange={(event) => {
                setObjectName(event.target.value);
                setError("");
                setData(null);
              }}
              disabled={loading}
            />
            <datalist id="matrix-object-suggestions">
              {objects.map((name) => <option key={name} value={name} />)}
            </datalist>
          </div>
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? "Analyzing all personas…" : "Run Access Matrix"}
          </button>
        </div>
        <p className="matrix-hint">Objects can also be entered manually when absent from local object metadata.</p>
        {error && <div className="error-card" role="alert">{error}</div>}
      </form>

      {data && (
        <section className="panel matrix-results-panel" aria-label="Object access matrix results">
          <div className="matrix-results-header">
            <div>
              <span className="result-type">OBJECT ACCESS MATRIX</span>
              <h2>{data.object}</h2>
              <p>{data.totalPersonas} configured personas · {data.personasWithRead} with Read access</p>
            </div>
            <button
              type="button"
              className={`secondary-button matrix-detail-toggle ${detailed ? "is-active" : ""}`}
              aria-pressed={detailed}
              onClick={() => setDetailed((current) => !current)}
            >
              {detailed ? "Simple View" : "Detailed View"}
            </button>
          </div>

          {data.warnings.length > 0 && (
            <details className="matrix-warning-box">
              <summary>{data.warnings.length} metadata warning(s) — review before relying on the results</summary>
              <ul>{data.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
            </details>
          )}

          <div className="matrix-toolbar">
            <label htmlFor="matrix-persona-search">Filter personas</label>
            <input
              id="matrix-persona-search"
              type="search"
              placeholder="Search persona name…"
              value={personaSearch}
              onChange={(event) => setPersonaSearch(event.target.value)}
            />
            <span>{visiblePersonas.length} of {data.totalPersonas} personas</span>
          </div>

          <div className="matrix-table-scroll" tabIndex={0} role="region" aria-label="Scrollable permissions table">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th scope="col">Persona</th>
                  {PERMISSIONS.map((permission) => (
                    <th scope="col" title={permission.label} key={permission.key}>{permission.shortLabel}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visiblePersonas.map((persona) => (
                  <tr key={persona.personaName}>
                    <th scope="row">{persona.personaName}{persona.warnings.length > 0 && <span className="matrix-persona-warning" title={persona.warnings.join("\n")}> ⚠</span>}</th>
                    {PERMISSIONS.map((permission) => (
                      <td key={permission.key}>
                        <AccessIndicator granted={persona.access[permission.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
                {visiblePersonas.length === 0 && (
                  <tr><td colSpan={PERMISSIONS.length + 1} className="matrix-no-results">No personas match the filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {detailed && (
            <div className="matrix-detailed-section">
              <div className="matrix-detailed-heading">
                <h3>Permission Set breakdown</h3>
                <p>Effective sources are shown after PSG muting. Open a persona to inspect all seven permissions.</p>
              </div>
              {visiblePersonas.map((persona) => (
                <details className="matrix-persona-detail" key={persona.personaName} open={visiblePersonas.length === 1 ? true : undefined}>
                  <summary>
                    <strong>{persona.personaName}</strong>
                    <span>{PERMISSIONS.filter((permission) => persona.access[permission.key]).length} of 7 granted</span>
                  </summary>
                  <div className="matrix-detail-grid">
                    {PERMISSIONS.map((permission) => (
                      <PermissionDetail
                        key={permission.key}
                        label={permission.label}
                        granted={persona.access[permission.key]}
                        detail={persona.sources[permission.key]}
                      />
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}
          <p className="matrix-disclaimer">This is a repository/persona-config analysis; it does not include Profile permissions, org-wide system permissions, or record-level sharing.</p>
        </section>
      )}
    </div>
  );
}
