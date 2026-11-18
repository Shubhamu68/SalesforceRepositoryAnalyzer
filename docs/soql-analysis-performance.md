# SOQL Security Analysis — connected-org performance profiling

Related: [Issue #40](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/40) / PR #43.

## What has been optimized

- Scanning Apex classes reads a **bounded batch of 12** files concurrently, preserving the original sorted query order.
- Loading local relationship metadata reads **at most 12 field XML files concurrently per object**, applying relationships in the original order so overrides remain deterministic.
- Fields with an explicit repository Read grant (or established schema-required Read) **do not need a current-org EntityParticle lookup** to establish the same positive FLS result. Fields without grants still go through the original live-org permissionability and effective-access checks.
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
| `scanner.apex_files` | Number of Apex source files scanned |
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
