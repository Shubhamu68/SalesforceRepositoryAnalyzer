import { useEffect, useMemo, useState } from "react";
import "./App.css";
import ObjectAccessMatrix from "./components/ObjectAccessMatrix";
import StackTraceImpact from "./components/StackTraceImpact";

type Persona = {
  name: string;
};

type ObjectAccessResult = {
  object: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAllRecords: boolean;
  modifyAllRecords: boolean;
  viewAllFields: boolean;
};

type PermissionSource = {
  permissionSet: string;
  type: "permissionSetGroup" | "directPermissionSet" | "profile";
  viaSystemPermission?: "ViewAllData" | "ModifyAllData";
  permissionSetGroup?: string;
};

type FieldAccessResult = {
  field: string;
  read: boolean;
  edit: boolean;
  permissionable?: boolean;
  readGrantedBy: PermissionSource[];
  editGrantedBy: PermissionSource[];
  mutedBy: string[];
};

type SoqlAnalysisResult = {
  personaName: string;
  summary: {
    queriesAnalyzed: number;
    totalFindings: number;
    errors: number;
    reviews: number;
    affectedApexClasses: number;
    userModeQueries: number;
    noUserModeQueries: number;
  };
  outputFolder: string;
};

type CheckType = "object" | "field" | "soql";
type Page = "dashboard" | "access" | "soql" | "matrix" | "stack" | "reports";

function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [objects, setObjects] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);

  const [selectedPersona, setSelectedPersona] =
    useState("");

  const [checkType, setCheckType] =
    useState<CheckType>("object");

  const [objectName, setObjectName] =
    useState("");

  const [objectSearch, setObjectSearch] =
    useState("");

  const [fieldName, setFieldName] =
    useState("");

  const [fieldSearch, setFieldSearch] =
    useState("");

  const [showObjectOptions, setShowObjectOptions] =
    useState(false);

  const [showFieldOptions, setShowFieldOptions] =
    useState(false);

  const [result, setResult] = useState<
    | ObjectAccessResult
    | FieldAccessResult
    | SoqlAnalysisResult
    | null
  >(null);

  const [error, setError] = useState("");

  const [loadingPersonas, setLoadingPersonas] =
    useState(true);

  const [loadingObjects, setLoadingObjects] =
    useState(true);

  const [loadingFields, setLoadingFields] =
    useState(false);

  const [checking, setChecking] = useState(false);
  const [page, setPage] = useState<Page>("dashboard");
  const [repositoryName, setRepositoryName] = useState<string>("");
  const [apiConnected, setApiConnected] = useState(false);
  const [lastSoql, setLastSoql] = useState<SoqlAnalysisResult | null>(null);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        return response.json();
      })
      .then((data: { repositoryName?: string }) => {
        setRepositoryName(data.repositoryName || "Configured repository");
        setApiConnected(true);
      })
      .catch(() => setApiConnected(false));
  }, []);

  function navigate(next: Page) {
    setPage(next);
    setError("");
    if (next === "soql") {
      setCheckType("soql");
      setResult(null);
    } else if (next === "access") {
      if (checkType === "soql") setCheckType("object");
      setResult(null);
    }
  }


  useEffect(() => {
    async function loadPersonas() {
      try {
        const response =
          await fetch("/api/personas");

        if (!response.ok) {
          throw new Error(
            "Failed to load personas."
          );
        }

        const data: Persona[] =
          await response.json();

        setPersonas(data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load personas."
        );
      } finally {
        setLoadingPersonas(false);
      }
    }

    loadPersonas();
  }, []);

  useEffect(() => {
    async function loadObjects() {
      try {
        const response =
          await fetch("/api/objects");

        if (!response.ok) {
          throw new Error(
            "Failed to load objects."
          );
        }

        const data: string[] =
          await response.json();

        setObjects(data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load objects."
        );
      } finally {
        setLoadingObjects(false);
      }
    }

    loadObjects();
  }, []);

  useEffect(() => {
  if (!objectName) {
    return;
  }

  async function loadFields() {
    setLoadingFields(true);
    setFields([]);

    try {
      const response = await fetch(
        `/api/objects/${encodeURIComponent(
          objectName
        )}/fields`
      );

      if (!response.ok) {
        throw new Error(
          "Failed to load fields."
        );
      }

      const data: string[] =
        await response.json();

      setFields(data);
    } catch (err) {
      setFields([]);

      setError(
        err instanceof Error
          ? err.message
          : "Failed to load fields."
      );
    } finally {
      setLoadingFields(false);
    }
  }

  loadFields();
}, [objectName]);

  const filteredObjects = useMemo(() => {
    const search =
      objectSearch.trim().toLowerCase();

    if (!search) {
      return objects.slice(0, 20);
    }

    return objects
      .filter((object) =>
        object.toLowerCase().includes(search)
      )
      .slice(0, 20);
  }, [objects, objectSearch]);

  const filteredFields = useMemo(() => {
    const search =
      fieldSearch.trim().toLowerCase();

    if (!search) {
      return fields.slice(0, 20);
    }

    return fields
      .filter((field) =>
        field.toLowerCase().includes(search)
      )
      .slice(0, 20);
  }, [fields, fieldSearch]);

  async function handleCheck() {
    setError("");
    setResult(null);

    if (!selectedPersona) {
      setError("Please select a persona.");
      return;
    }

    if (
      checkType !== "soql" &&
      !objectName.trim()
    ) {
      setError("Please select an object.");
      return;
    }

    if (
      checkType === "field" &&
      !fieldName.trim()
    ) {
      setError("Please select a field.");
      return;
    }

    setChecking(true);

    try {
      let response: Response;

      if (checkType === "soql") {
        response = await fetch(
          "/api/soql-analysis",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              personaName:
                selectedPersona,
            }),
          }
        );
      } else {
        const encodedPersona =
          encodeURIComponent(
            selectedPersona
          );

        const encodedObject =
          encodeURIComponent(
            objectName.trim()
          );

        let url =
          `/api/personas/${encodedPersona}/objects/${encodedObject}`;

        if (checkType === "field") {
          const encodedField =
            encodeURIComponent(
              fieldName.trim()
            );

          url += `/fields/${encodedField}`;
        }

        response = await fetch(url);
      }

      if (response.status === 404) {
        setError(
          checkType === "object"
            ? "Object not found."
            : checkType === "field"
              ? "Field not found."
              : "Persona not found."
        );

        return;
      }

      if (!response.ok) {
        const body =
          await response.json().catch(
            () => null
          );

        throw new Error(
          body?.error ??
            "Unable to perform the check."
        );
      }

      const data =
        await response.json();

      setResult(data);
      if (checkType === "soql") {
        setLastSoql(data as SoqlAnalysisResult);
        setLastRunAt(new Date());
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to perform the access check."
      );
    } finally {
      setChecking(false);
    }
  }

  function formatBoolean(value: boolean) {
    return value ? "Yes" : "No";
  }

  function renderObjectResult(
    access: ObjectAccessResult
  ) {
    const permissions = [
      ["Read", access.read],
      ["Create", access.create],
      ["Edit", access.edit],
      ["Delete", access.delete],
      [
        "View All Records",
        access.viewAllRecords,
      ],
      [
        "Modify All Records",
        access.modifyAllRecords,
      ],
      [
        "View All Fields",
        access.viewAllFields,
      ],
    ];

    return (
      <div className="result-card">
        <div className="result-header">
          <span className="result-type">
            OBJECT
          </span>

          <h2>{access.object}</h2>
        </div>

        <div className="permission-grid">
          {permissions.map(
            ([label, value]) => (
              <div
                className="permission-row"
                key={String(label)}
              >
                <span>{label}</span>

                <strong
                  className={
                    value
                      ? "status yes"
                      : "status no"
                  }
                >
                  {formatBoolean(
                    Boolean(value)
                  )}
                </strong>
              </div>
            )
          )}
        </div>
      </div>
    );
  }

  function renderFieldResult(
    access: FieldAccessResult
  ) {
    return (
      <div className="result-card">
        <div className="result-header">
          <span className="result-type">
            FIELD
          </span>

          <h2>{access.field}</h2>
        </div>

        <div className="permission-grid">
          <div className="permission-row">
            <span>Read</span>

            <strong
              className={
                access.read
                  ? "status yes"
                  : "status no"
              }
            >
              {formatBoolean(access.read)}
            </strong>
          </div>

          <div className="permission-row">
            <span>Edit</span>

            <strong
              className={
                access.edit
                  ? "status yes"
                  : "status no"
              }
            >
              {formatBoolean(access.edit)}
            </strong>
          </div>
        </div>

        <div className="source-section">
          <h3>Read granted by</h3>

          {access.permissionable === false && access.read && (
            <p className="muted">
              Salesforce metadata marks this field as non-permissionable.
              Its Read access follows object Read; an individual FLS grant is not required.
            </p>
          )}
          {access.readGrantedBy.length === 0 ? (
            <p className="muted">
              {access.permissionable === false
                ? "No explicit field Read grant required."
                : "No direct grant found."}
            </p>
          ) : (
            access.readGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`read-${index}`}
                >
                  <strong>
                    {source.type === "profile" ? `Profile: ${source.permissionSet}` : source.permissionSet}
                  </strong>

                  {source.permissionSetGroup && (
                    <span>
                      PSG:{" "}
                      {
                        source.permissionSetGroup
                      }
                    </span>
                  )}
                </div>
              )
            )
          )}
        </div>

        <div className="source-section">
          <h3>Edit granted by</h3>

          {access.editGrantedBy.length === 0 ? (
            <p className="muted">
              No direct grant found.
            </p>
          ) : (
            access.editGrantedBy.map(
              (source, index) => (
                <div
                  className="source-item"
                  key={`edit-${index}`}
                >
                  <strong>
                    {source.type === "profile" ? `Profile: ${source.permissionSet}` : source.permissionSet}
                  </strong>

                  {source.permissionSetGroup && (
                    <span>
                      PSG:{" "}
                      {
                        source.permissionSetGroup
                      }
                    </span>
                  )}
                </div>
              )
            )
          )}
        </div>

        <div className="source-section">
          <h3>Muted by</h3>

          {access.mutedBy.length === 0 ? (
            <p className="muted">
              Not muted.
            </p>
          ) : (
            access.mutedBy.map(
              (source) => (
                <div
                  className="source-item muted-source"
                  key={source}
                >
                  {source}
                </div>
              )
            )
          )}
        </div>
      </div>
    );
  }

  function renderSoqlResult(
    analysis: SoqlAnalysisResult
  ) {
    const summaryItems = [
      [
        "Queries Analysed",
        analysis.summary.queriesAnalyzed,
      ],
      [
        "Errors",
        analysis.summary.errors,
      ],
      [
        "Reviews",
        analysis.summary.reviews,
      ],
      [
        "Affected Classes",
        analysis.summary.affectedApexClasses,
      ],
      [
        "USER_MODE",
        analysis.summary.userModeQueries,
      ],
      [
        "No USER_MODE",
        analysis.summary.noUserModeQueries,
      ],
    ];

    return (
      <div className="result-card">
        <div className="result-header">
          <span className="result-type">
            SOQL ANALYSIS
          </span>

          <h2>{analysis.personaName}</h2>
        </div>

        <div className="permission-grid">
          {summaryItems.map(
            ([label, value]) => (
              <div
                className="permission-row"
                key={String(label)}
              >
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            )
          )}
        </div>

        <div className="source-section">
          <h3>Analysis completed</h3>

          <p className="muted">
            The TXT reports and Excel summary were
            generated successfully.
          </p>

          <div className="source-item">
            <strong>Output folder</strong>
            <span>
              {analysis.outputFolder}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const soqlSummary = lastSoql?.summary;

  const metricCards = [
    { label: "SOQL queries", value: soqlSummary?.queriesAnalyzed, icon: "⌕", tone: "blue" },
    { label: "Errors", value: soqlSummary?.errors, icon: "!", tone: "red" },
    { label: "Review findings", value: soqlSummary?.reviews, icon: "◉", tone: "amber" },
    { label: "Affected classes", value: soqlSummary?.affectedApexClasses, icon: "{ }", tone: "purple" },
    { label: "WITH USER_MODE", value: soqlSummary?.userModeQueries, icon: "✓", tone: "green" },
    { label: "Without USER_MODE", value: soqlSummary?.noUserModeQueries, icon: "!", tone: "amber" },
  ];

  const analysisForm = (
    <section className="panel analysis-panel">
      <div className="panel-heading">
        <div>
          <h2>{page === "soql" ? "Run SOQL security analysis" : "Access check configuration"}</h2>
          <p>Analyze the configured Salesforce repository using persona permissions.</p>
        </div>
        <span className="mini-tag">Repository metadata</span>
      </div>
      <div className="analysis-fields">
        <div className="form-field">
          <label htmlFor="persona">Business persona</label>
          <select
            id="persona"
            value={selectedPersona}
            disabled={loadingPersonas || checking}
            onChange={(event) => {
              setSelectedPersona(event.target.value);
              setResult(null);
              setError("");
            }}
          >
            <option value="">{loadingPersonas ? "Loading personas…" : "Select a persona"}</option>
            {personas.map((persona) => (
              <option key={persona.name} value={persona.name}>{persona.name}</option>
            ))}
          </select>
        </div>
        {page === "access" && (
          <>
            <div className="form-field">
              <label>Access type</label>
              <div className="segmented" role="group" aria-label="Access type">
                <button type="button" className={checkType === "object" ? "selected" : ""} onClick={() => { setCheckType("object"); setResult(null); setError(""); }}>Object access</button>
                <button type="button" className={checkType === "field" ? "selected" : ""} onClick={() => { setCheckType("field"); setResult(null); setError(""); }}>Field access</button>
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="object-name">Object API name</label>
              <div className="autocomplete">
                <input
                  id="object-name"
                  type="text"
                  value={objectSearch}
                  autoComplete="off"
                  onFocus={() => setShowObjectOptions(true)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setObjectSearch(value);
                    setObjectName(value);
                    setShowObjectOptions(true);
                    setFieldName("");
                    setFieldSearch("");
                    setResult(null);
                    setError("");
                  }}
                  onBlur={() => window.setTimeout(() => setShowObjectOptions(false), 150)}
                  placeholder={loadingObjects ? "Loading objects…" : "e.g. Account or OrderSummary"}
                  disabled={loadingObjects}
                />
                {showObjectOptions && !loadingObjects && (
                  <div className="autocomplete-menu">
                    {filteredObjects.length ? filteredObjects.map((object) => (
                      <button
                        type="button"
                        className="autocomplete-option"
                        key={object}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setObjectName(object);
                          setObjectSearch(object);
                          setShowObjectOptions(false);
                          setFieldName("");
                          setFieldSearch("");
                          setResult(null);
                          setError("");
                        }}
                      >{object}</button>
                    )) : <div className="autocomplete-empty">No matching objects</div>}
                  </div>
                )}
              </div>
            </div>
            {checkType === "field" && (
              <div className="form-field">
                <label htmlFor="field-name">Field API name</label>
                <div className="autocomplete">
                  <input
                    id="field-name"
                    type="text"
                    value={fieldSearch}
                    autoComplete="off"
                    onFocus={() => setShowFieldOptions(true)}
                    onChange={(event) => {
                      setFieldSearch(event.target.value);
                      setFieldName(event.target.value);
                      setShowFieldOptions(true);
                      setResult(null);
                      setError("");
                    }}
                    onBlur={() => window.setTimeout(() => setShowFieldOptions(false), 150)}
                    placeholder={loadingFields ? "Loading fields…" : "e.g. Account_Code__c"}
                    disabled={loadingFields || !objectName}
                  />
                  {showFieldOptions && !loadingFields && objectName && (
                    <div className="autocomplete-menu">
                      {filteredFields.length ? filteredFields.map((field) => (
                        <button
                          type="button"
                          className="autocomplete-option"
                          key={field}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setFieldName(field);
                            setFieldSearch(field);
                            setShowFieldOptions(false);
                            setResult(null);
                            setError("");
                          }}
                        >{field}</button>
                      )) : <div className="autocomplete-empty">No matching fields</div>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        {page === "soql" && (
          <div className="helper-box">Scans Apex SOQL queries against the selected persona. The backend saves your TXT and Excel reports in the configured output folder.</div>
        )}
      </div>
      <div className="form-footer">
        <span>Uses repository metadata · No Salesforce org connection required</span>
        <button className="primary-button" disabled={checking} type="button" onClick={handleCheck}>
          {checking ? (page === "soql" ? "Analysing…" : "Checking…") : (page === "soql" ? "▷  Run SOQL Analysis" : "Check Access")}
        </button>
      </div>
      {error && <div className="error-card" role="alert">{error}</div>}
    </section>
  );

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">⬡</div>
        <div className="brand-name"><strong>Salesforce</strong><span>Repository Analyzer</span></div>
        <div className="topbar-right"><span className={apiConnected ? "connection online" : "connection offline"}><span className="connection-dot" />{apiConnected ? "API connected" : "API unavailable"}</span><span className="avatar">RA</span></div>
      </header>
      <aside className="sidebar">
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-links" aria-label="Main navigation">
          <button className={page === "dashboard" ? "active" : ""} onClick={() => navigate("dashboard")}><span className="nav-symbol">▦</span>Dashboard</button>
          <button className={page === "access" ? "active" : ""} onClick={() => navigate("access")}><span className="nav-symbol">◇</span>Access Checker</button>
          <button className={page === "soql" ? "active" : ""} onClick={() => navigate("soql")}><span className="nav-symbol">◎</span>SOQL Security Analysis</button>
          <button className={page === "matrix" ? "active" : ""} onClick={() => navigate("matrix")}><span className="nav-symbol">▤</span>Object Access Matrix</button>
          <button className={page === "stack" ? "active" : ""} onClick={() => navigate("stack")}><span className="nav-symbol">⌁</span>Stack Trace Impact</button>
          <button className={page === "reports" ? "active" : ""} onClick={() => navigate("reports")}><span className="nav-symbol">▧</span>Reports</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-info-card"><div className="side-info-title">Repository</div><div className="side-repo">{apiConnected ? "● Connected" : "○ Not connected"}</div><div className="side-info-text" title={repositoryName}>{repositoryName || "Loading…"}</div></div>
          <div className="side-info-card"><div className="side-info-title">Output reports folder</div><div className="side-info-text" title={lastSoql?.outputFolder || ""}>{lastSoql?.outputFolder || "Available after SOQL analysis"}</div></div>
          <div className="sidebar-footnote">Repository access analyzer</div>
        </div>
      </aside>
      <main className="main-area">
        <div className="page-heading">
          <div>
            <div className="breadcrumb">WORKSPACE / {page.toUpperCase()}</div>
            <h1>{page === "dashboard" ? "Security overview" : page === "access" ? "Access Checker" : page === "soql" ? "SOQL Security Analysis" : page === "matrix" ? "Object Access Matrix" : page === "stack" ? "Stack Trace Impact Analyzer" : "Generated reports"}</h1>
            <p>{page === "dashboard" ? "Explore persona access and SOQL security across your Salesforce repository." : page === "access" ? "Inspect effective object and field permissions for a selected persona." : page === "soql" ? "Scan Apex queries for persona-specific security findings." : page === "matrix" ? "Compare effective object permissions across all configured personas." : page === "stack" ? "Trace reachable SOQL queries from an Apex stack trace and compare access across all personas." : "Review where the latest generated analysis reports are saved."}</p>
          </div>
          {page === "dashboard" && <button className="primary-button" onClick={() => navigate("soql")}>▷  Run SOQL Analysis</button>}
        </div>

        {page === "dashboard" && (
          <>
            <div className="metrics-grid">
              {metricCards.map((metric) => <div className="metric-card" key={metric.label}><div className="metric-label">{metric.label}</div><div className={`metric-icon ${metric.tone}`}>{metric.icon}</div><div className="metric-number">{metric.value ?? "—"}</div><div className="metric-caption">{soqlSummary ? "Latest session" : "Run an analysis to populate"}</div></div>)}
            </div>
            <div className="dashboard-grid">
              <section className="panel severity-panel"><h2>Finding severity</h2>{soqlSummary ? <><div className="severity-visual" style={{ background: `conic-gradient(#f04452 0 ${soqlSummary.totalFindings ? 100 * soqlSummary.errors / soqlSummary.totalFindings : 0}%, #f5a23c 0 100%)` }}><div><strong>{soqlSummary.totalFindings}</strong><span>Total findings</span></div></div><div className="legend"><span><i className="dot red-dot"/>Errors <strong>{soqlSummary.errors}</strong></span><span><i className="dot orange-dot"/>Reviews <strong>{soqlSummary.reviews}</strong></span></div></> : <div className="empty-visual"><span>◌</span><p>No analysis completed yet</p><small>Run SOQL Security Analysis to populate this chart.</small></div>}</section>
              <section className="panel summary-panel"><h2>Repository & latest analysis</h2><div className="detail-line"><span>Repository</span><strong title={repositoryName}>{repositoryName || "Not loaded"}</strong></div><div className="detail-line"><span>API status</span><strong className={apiConnected ? "text-success" : "text-danger"}>{apiConnected ? "Connected" : "Unavailable"}</strong></div><div className="detail-line"><span>Last analysed</span><strong>{lastRunAt ? lastRunAt.toLocaleString() : "Not yet run"}</strong></div><div className="detail-line"><span>Persona</span><strong>{lastSoql?.personaName || "—"}</strong></div><div className="detail-line"><span>Reports folder</span><strong title={lastSoql?.outputFolder}>{lastSoql?.outputFolder || "—"}</strong></div></section>
            </div>
            <section className="panel shortcuts-panel"><div className="panel-heading"><div><h2>Quick actions</h2><p>Choose an analysis workflow.</p></div></div><div className="quick-actions"><button onClick={() => navigate("access")}><span className="shortcut-icon">◇</span><strong>Check object or field access</strong><small>Resolve permissions for a persona</small><span className="shortcut-arrow">→</span></button><button onClick={() => navigate("soql")}><span className="shortcut-icon">◎</span><strong>Scan SOQL security</strong><small>Generate findings and reports</small><span className="shortcut-arrow">→</span></button><button onClick={() => navigate("reports")}><span className="shortcut-icon">▧</span><strong>View report location</strong><small>Find generated Excel and TXT files</small><span className="shortcut-arrow">→</span></button></div></section>
          </>
        )}

        {(page === "access" || page === "soql") && (
          <>
            {analysisForm}
            {result && (
              <section className="results-section">
                <div className="results-heading"><div><span>ANALYSIS RESULT</span><h2>{selectedPersona}</h2></div><span className="result-complete">✓ Completed</span></div>
                {page === "soql" ? renderSoqlResult(result as SoqlAnalysisResult) : checkType === "object" ? renderObjectResult(result as ObjectAccessResult) : renderFieldResult(result as FieldAccessResult)}
              </section>
            )}
          </>
        )}

        {page === "matrix" && <ObjectAccessMatrix objects={objects} loadingObjects={loadingObjects} />}
        {page === "stack" && <StackTraceImpact />}

        {page === "reports" && <section className="panel reports-panel"><div className="panel-heading"><div><h2>Latest SOQL analysis reports</h2><p>Files are written by the backend, not downloaded by the browser.</p></div></div>{lastSoql ? <><div className="detail-line"><span>Persona</span><strong>{lastSoql.personaName}</strong></div><div className="detail-line"><span>Report folder</span><strong className="path-text">{lastSoql.outputFolder}</strong></div><div className="detail-line"><span>Findings</span><strong>{lastSoql.summary.totalFindings}</strong></div><button className="secondary-button" onClick={() => navigator.clipboard.writeText(lastSoql.outputFolder)}>Copy folder path</button></> : <div className="empty-reports"><span>▧</span><h3>No reports from this session</h3><p>Run SOQL Security Analysis to generate TXT and Excel reports.</p><button className="primary-button" onClick={() => navigate("soql")}>Run SOQL Analysis</button></div>}</section>}
      </main>
    </div>
  );
}

export default App;
