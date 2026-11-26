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
