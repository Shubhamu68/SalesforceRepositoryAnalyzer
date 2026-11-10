import { Fragment, memo, useMemo, useState, type FormEvent, type ReactNode } from "react";
import "./StackTraceImpact.css";
import { StackTraceLoadingOverlay } from "./StackTraceLoadingOverlay";
import type { Impact, Missing, OrgCheckedUser, Persona, Query, Result, Status } from "./stackTraceTypes";
import { focusedQueries, hasNoMatchingUsers, orgVerifiedSummary, partitionFindings, permissionLabel } from "./stackTraceViewModel";

const SAMPLE = `Class.OMSQueryService.getTrxValidationMap: line 1774, column 1
Class.ProcessExceptionHandler.onAfterUpdate: line 150, column 1
Trigger.ProcessExceptionTrigger: line 23, column 1`;
const PAGE_SIZE = 25;

const STATUS: Record<Status, { title: string; className: string }> = {
  AT_RISK: { title: "At risk", className: "stack-risk" },
  REVIEW: { title: "Unable to verify", className: "stack-review" },
  ADVISORY: { title: "Permission advisory", className: "stack-review" },
  NO_GAPS: { title: "No gaps found", className: "stack-good" },
  ORG_VERIFIED: { title: "Verified from Org", className: "stack-org-verified" },
};

function StatusPill({ value }: { value: Status }) {
  return <span className={`stack-status ${STATUS[value].className}`}>{STATUS[value].title}</span>;
}

/** Expensive evidence lists are not mounted until the user expands the section. */
function Disclosure({ title, count, children }: { title: string; count: number; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className="stack-ux-disclosure">
    <button type="button" className="stack-ux-disclosure-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="stack-ux-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span>{title}</span><span className="stack-ux-count">{count}</span>
    </button>
    {open && <div className="stack-ux-disclosure-body">{children()}</div>}
  </section>;
}

function FindingList({ items, confirmed }: { items: Missing[]; confirmed: boolean }) {
  return <ul className="stack-ux-finding-list">
    {items.map((item) => <li className={confirmed ? "stack-ux-denied" : "stack-ux-unverified"} key={`${item.object}|${item.field ?? ""}|${item.reason}`}>
      <strong>{permissionLabel(item)}</strong>
      <span>{confirmed
        ? `${item.reason === "FIELD_READ" ? "Field" : "Object"} Read access is missing from both org and repository.`
        : "Repository permissions didn't confirm access, and Salesforce could not verify it."}</span>
    </li>)}
  </ul>;
}

function PersonaDetail({ persona }: { persona: Persona }) {
  const { denied, unverified } = useMemo(() => partitionFindings(persona.missing), [persona.missing]);
  const noMatches = hasNoMatchingUsers(persona);
  const verified = persona.verifiedFromOrg ?? [];
  const users = persona.orgCheckedUsers ?? [];
  return <div className="stack-ux-persona-detail">
    <div className="stack-ux-persona-heading"><h3>{persona.personaName}</h3><StatusPill value={persona.status} /></div>

    {noMatches && <div className="stack-ux-no-match" role="status">
      No active Salesforce user matched this persona, so the access check could not be completed.
    </div>}

    {denied.length > 0 && <section className="stack-ux-findings" aria-label="Confirmed missing permissions">
      <h4 className="stack-ux-danger-title">Missing Read permissions ({denied.length})</h4>
      <p>Salesforce confirmed missing access for one or more matching users.</p>
      <FindingList items={denied} confirmed />
    </section>}

    {unverified.length > 0 && <section className="stack-ux-findings" aria-label="Permissions awaiting verification">
      <h4 className="stack-ux-pending-title">Could not verify Read permissions ({unverified.length})</h4>
      <p>{noMatches
        ? "The following permissions were not confirmed in the repository. Salesforce could not check them because no matching user was found."
        : "The repository did not confirm these permissions, and Salesforce could not complete the check."}</p>
      {noMatches
        ? <ul className="stack-ux-pending-names">{unverified.map((item) => <li key={`${item.object}|${item.field ?? ""}`}>{permissionLabel(item)}</li>)}</ul>
        : <FindingList items={unverified} confirmed={false} />}
    </section>}

    {denied.length === 0 && unverified.length === 0 && <p className="stack-ux-clear">
      {persona.status === "REVIEW"
        ? "Some queries need further review. See the selected persona's query details below."
        : "No outstanding object or field Read permission findings."}
    </p>}

    {verified.length > 0 && <Disclosure title="Permissions verified from Salesforce" count={verified.length}>
      {() => <ul className="stack-ux-evidence-list">{verified.map((item) => <li key={`${item.object}|${item.field ?? ""}`}>
        {orgVerifiedSummary(item)}
      </li>)}</ul>}
    </Disclosure>}

    {users.length > 0 && <Disclosure title="Salesforce users checked" count={users.length}>
      {() => <ul className="stack-ux-user-list">{users.map((user: OrgCheckedUser) => <li key={user.id}>
        <strong>{user.name}</strong><span>{user.username}</span>
      </li>)}</ul>}
    </Disclosure>}
  </div>;
}

/** A query's field inventory mounts only when its disclosure is opened. */
const QueryCard = memo(function QueryCard({ query, impact }: { query: Query; impact: Impact }) {
  const [open, setOpen] = useState(false);
  const { denied, unverified } = useMemo(() => partitionFindings(impact.missing), [impact.missing]);
  return <article className="stack-query-card stack-ux-query-card">
    <button className="stack-ux-query-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="stack-ux-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="stack-query-object">{query.object}</span>
      <span className="stack-ux-query-method">{query.className}.{query.methodName} · line {query.lineNumber}</span>
      <span className="stack-mode">{query.securityMode === "UNSPECIFIED"
        ? query.effectiveMode === "UNKNOWN" || !query.effectiveMode
          ? "Execution mode unknown"
          : `${query.effectiveMode} (API ${query.apiVersion ?? "?"} default)`
        : `WITH ${query.securityMode}${query.effectiveMode === "INVALID_CLAUSE" ? " — unsupported" : ""}`}</span>
      <StatusPill value={impact.status} />
    </button>
    {open && <div className="stack-query-detail">
      <pre>{query.query}</pre>
      <h4>Resolved fields ({query.checkedFields.length})</h4>
      {query.checkedFields.length ? <div className="stack-fields">
        {query.checkedFields.map((field, i) => <code key={`${field.object}.${field.field}.${i}`}>{field.object}.{field.field}</code>)}
      </div> : <p className="muted">No individual field references were resolved. Object Read is still checked.</p>}
      {query.unresolvedFields.length > 0 && <div className="stack-caution">
        <strong>Fields we couldn't resolve</strong>
        <ul>{query.unresolvedFields.map((field, i) => <li key={`${field}-${i}`}>{field}</li>)}</ul>
      </div>}
      {query.limitations.length > 0 && <details className="stack-ux-extra-notes">
        <summary>Other technical limitations ({query.limitations.length})</summary>
        <ul>{query.limitations.map((note, i) => <li key={`${i}-${note}`}>{note}</li>)}</ul>
      </details>}
      <div className="stack-ux-query-persona">
        <div className="stack-ux-query-persona-heading"><h4>Persona result: {impact.personaName}</h4><StatusPill value={impact.status} /></div>
        {denied.length > 0 && <section aria-label="Missing permissions for this query">
          <strong className="stack-ux-danger-title">Missing access</strong>
          <FindingList items={denied} confirmed />
        </section>}
        {unverified.length > 0 && <section aria-label="Unverified permissions for this query">
          <strong className="stack-ux-pending-title">Unable to verify</strong>
          <FindingList items={unverified} confirmed={false} />
        </section>}
        {denied.length === 0 && unverified.length === 0 && <p className="stack-ux-clear">
          {impact.status === "REVIEW" ? "Some field references need further review." : "No outstanding Read permission findings for this query."}
        </p>}
        {(impact.verifiedFromOrg?.length ?? 0) > 0 && <Disclosure title="Verified from Salesforce" count={impact.verifiedFromOrg!.length}>
          {() => <ul className="stack-ux-evidence-list">{impact.verifiedFromOrg!.map((item) =>
            <li key={`${item.object}|${item.field ?? ""}`}>{orgVerifiedSummary(item)}</li>)}</ul>}
        </Disclosure>}
        {impact.notes.length > 0 && <details className="stack-ux-extra-notes">
          <summary>Analysis notes ({impact.notes.length})</summary>
          <ul>{impact.notes.map((note, i) => <li key={`${i}-${note}`}>{note}</li>)}</ul>
        </details>}
      </div>
    </div>}
  </article>;
});

/** Kept separate and memoized, so typing into the trace does not rerender large results. */
const StackResults = memo(function StackResults({ result }: { result: Result }) {
  const [filter, setFilter] = useState("");
  const [selectedPersona, setSelectedPersona] = useState("");
  const [queryFilter, setQueryFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const personas = useMemo(() => result.personas.filter((item) =>
    item.personaName.toLowerCase().includes(filter.trim().toLowerCase())
  ), [result.personas, filter]);
  const queries = useMemo(() => focusedQueries(result.queries, selectedPersona, queryFilter === "issues"),
    [result.queries, selectedPersona, queryFilter]);
  const visibleQueries = useMemo(() => queries.slice(0, visibleCount), [queries, visibleCount]);

  function choosePersona(name: string) {
    setSelectedPersona((previous) => previous === name ? "" : name);
    setVisibleCount(PAGE_SIZE);
    setQueryFilter("all");
  }

  return <>
    <section className="stack-stats stack-ux-stats" aria-label="Analysis summary">
      {[
        ["Methods traversed", result.summary.methodsVisited],
        ["SOQL queries", result.summary.queriesFound],
        ["At risk", result.summary.atRisk],
        ["Unable to verify", result.summary.review],
        ["Permission advisories", result.summary.advisory ?? 0],
        ["Verified from Org", result.summary.orgVerified ?? 0],
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
        <p>Select a persona to see access problems first, followed by supporting Salesforce evidence.</p>
      </div></div>
      <div className="stack-filter"><label htmlFor="stack-persona-filter">Search personas</label>
        <input id="stack-persona-filter" value={filter} onChange={(event) => {
          const next = event.target.value;
          setFilter(next);
          if (selectedPersona && !selectedPersona.toLowerCase().includes(next.trim().toLowerCase())) setSelectedPersona("");
        }} placeholder="Search persona name..." type="search" />
      </div>
      <div className="stack-table-wrap"><table className="stack-table stack-ux-table"><thead><tr>
        <th>Persona</th><th>Assessment</th><th>At-risk queries</th><th>Unable to verify</th><th>Open findings</th>
      </tr></thead><tbody>
        {personas.map((persona) => <Fragment key={persona.personaName}>
          <tr className={selectedPersona === persona.personaName ? "stack-selected" : ""}>
            <td><button className="stack-persona-button stack-ux-persona-button" type="button"
              aria-expanded={selectedPersona === persona.personaName}
              onClick={() => choosePersona(persona.personaName)}>
              <span className="stack-ux-chevron" aria-hidden="true">{selectedPersona === persona.personaName ? "▾" : "▸"}</span>
              {persona.personaName}
            </button></td>
            <td><StatusPill value={persona.status} /></td>
            <td>{persona.atRiskQueries}</td><td>{persona.reviewQueries}</td><td>{persona.missing.length}</td>
          </tr>
          {selectedPersona === persona.personaName && <tr className="stack-ux-detail-row"><td colSpan={5}>
            <PersonaDetail key={persona.personaName} persona={persona} />
          </td></tr>}
        </Fragment>)}
        {!personas.length && <tr><td colSpan={5}>No personas match the filter.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="panel stack-queries">
      <div className="panel-heading"><div><h2>Discovered SOQL queries</h2>
        <p>{selectedPersona ? `Showing query results for ${selectedPersona} only.` : "Select a persona above to see its query results."}</p>
      </div>{selectedPersona && <div className="stack-query-filter"><label htmlFor="stack-query-filter">Show</label>
        <select id="stack-query-filter" value={queryFilter} onChange={(event) => {
          setQueryFilter(event.target.value); setVisibleCount(PAGE_SIZE);
        }}><option value="all">All queries</option><option value="issues">Queries needing attention</option></select>
      </div>}</div>
      {!selectedPersona ? <div className="stack-empty">Choose a persona to explore the discovered queries.</div>
        : queries.length ? <>
          <div className="stack-query-list">{visibleQueries.map(({ query, impact }) =>
            <QueryCard key={`${selectedPersona}|${query.id}`} query={query} impact={impact} />)}</div>
          {visibleCount < queries.length && <div className="stack-ux-show-more">
            <button className="stack-ux-more-button" type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              Show next {Math.min(PAGE_SIZE, queries.length - visibleCount)} queries ({visibleCount} of {queries.length} shown)
            </button>
          </div>}
        </> : <div className="stack-empty">No queries match this filter for {selectedPersona}.</div>}
    </section>

  </>;
});

export default function StackTraceImpact() {
  const [trace, setTrace] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trace.trim()) { setError("Paste a Salesforce Apex stack trace first."); return; }
    setLoading(true); setError(""); setResult(null);
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

  return <div className="stack-page" aria-busy={loading}>
    <form className="panel stack-form" onSubmit={analyze}>
      <div className="panel-heading"><div>
        <h2>Trace an Apex execution path</h2>
        <p>Paste the stack trace. We'll follow resolvable method calls and check SOQL access for configured personas.</p>
      </div><span className="mini-tag">Repository first · Salesforce fallback</span></div>
      <div className="form-field stack-input">
        <label htmlFor="stack-text">Apex stack trace</label>
        <textarea id="stack-text" spellCheck={false} rows={5} value={trace}
          onChange={(event) => { setTrace(event.target.value); setError(""); }}
          placeholder={SAMPLE} disabled={loading} />
      </div>
      <div className="stack-controls">
        <span>Starts at the first matching Class frame. Static SOQL only; branches may be considered reachable even if they do not run.</span>
        <button className="primary-button" type="submit" disabled={loading}>
          {loading ? "Analysing stack trace…" : "Run Stack Trace Analysis"}
        </button>
      </div>
      {error && <div className="error-card" role="alert">{error}</div>}
    </form>
    {result && <StackResults result={result} />}
    {loading && <StackTraceLoadingOverlay />}
  </div>;
}
