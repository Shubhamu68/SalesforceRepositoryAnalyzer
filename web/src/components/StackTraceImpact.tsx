import { useMemo, useState, type FormEvent } from "react";

type Status = "AT_RISK" | "REVIEW" | "NO_GAPS";
type Missing = { object: string; field?: string; reason: "OBJECT_READ" | "FIELD_READ" };
type Frame = { kind: string; className: string; methodName?: string; line: number };
type Method = {
  id: string; className: string; methodName: string; filePath: string;
  startLine: number; endLine: number; depth: number; callPaths: string[][];
};
type Impact = { personaName: string; status: Status; missing: Missing[]; notes: string[] };
type Query = {
  id: string; methodId: string; className: string; methodName: string;
  filePath: string; lineNumber: number; object: string; query: string;
  withUserMode: boolean;
  securityMode: "USER_MODE" | "SECURITY_ENFORCED" | "SYSTEM_MODE" | "UNSPECIFIED";
  checkedFields: { object: string; field: string; source: string }[];
  unresolvedFields: string[]; limitations: string[]; personas: Impact[];
};
type Persona = {
  personaName: string; status: Status; atRiskQueries: number;
  reviewQueries: number; missing: Missing[];
};
type Result = {
  entryMethod: Method; frames: Frame[]; methods: Method[]; queries: Query[];
  personas: Persona[];
  summary: { methodsVisited: number; queriesFound: number; personasChecked: number;
    atRisk: number; review: number; noGaps: number };
  warnings: string[];
};

const SAMPLE = `Class.OMSQueryService.getTrxValidationMap: line 1774, column 1
Class.ProcessExceptionHandler.onAfterUpdate: line 150, column 1
Trigger.ProcessExceptionTrigger: line 23, column 1`;

const STATUS: Record<Status, { title: string; className: string }> = {
  AT_RISK: { title: "At risk", className: "stack-risk" },
  REVIEW: { title: "Review", className: "stack-review" },
  NO_GAPS: { title: "No gaps found", className: "stack-good" },
};

function StatusPill({ value }: { value: Status }) {
  return <span className={`stack-status ${STATUS[value].className}`}>{STATUS[value].title}</span>;
}

export default function StackTraceImpact() {
  const [trace, setTrace] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedPersona, setSelectedPersona] = useState("");
  const [queryFilter, setQueryFilter] = useState("all");

  const personas = useMemo(() => result?.personas.filter((item) =>
    item.personaName.toLowerCase().includes(filter.trim().toLowerCase())
  ) ?? [], [result, filter]);
  const queries = useMemo(() => result?.queries.filter((item) =>
    queryFilter === "all" || item.personas.find((p) => p.personaName === queryFilter)?.status !== "NO_GAPS"
  ) ?? [], [result, queryFilter]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trace.trim()) { setError("Paste a Salesforce Apex stack trace first."); return; }
    setLoading(true); setError(""); setResult(null); setSelectedPersona(""); setQueryFilter("all");
    try {
      const response = await fetch("/api/stack-trace-impact", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stackTrace: trace }),
      });
      const body: Result | { error?: string } = await response.json();
      if (!response.ok) throw new Error("error" in body ? body.error ?? "Analysis failed." : "Analysis failed.");
      setResult(body as Result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to analyze the stack trace.");
    } finally { setLoading(false); }
  }

  const focused = result?.personas.find((persona) => persona.personaName === selectedPersona);

  return (
    <div className="stack-page">
      <form className="panel stack-form" onSubmit={analyze}>
        <div className="panel-heading"><div>
          <h2>Trace an Apex execution path</h2>
          <p>Paste the stack trace. We'll extract its method, recursively follow resolvable calls and check SOQL access across all configured personas.</p>
        </div><span className="mini-tag">Repository-based analysis</span></div>
        <div className="form-field stack-input">
          <label htmlFor="stack-text">Apex stack trace</label>
          <textarea id="stack-text" spellCheck={false} rows={5} value={trace}
            onChange={(event) => { setTrace(event.target.value); setError(""); }}
            placeholder={SAMPLE} disabled={loading} />
        </div>
        <div className="stack-controls">
          <span>Starts at the first matching Class frame. Static SOQL only; all branches are considered potentially reachable.</span>
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? "Analysing stack trace…" : "Run Stack Trace Analysis"}
          </button>
        </div>
        {error && <div className="error-card" role="alert">{error}</div>}
      </form>

      {result && <>
        <section className="stack-stats" aria-label="Analysis summary">
          {[
            ["Methods traversed", result.summary.methodsVisited],
            ["SOQL queries", result.summary.queriesFound],
            ["Personas checked", result.summary.personasChecked],
            ["At risk", result.summary.atRisk],
            ["Review", result.summary.review],
          ].map(([label, value]) => <div className="stack-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </section>

        <section className="panel stack-entry">
          <div className="panel-heading"><div><h2>Entry method &amp; traversal</h2>
            <p>{result.entryMethod.className}.{result.entryMethod.methodName} · lines {result.entryMethod.startLine}–{result.entryMethod.endLine}</p>
          </div><span className="mini-tag">{result.methods.length} method(s)</span></div>
          <details className="stack-source-frames">
            <summary>Original stack frames ({result.frames.length})</summary>
            <ol>{result.frames.map((frame, index) => <li key={`${frame.className}-${frame.line}-${index}`}>
              {frame.kind}.{frame.className}{frame.methodName ? `.${frame.methodName}` : ""} — line {frame.line}
            </li>)}</ol>
          </details>
          <div className="stack-tree">
            {result.methods.map((method) => <div key={method.id} className="stack-method-row" style={{ paddingLeft: `${Math.min(method.depth, 8) * 20 + 12}px` }}>
              <span className="stack-node-icon">↳</span><div><strong>{method.className}.{method.methodName}()</strong>
                <small>{method.filePath} · lines {method.startLine}–{method.endLine}</small></div>
            </div>)}
          </div>
        </section>

        <section className="panel stack-persona-panel">
          <div className="panel-heading"><div><h2>Persona impact overview</h2>
            <p>Click a persona to inspect missing object and field Read access.</p>
          </div><span className="mini-tag">{result.personas.length} configured</span></div>
          <div className="stack-filter"><label htmlFor="stack-persona-filter">Search personas</label>
            <input id="stack-persona-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search persona name..." type="search" />
          </div>
          <div className="stack-table-wrap"><table className="stack-table"><thead><tr>
            <th>Persona</th><th>Assessment</th><th>At-risk queries</th><th>Review</th><th>Missing grants</th>
          </tr></thead><tbody>
            {personas.map((persona) => <tr key={persona.personaName} className={selectedPersona === persona.personaName ? "stack-selected" : ""}>
              <td><button className="stack-persona-button" onClick={() => setSelectedPersona(persona.personaName)} type="button">{persona.personaName}</button></td>
              <td><StatusPill value={persona.status} /></td>
              <td>{persona.atRiskQueries}</td><td>{persona.reviewQueries}</td><td>{persona.missing.length}</td>
            </tr>)}
            {!personas.length && <tr><td colSpan={5}>No personas match the filter.</td></tr>}
          </tbody></table></div>
          {focused && <div className="stack-persona-detail"><div className="stack-detail-heading">
            <h3>{focused.personaName}</h3><StatusPill value={focused.status} />
          </div>{focused.missing.length ? <ul>{focused.missing.map((item, index) =>
            <li key={`${item.object}-${item.field ?? ""}-${index}`}><strong>{item.object}{item.field ? `.${item.field}` : ""}</strong>
              <span>{item.reason === "OBJECT_READ" ? "Missing object Read" : "Missing field Read"}</span></li>
          )}</ul> : <p className="muted">No explicit missing grants found. Check review notes and analysis limitations before concluding that execution will succeed.</p>}
          </div>}
        </section>

        <section className="panel stack-queries">
          <div className="panel-heading"><div><h2>Discovered SOQL queries</h2><p>Expandable query details include selected fields, unresolved relationships and persona impacts.</p></div>
            <div className="stack-query-filter"><label htmlFor="stack-query-filter">Query filter</label>
              <select id="stack-query-filter" value={queryFilter} onChange={(event) => setQueryFilter(event.target.value)}>
                <option value="all">All queries</option>
                {result.personas.map((persona) => <option key={persona.personaName} value={persona.personaName}>Issues for {persona.personaName}</option>)}
              </select></div>
          </div>
          {queries.length ? <div className="stack-query-list">{queries.map((query) => <details className="stack-query-card" key={query.id}>
            <summary><span className="stack-query-object">{query.object}</span><span>{query.className}.{query.methodName} · line {query.lineNumber}</span>
              <span className="stack-mode">{query.securityMode === "UNSPECIFIED" ? "Mode not explicit" : `WITH ${query.securityMode}`}</span>
              <span className="stack-query-count">{query.personas.filter((persona) => persona.status === "AT_RISK").length} at risk</span></summary>
            <div className="stack-query-detail"><pre>{query.query}</pre>
              <h4>Resolved field references ({query.checkedFields.length})</h4>
              {query.checkedFields.length ? <div className="stack-fields">{query.checkedFields.map((field) => <code key={`${field.object}.${field.field}`}>{field.object}.{field.field}</code>)}</div>
                : <p className="muted">No non-excluded field references were resolved. Object Read access is still checked.</p>}
              {query.unresolvedFields.length > 0 && <div className="stack-caution"><strong>Unresolved fields</strong>
                <ul>{query.unresolvedFields.map((field) => <li key={field}>{field}</li>)}</ul></div>}
              {query.limitations.length > 0 && <div className="stack-caution"><strong>Additional review</strong>
                <ul>{query.limitations.map((note) => <li key={note}>{note}</li>)}</ul></div>}
              <h4>Persona results</h4>
              <div className="stack-query-personas">{query.personas.map((persona) => <div key={persona.personaName}>
                <strong>{persona.personaName}</strong><StatusPill value={persona.status} />
                {persona.missing.length > 0 && <small>Missing: {persona.missing.map((missing) => `${missing.object}${missing.field ? `.${missing.field}` : ""}`).join(", ")}</small>}
                {persona.notes.length > 0 && <small>{persona.notes.join(" ")}</small>}
              </div>)}</div>
            </div>
          </details>)}</div> : <div className="stack-empty">No static SOQL queries match this filter.</div>}
        </section>

        {result.warnings.length > 0 && <details className="stack-warnings">
          <summary>Analysis limitations and warnings ({result.warnings.length})</summary>
          <ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
        </details>}
        <p className="stack-disclaimer">This is static analysis, not a live Salesforce execution trace. A reachable query is not necessarily executed; missing metadata, dynamic SOQL, execution mode, and runtime conditions can change the outcome.</p>
      </>}
    </div>
  );
}
