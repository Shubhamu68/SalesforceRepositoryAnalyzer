# SOQL Security Analysis — connected-org performance profiling

Related: [Issue #40](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/40) / PR #43.

## What has been optimized

- Apex scanning discovers folders with **bounded parallel directory reads** (16 workers) and checks file size/mtime/ctime on every run. Unchanged classes reuse their previously parsed SOQL; new, edited, deleted and same-size changed classes are detected. Cold scans also skip expensive text masking when a class cannot contain static bracketed SOQL.
- Local relationship metadata still reads **at most 12 field XML files concurrently per object**, applying relationships in the original order so overrides remain deterministic. Shared relationship/SOQL preparation is now exposed for the upcoming all-personas action, avoiding repeated work **inside one all-personas execution**.
- Fields with an explicit repository Read grant (or established schema-required Read) **do not need a current-org EntityParticle lookup** to establish the same positive FLS result. Fields without grants still go through the original live-org permissionability and effective-access checks. An object-wide metadata lookup may still be required for other fields, so reduced API traffic is **not guaranteed**.
- The UserFieldAccess compound-field helper builds one indexed Describe field map rather than recreating it for every field (quadratic to linear pass). SOQL query masking is reused across referenced fields. Org verification queue slots are handed to waiting requests without exceeding the configured concurrency limit.
- We deliberately do **not** cache repository XML across runs or reuse persona-specific access results across orgs.

## Run locally on Windows

Production performance settings are compiled into the backend. No shell variables or local .env entries are required. The shared concurrency constants in `src/config/salesforceConcurrency.ts` are HTTP 6, permission verification 5, all-personas workers 2. Dependency-validated Apex reuse is automatic. Existing cache durations and metadata-validation safeguards are unchanged.

For a maintainer-only profiling session, temporarily change the internal `SOQL_PERFORMANCE_DIAGNOSTICS` constant in `src/services/SoqlPerformanceMetrics.ts` to `true` in a local working copy; do not commit that diagnostic change or distribute the diagnostic build. Start normally:

```powershell
npm run api
```

In a separate frontend terminal:

```powershell
cd web
npm run dev
```

Use the same org, persona and repository across comparisons. Copy only the fixed-label `[SOQL Perf]` lines. Restore the diagnostics constant to false before release. The previous performance environment variables no longer control the application.

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

The initial benchmark used HTTP 6 and verification 5; those values are now fixed in code. The shared gateways serve all analyzers, not only SOQL. The new workbook header records users from consumed verification evidence (including cached evidence); no separate user lookup is performed. If no user-level checks occurred, show that explicitly; if multiple users contributed, disclose all rather than claiming a single representative. No speculative missing-row shortcut or stale metadata caching is introduced.

### Second slice: scan-local metadata batching

Only proven, already-requested dependency identities are grouped by the shared Apex engine, with a one-event-loop-turn coalescing window and the existing per-scan memoization. Field Set SOAP readMetadata accepts at most 10 full names ([Salesforce docs](https://developer.salesforce.com/docs/platform/api-metadata/references/crud-based-calls/meta-readmetadata.html)); Custom Labels use bounded groups of up to 20 ExternalString names. Each result is correlated by exact identity, never order. Missing, duplicate, malformed or failed results fall back to exact reads (including existing Tooling Field Set fallback). Capture stores individual successful dependency responses in the unchanged snapshot schema; offline replay still needs no connection. No mutable metadata reused between runs. New counters: org.field_set.soap.batch_calls, org.field_set.soap.batch_resolved, org.custom_label.batch_calls, org.custom_label.batch_resolved, apex.metadata.batch_groups, apex.metadata.batch_resolved, apex.metadata.batch_exact_fallbacks. Request counts are actual calls; batching effectiveness depends on discovery waves. Keep concurrency configuration identical to the prior experiment for comparison, not another simultaneous tuning change.

### Third slice: Custom Metadata projection consolidation

Only requests for the same CMDT and identical typed equality filters can share a union projection; distinct predicates retain exact Salesforce queries. Returned rows are projected back to the original field/filter shape and keep server-filtered evidence. Empty results remain complete; failed/incomplete union requests fall back to original reads. No local approximation of SOQL filters, no broad inventory scan, no cache across scans. Counters: org.custom_metadata.projection_batch_calls, projection_batch_resolved, projection_batch_failures. Request savings depend on the actual dependency identities and discovery timing.

### Fourth slice: dependency-validated warm Apex reuse

A normal connected scan records only the metadata dependencies actually read for each dynamic class, with SHA-256 digests of complete responses. On a later scan the whole repository graph and all source fingerprints must be unchanged (including the existing recent-edit safety window); each previous dependency is re-read through the new scan's shared provider and compared exactly before reusing query reconstruction results. Missing, incomplete or changed metadata triggers full class re-analysis. No permission decisions are cached by this mechanism. Existing schema/Describe provider freshness semantics remain unchanged. Capture, trace and offline replay deliberately run the full engine; restarting the backend also provides a cold scan for parity measurements. Normal connected scans always use the validated reuse policy. Counters: scanner.dynamic_dependency_reuse_hits, scanner.dynamic_dependency_reuse_misses, scanner.dynamic_evaluated_files, apex.metadata.reuse_dependency_checks. Cold scans still perform full analysis. Scope and capability changes invalidate reuse.

## Release-owned defaults

The restored benchmark commit 650ea1f achieved CORE 71.537 s cold, 19.981 s warm with fresh verification, and 5.799 / 6.162 s with cached verification. All Personas was 163.860 s. Later Composite and scheduling experiments were reverted (903866d); they are not part of the release implementation. The production constants preserve the restored benchmark configuration automatically for CLI/API and packaged desktop backends. No .env template change, settings migration, or UI is needed. Normal diagnostics are off; the diagnostic wrapper can be explicitly enabled in tests or by a temporary source edit for a maintainer build. Performance is affected by org latency, cache freshness and machine load, and is not guaranteed to match benchmark durations.
