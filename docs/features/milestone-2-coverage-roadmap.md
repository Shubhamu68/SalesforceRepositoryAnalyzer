# Milestone 2 — capability-led coverage roadmap

Assessment: 2026-11-25. Engine baseline: `388b3fc996faa8a31e8461d42637ca55340feea2`. PR #57 targets `feature/apex-static-analysis-engine`. This roadmap supersedes the sequence of individual class-driven constructor refinements; it does not invalidate the existing bounded engine proofs.

## Evidence baseline

A live summary workbook from the same clean repository inventory was inspected. Only one explanation cell changed relative to the preceding workbook (320 rows by eight columns). All reported finding identities, severities, occurrences, references and modes were retained. Both CI workflows for the engine baseline succeeded.

- 246 scanned Apex files; 173 dynamic invocation sites reported by backend instrumentation.
- 672 analyzed variants: 569 complete, 27 known caller, 73 conditional framework, 3 proven partial structure.
- 314 unique findings: 7 High, 255 Low, 52 Unable to verify; 820 raw findings.
- 51 dynamic query review sites across 19 classes; 20 sites have 103 analyzed variants (27/73/3), 31 have no reported analyzed variant. The remaining Unable to verify finding concerns field permission verification, not a dynamic query.
- 71.768 seconds total, 31.436 seconds repository scan, no execution-budget failures reported.

The following categories use the primary workbook diagnostic and are mutually exclusive for counting. They are not confirmed root causes or forecasts of recoverability. No proprietary class names, source code, query strings, record values or org metadata are included here.

| Diagnostic cohort | Sites | Already have variants | No reported variants |
|---|---:|---:|---:|
| Runtime input / caller evidence | 31 | 15 | 16 |
| Configuration / receiver state | 5 | 5 | 0 |
| Report configuration / private caller propagation | 5 | 0 | 5 |
| Return paths / state merging | 4 | 0 | 4 |
| Runtime collection loops | 3 | 0 | 3 |
| Constructor metadata initialization | 1 | 0 | 1 |
| Static collection / lifecycle state | 1 | 0 | 1 |
| Malformed reconstruction | 1 | 0 | 1 |
| Total | 51 | 20 | 31 |

## Architecture decision

Preserve shared type/symbol, expression, reference identity, metadata and bounded data-flow foundations. Avoid adding another pattern-specific interpreter unless a distinct safety domain genuinely requires one.

- `ApexAnalysisEngine` orchestrates generic invocation analysis and metadata reads; keep metadata request scopes and budgets.
- `ApexDataFlowEngine`, `ApexLoopEffects`, `ApexUnknownStateCompaction` own statement/path/loop interpretation and conservative state handling. Unknown-state compaction is not arbitrary value joining.
- `ApexRepositoryMethodIndex` owns caller/overload/receiver/context orchestration. Separate these responsibilities through tested interfaces incrementally, not via a rewrite.
- `ApexInstanceModel`, `ApexConstructorUtility`, `ApexPureFactory`, `ApexFrameworkReceiver`, `ApexMemberEffectModel` and `ApexStaticValueIndex` contain specialized bounded proofs. Converge toward reusable effect and invocation-context contracts, preserving existing proof boundaries, alias handling and rejection reasons. A known return value alone does not establish purity.
- `dynamicSoqlScanner` is the grammar-specific consumer: query parsing, mode validation and qualified coverage belong there, not in generic Apex execution.
- At the baseline commit, `apexMethodScanner.ts` attaches static queries using `extractSoqlQueries`; `StackTraceImpactService.ts` builds its own method index and traverses `resolveMethodCalls`. Shared discovery and permission evaluation do not establish dynamic-query evidence parity. Dynamic integration is an explicit milestone gate, not an already delivered capability.

## Next increments, in order

### A — Shared evidence contract and cross-consumer integration (P0)

Smallest useful slice: define one persona-independent query evidence contract carrying site identity, variant identity, normalized query, access mode, coverage category, diagnostic, and provenance; adapt existing SOQL evidence without altering its semantics. Demonstrate Stack Trace consumption using reachable-method filtering against the same repository snapshot and metadata scope. Implement in bounded increments; no language expansion mixed into the first contract slice.

Likely files: `src/models/SoqlQuery.ts`, `src/core/apex/ApexAnalysisEngine.ts`, `src/scanner/dynamicSoqlScanner.ts`, `src/scanner/apexSoqlScanner.ts`, `src/scanner/apexMethodScanner.ts`, `src/services/StackTraceImpactService.ts`, shared/stack regression tests. Confirm exact interfaces before changing them.

Acceptance: fixtures for static and complete dynamic queries, known caller, conditional and partial structural evidence, unresolved REVIEW; compare shared identities and modes between consumers. A stack trace narrows reachable methods; it does not establish observed query execution or convert conditional evidence to complete. Preserve existing static behaviour, permissions and evidence labels. Live Stack Trace validation required before milestone merge.

### B — Caller and metadata context (P1; highest coverage investigation)

Investigate 16 uncovered runtime-input sites and five report/private-context sites using actual source and caller/configuration evidence. Prioritize explicit source-proven arguments or complete metadata, not arbitrary external inputs. Reuse the caller index, dependency slice, exact overload resolution, metadata boundary and shared expression/effect model. Unknown UI input, raw SELECT, field or WHERE strings stay unresolved when no proven context exists.

Target: at least two previously uncovered sites in two source locations if proof supports it; this is a proposed acceptance target, not a prediction. If no such cohort is proven after source investigation, choose another evidenced cohort rather than adding speculative grammar or retrying individual patterns. Existing partial variants may be improved separately without forcing the site REVIEW count down.

### C — Return and loop state (P1)

Review four return/path sites and three runtime-loop sites. Reuse shared statement/loop interpretation and conservative value/reference state. Preserve correlation across feasible branches, account for unknown mutations and early exits, and keep unknown runtime collection contents unknown. Do not union incompatible collections or raise execution budgets to make tests pass.

### D — Focused lower-volume gaps (P2)

Investigate malformed query reconstruction independently; never auto-repair a broken query. Retain constructor metadata and static/finish lifecycle capabilities as bounded work, each with one primary uncovered site in the snapshot. Extend only with source-backed evidence of benefit. The five configuration sites already have 73 conditional variants, so a remaining REVIEW alone is not a reason to expand their model. Field permission verification and the DEP0190 child-process warning are separate workstreams, not dynamic query coverage improvements.

## Mandatory validation and stopping criteria

- Compile backend, run Windows and Ubuntu regression suites and frontend build. Include negative proof/effect/alias tests and cross-consumer parity.
- Compare same source snapshot, persona, org, metadata context and discovery policy. Preserve existing application query/finding identities wherever evidence permits. Compare full per-site/variant inventories rather than counts alone; the current workbook does not expose every query string. Explain legitimate deduplication and metadata changes. Investigate any removed baseline high finding; newly verified highs may be correct.
- Track new covered sites, existing covered sites, variants by evidence kind, review sites, permission finding identities and budget failures. No fabricated objects/fields/grants, no unjustified complete labels or hidden budget increases.
- For each increment, record the source-backed cohort, positive/negative tests, measurable acceptance outcome and live evidence. Stop a speculative thread after one targeted source investigation without a useful proof. No requirement for zero unresolved queries.
- Proposed performance gate: three comparable cold scans and one warm scan, with API counts/latency and local phase timings. Investigate sustained median wall-clock regression above 15% under comparable conditions; do not infer a regression from one noisy API run. No new budget failures in comparable live output.
- Validate live SOQL and Stack Trace before merging PR #57 to the integration branch, or record a user-approved deferral. No direct merge to main.

This is an assessment and delivery-plan checkpoint, not an engine feature implementation. No application-source details from the workbook have been committed. Exact business source for some blocked sites is unavailable to the assessment; recover it before selecting a concrete language expansion.
