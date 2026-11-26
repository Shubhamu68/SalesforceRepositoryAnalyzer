# SOQL Security Analysis — connected-org performance profiling

Related: [Issue #40](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/40) / PR #43.

## What has been optimized

- Apex scanning discovers folders with **bounded parallel directory reads** (16 workers) and checks file size/mtime/ctime on every run. Unchanged classes reuse their previously parsed SOQL; new, edited, deleted and same-size changed classes are detected. Cold scans also skip expensive text masking when a class cannot contain static bracketed SOQL.
- Local relationship metadata still reads **at most 12 field XML files concurrently per object**, applying relationships in the original order so overrides remain deterministic. Shared relationship/SOQL preparation is now exposed for the upcoming all-personas action, avoiding repeated work **inside one all-personas execution**.
- Fields with an explicit repository Read grant (or established schema-required Read) **do not need a current-org EntityParticle lookup** to establish the same positive FLS result. Fields without grants still go through the original live-org permissionability and effective-access checks. An object-wide metadata lookup may still be required for other fields, so reduced API traffic is **not guaranteed**.
- The UserFieldAccess compound-field helper builds one indexed Describe field map rather than recreating it for every field (quadratic to linear pass). SOQL query masking is reused across referenced fields. Org verification queue slots are handed to waiting requests without exceeding the configured concurrency limit.
- We deliberately do **not** cache repository XML across runs or reuse persona-specific access results across orgs.

## Run locally on Windows

Use the PR branch (save/stash local edits first):

```powershell
git fetch origin
git switch --track origin/perf/soql-analysis-profiling-and-io
# If already tracked: git switch perf/soql-analysis-profiling-and-io; git pull --ff-only
```

In the **backend** PowerShell terminal, before starting the API:

```powershell
$env:SALESFORCE_SOQL_PERF = "1"
npm run api
```

In a separate **frontend** terminal:

```powershell
cd web
npm run dev
```

Connect to the same Salesforce Sandbox, choose the **same persona** and **same local repository**, then run SOQL Security Analysis as normal. Copy only the lines beginning with `[SOQL Perf]`. No credentials, full SOQL text or user names should be included in those lines. To disable: close the backend terminal, restart without the environment variable.

## Meaning of stages

| Stage | What it measures |
| --- | --- |
| `total` | Backend end-to-end request, including org preflight and writing the workbook. Excludes browser rendering. |
| `api.preflight` | Confirm connected-org or repository-only analysis authorization |
| `api.runtime` | Load/reuse the analyzer runtime for the chosen repository and org |
| `repository.scan` | Discover/read Apex and extract SOQL |
| `permissions.resolve` | Resolve persona's Profile, PS and PSG metadata |
| `relationships.local` | Build repository relationship graph from XML |
| `relationships.org` | Any necessary Salesforce sObject Describe relationship hydration |
| `fields.inventory` | Build and group referenced fields |
| `execution.modes` | Resolve Apex API versions and query enforcement mode |
| `access.evaluate` | Object/field permission decisions, including org validation |
| `security.total` | Whole security evaluation, containing the phases above |
| `excel.total` | Workbook grouping, layout, serialization and disk write |
| `excel.grouping` | Group findings by object/field and references |
| `excel.serialization` | ExcelJS XLSX ZIP generation and disk write |
| `scanner.apex_files` | Number of Apex source files discovered |
| `scanner.discovery` | Concurrent recursive directory discovery |
| `scanner.stat_and_parse` | File fingerprint validation and parsing changed classes |
| `scanner.parsed_files`, `scanner.reused_files` | New/modified class parses versus validated cache reuse |
| `relationships.simple_queries` | Queries that safely skipped relationship pre-hydration parsing |
| `org.describe.cache_hits`, `org.describe.cache_misses`, `org.describe.inflight_hits` | Salesforce Describe cache behavior |
| `org.describe.http_requests`, `org.describe.uncached_cumulative_ms` | Actual Describe REST requests and overlapping cumulative latency |
| `org.field_metadata.cache_hits`, `org.field_metadata.cache_misses` | Metadata cache usage (object-scoped, not individual field requests) |
| `org.object_checks.cache_hits`, `org.field_checks.cache_hits` | Cached persona-specific object and field checks |
| `org.user_field_gateway.object_wide_queries`, `org.user_field_gateway.exact_queries` | Object-wide versus targeted field-access queries |
| `org.user_field_gateway.missing_row_fallbacks` | Missing object-wide rows that need an exact field query |
| `org.verification.queue_cumulative_ms`, `org.verification.queue_waits` | Wait time/number of queued checks (cumulative overlaps) |
| `org.verification.work_cumulative_ms` | Sum of verification work time while active (not wall time) |
| `relationships.field_xml` | Number of local field XML definitions read |
| `queries.analyzed`, `findings`, `inventory.*` | Size of this specific analysis |
| `org.queryAll.calls`, `org.queryAll.failures` | Salesforce SOQL queryAll invocations / exceptions |
| `org.access.calls`, `org.field_metadata.calls`, `org.persona_inventory.calls` | Fixed-category Salesforce query counts |
| `org.queryAll.cumulative_ms`, `org.queryAll.max_ms` | Sum and maximum queryAll duration (including paginated calls) |

**Important:** Multiple Salesforce queries execute concurrently; `org.queryAll.cumulative_ms` can **exceed** `total`. Do not add it to phase durations. Likewise, `security.total` contains several child phases and should not be added to them. The `org.*.cumulative_ms` values are not separate sequential phases.

## How to compare performance fairly

1. Run once after restarting the API (**cold**). Note `total`, `security.total`, `excel.total`, and `org.queryAll.calls`.
2. Without modifying files, persona, org or permissions, run **two more times** (**warm**).
3. Compare cold-to-cold and warm-to-warm across branches/releases. An earlier observation of approximately 60 seconds is **not** a controlled baseline; use it only as a rough reference.
4. Record the same query count, findings count and report content for correctness; compare criticality, affected Apex references, verification provenance and workbook structure.
5. If org calls dominate, the next optimization must be based on their actual type/count/latency; do not bypass OLS/FLS checks.
6. A simple estimate is `(old_seconds - new_seconds) / old_seconds * 100`, but only report a percentage from comparable runs.

The logs are opt-in and print only fixed stage/counter labels and durations. Do not share raw Salesforce CLI output, access tokens or full query responses.

## Original measured baseline correction

The original three persona runs on the older build were approximately **32s, 20s and 18s** using a stopwatch—not 60 seconds. A preliminary instrumented run on the new branch was 38.81s for one unspecified persona. Those observations are **not directly comparable**. We **do not** claim a percentage improvement until the same three personas are run under equivalent cold/warm conditions against both builds. Recording `findings`, `queries.analyzed` and the workbook rows helps validate parity.

## First versus repeated runs

- On the **first** execution, the Apex index has to be built and Salesforce caches start cold. Improvements here come from faster directory discovery, early rejection of classes without static SOQL, less per-field processing, and avoiding expensive quadratic compound-field preparation.
- On **subsequent** executions, stat-validated parsed Apex queries are reused. File edits, additions and removals trigger correct invalidation. Salesforce checks have their own independently scoped TTLs.
- The upcoming all-personas report can use `SoqlSecurityAnalyzer.prepare(queries)` once and `analyzePrepared(persona, prepared)` for each persona. This shares static SOQL/relationship work even during its **first button click**, while each persona still gets independent permission evaluation. This new feature is not implemented in Issue #40.

## Milestone optimization round — first slice

Branch: feature/soql-performance-optimization. Live reference: 90.790 s, 716 inventories, 1,835 fields, 829 raw findings, 312 grouped (7 High, 290 Low, 15 Unable to verify). 307 queryAll calls, 14 Field Set SOAP requests, 193 access calls. Independent Profile/PSG/User inventory reads overlap; no permission rules or metadata freshness windows change.

For a controlled experiment, restart the backend first with default concurrency (HTTP 4, verification 3), then repeat with:

```powershell
$env:SALESFORCE_SOQL_PERF = "1"
$env:SALESFORCE_HTTP_READ_CONCURRENCY = "6"
$env:SALESFORCE_VERIFICATION_CONCURRENCY = "5"
npm run api
```

Both settings are bounded to 1–8, invalid values fall back to defaults. They affect shared read gateways, not just SOQL. Compare cold and warm runs with the same org/repository/persona and actual representative user. Reject tuning if throttling, failures or permission outcomes regress. No speculative missing-row shortcut or stale metadata caching is introduced. The new workbook header records users from consumed verification evidence (including cached evidence); no separate user lookup is performed. If no user-level checks occurred, show that explicitly; if multiple users contributed, disclose all rather than claiming a single representative.

### Second slice: scan-local metadata batching

Only proven, already-requested dependency identities are grouped by the shared Apex engine, with a one-event-loop-turn coalescing window and the existing per-scan memoization. Field Set SOAP readMetadata accepts at most 10 full names ([Salesforce docs](https://developer.salesforce.com/docs/platform/api-metadata/references/crud-based-calls/meta-readmetadata.html)); Custom Labels use bounded groups of up to 20 ExternalString names. Each result is correlated by exact identity, never order. Missing, duplicate, malformed or failed results fall back to exact reads (including existing Tooling Field Set fallback). Capture stores individual successful dependency responses in the unchanged snapshot schema; offline replay still needs no connection. No mutable metadata reused between runs. New counters: org.field_set.soap.batch_calls, org.field_set.soap.batch_resolved, org.custom_label.batch_calls, org.custom_label.batch_resolved, apex.metadata.batch_groups, apex.metadata.batch_resolved, apex.metadata.batch_exact_fallbacks. Request counts are actual calls; batching effectiveness depends on discovery waves. Keep concurrency configuration identical to the prior experiment for comparison, not another simultaneous tuning change.

### Third slice: Custom Metadata projection consolidation

Only requests for the same CMDT and identical typed equality filters can share a union projection; distinct predicates retain exact Salesforce queries. Returned rows are projected back to the original field/filter shape and keep server-filtered evidence. Empty results remain complete; failed/incomplete union requests fall back to original reads. No local approximation of SOQL filters, no broad inventory scan, no cache across scans. Counters: org.custom_metadata.projection_batch_calls, projection_batch_resolved, projection_batch_failures. Request savings depend on the actual dependency identities and discovery timing.

### Fourth slice: dependency-validated warm Apex reuse

A normal connected scan records only the metadata dependencies actually read for each dynamic class, with SHA-256 digests of complete responses. On a later scan the whole repository graph and all source fingerprints must be unchanged (including the existing recent-edit safety window); each previous dependency is re-read through the new scan's shared provider and compared exactly before reusing query reconstruction results. Missing, incomplete or changed metadata triggers full class re-analysis. No permission decisions are cached by this mechanism. Existing schema/Describe provider freshness semantics remain unchanged. Capture, trace and offline replay deliberately run the full engine; set SALESFORCE_APEX_REUSE=0 to force a fresh analysis for parity measurements. Counters: scanner.dynamic_dependency_reuse_hits, scanner.dynamic_dependency_reuse_misses, scanner.dynamic_evaluated_files, apex.metadata.reuse_dependency_checks. Cold scans still perform full analysis. Scope and capability changes invalidate reuse.

### Fifth slice: opt-in UserFieldAccess exact-query Tooling Composite

All Personas baseline: 163.860 s, 16 personas, 716 queries, 2,164 queryAll calls, 2,118 access calls, 1,213 exact UserFieldAccess requests. CORE cold: 71.537 s; warm with fresh access checks: 19.981 s; fully cached warm: 5.799 / 6.162 s. The prior same-object IN batching remains disabled. Salesforce [Tooling Composite](https://developer.salesforce.com/docs/platform/api-tooling/guide/tooling-resources-composite-composite.html) supports up to five query subrequests per call. A short (8 ms) coalescing window collects independent exact queries across users/objects; each is still the same read-only equality SOQL, with reference-ID mapping and complete-page verification. Missing rows retain the original missing/compound path. Incomplete/failed/conflicting subresponses fall back to the original equality query; completely unproductive or failed batches temporarily disable the experiment for the current scope. Selection-epoch-aware gateway cache keys prevent reuse across org/session selection changes while permitting token refresh. No permission verdict or cache TTL changes. Enable only for controlled validation: `$env:SALESFORCE_USER_FIELD_COMPOSITE = "1"` before backend startup; remove it or set 0 for baseline. Counters: org.tooling_composite.calls / subqueries / complete_subqueries / cumulative_ms; org.user_field_gateway.composite_batches / composite_subqueries / composite_resolved / composite_exact_fallbacks / composite_failures / composite_unproductive. queryAll.calls and org.access.calls now count standalone queryAll calls, not logical subqueries; add composite HTTP calls to compare transport envelopes, and compare composite subqueries plus standalone exact calls to verify logical work is preserved. Reduced HTTP envelopes do not guarantee lower latency (Salesforce execution behavior matters). Compare fresh permission runs, not only cached warm runs. No claim of live compatibility until tested.

### Sixth slice: scheduling and duplicate-work isolation

Composite live results (797eb52): CORE 72.974 s cold, 6.018/6.609/6.221 s cached warm; All Personas 184.706/187.152 s vs 163.860 s earlier baseline. Composite subqueries all completed, but logical work increased (3,623 vs 3,349 verification misses). Keep Composite opt-in/off for the next scheduling benchmark. Shared VerificationReadCache separates in-flight work from completed TTL/LRU, never refreshes timestamps on hits or installs already-expired results. Existing 60-second age from initial request is unchanged. Same-user/object UserEntityAccess can be shared without sharing persona decisions; scope includes actual connected identity and selection epoch. Persona assignment inventory in-flight work is keyed by scope. New metrics: org.object_checks.inflight_hits, org.field_checks.inflight_hits, org.user_field_gateway.inflight_hits, org.user_object_gateway.cache_hits/cache_misses/inflight_hits, org.verification.started, org.http.attempts/queue_waits/queue_cumulative_ms/work_cumulative_ms, security.persona_workers. Defaults unchanged (logical 3, HTTP 4, personas 2); logical ceiling 16, HTTP ceiling 8, persona ceiling 4. First test logical 8 / HTTP 6 / personas 2 with Composite off; then logical 8 / HTTP 8 / personas 2; only then test personas 3 or logical 12 if HTTP is underutilized. Restart backend between configurations; compare same run order, cache conditions and verified users. No claims of speedup until live results.
