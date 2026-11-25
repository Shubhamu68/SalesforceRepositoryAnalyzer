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
- At the baseline commit, `apexMethodScanner.ts` attaches static queries using `extractSoqlQueries`; `StackTraceImpactService.ts` builds its own method index and traverses `resolveMethodCalls`. Shared discovery and permission evaluation do not establish dynamic-query evidence parity. Dynamic integration is deferred to [backlog #58](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/58) after the current engine is finalized. Preserve the shared engine boundaries now; do not change Stack Trace consumption in PR #57.

## Next increments, in order

### A — Caller and metadata context (P0; highest coverage investigation)

Investigate 16 uncovered runtime-input sites and five report/private-context sites using actual source and caller/configuration evidence. Prioritize explicit source-proven arguments or complete metadata, not arbitrary external inputs. Reuse the caller index, dependency slice, exact overload resolution, metadata boundary and shared expression/effect model. Unknown UI input, raw SELECT, field or WHERE strings stay unresolved when no proven context exists.

Target: at least two previously uncovered sites in two source locations if proof supports it; this is a proposed acceptance target, not a prediction. If no such cohort is proven after source investigation, choose another evidenced cohort rather than adding speculative grammar or retrying individual patterns. Existing partial variants may be improved separately without forcing the site REVIEW count down.

### B — Return and loop state (P1)

Review four return/path sites and three runtime-loop sites. Reuse shared statement/loop interpretation and conservative value/reference state. Preserve correlation across feasible branches, account for unknown mutations and early exits, and keep unknown runtime collection contents unknown. Do not union incompatible collections or raise execution budgets to make tests pass.

### C — Focused lower-volume gaps (P2)

Investigate malformed query reconstruction independently; never auto-repair a broken query. Retain constructor metadata and static/finish lifecycle capabilities as bounded work, each with one primary uncovered site in the snapshot. Extend only with source-backed evidence of benefit. The five configuration sites already have 73 conditional variants, so a remaining REVIEW alone is not a reason to expand their model. Field permission verification and the DEP0190 child-process warning are separate workstreams, not dynamic query coverage improvements.

### Deferred — Stack Trace dynamic engine integration (backlog #58)

Repository owner's scope decision, 2026-11-25: implement in a separate feature branch and PR after the current engine is finalized. Reuse the finalized persona-independent evidence contract, metadata scope and query/mode/coverage semantics; validate reachable-method filtering, static compatibility, and qualified evidence parity. See [issue #58](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/58) for detailed acceptance criteria. This is not a PR #57 merge gate. Existing Stack Trace regression tests still apply to changes touching shared foundations.

## Mandatory validation and stopping criteria

- Compile backend, run Windows and Ubuntu regression suites and frontend build. Include negative proof/effect/alias tests and preserve existing Stack Trace regression behavior; new dynamic cross-consumer parity is deferred.
- Compare same source snapshot, persona, org, metadata context and discovery policy. Preserve existing application query/finding identities wherever evidence permits. Compare full per-site/variant inventories rather than counts alone; the current workbook does not expose every query string. Explain legitimate deduplication and metadata changes. Investigate any removed baseline high finding; newly verified highs may be correct.
- Track new covered sites, existing covered sites, variants by evidence kind, review sites, permission finding identities and budget failures. No fabricated objects/fields/grants, no unjustified complete labels or hidden budget increases.
- For each increment, record the source-backed cohort, positive/negative tests, measurable acceptance outcome and live evidence. Stop a speculative thread after one targeted source investigation without a useful proof. No requirement for zero unresolved queries.
- Proposed performance gate: three comparable cold scans and one warm scan, with API counts/latency and local phase timings. Investigate sustained median wall-clock regression above 15% under comparable conditions; do not infer a regression from one noisy API run. No new budget failures in comparable live output.
- Validate live SOQL before merging PR #57 to the integration branch. Preserve existing Stack Trace automated regressions. New live dynamic Stack Trace integration/validation is explicitly deferred by the owner to issue #58. No direct merge to main.

This is an assessment and delivery-plan checkpoint, updated for the owner's explicit integration deferral; it does not change engine behavior. No application-source details from the workbook have been committed. Exact business source for some blocked sites is unavailable to the assessment; recover it before selecting a concrete language expansion.

## Engine increment A1 — incoming argument evidence (2026-11-25)

Verified source gaps in the analyzer: caller propagation discarded vectors whose arguments were all unknown even if a String held source-backed fragments; ordinary caller-context evidence rejected all non-static targets; private caller enumeration was case-sensitive although Apex identifiers are not. The new shared argument-evidence module retains useful fragments and allows only direct lexical private same-receiver argument edges (standalone/return calls, simple arguments, no receiver state transfer). The existing SOQL structural proof remains mandatory and the REVIEW remains for open/unproven contexts. No new interpreter, no budget increases, no Stack Trace integration.

Positive/negative generic fixtures cover multi-hop single partial String arguments, arbitrary structural strings, direct private instance calls, unknown receiver state, nested calls/effects and mixed-case caller closure. This targets the caller/runtime and private-helper diagnostic cohorts; the exact business caller source for the uncovered sites is not available, so neither two-site recovery nor any specific class improvement is guaranteed. Compare 246 files / 672 variants / 31 uncovered review sites / 314 unique findings / 820 raw findings against live output after CI. Preserve existing evidence; any newly uncovered baseline site or changed finding must be investigated. Counters: caller.fragment_only_contexts and caller.private_instance_argument_edges. Existing sampling priority is retained for vectors containing known values; fragment-only vectors consume only remaining per-site seed slots.

## Engine increment A1 corrective checkpoint — restore established seed ranking

Live validation of the initial A1 implementation reported 669 analyzed variants (24 known caller, down from 27; all other evidence categories unchanged), versus the accepted 672 baseline. All 314 finding identities and 820 raw findings were retained. The summary comparison localized the three lost variants to one bounded site with one known and 15 partially known contexts. Fragment-only context collection was exercised, but no new analyzed variants were observed. The leading hypothesis is the changed projection grouping of unknown values; the workbook does not contain selected seed identities, so causation is not established.

Restore the pre-A1 selectApexCallerSeeds implementation exactly: unknown fragments do not create distinct projected ranking groups. Keep actual values/fragments in the selected argument vectors. Factor the established-first / supplementary-fragment-only selection into a shared tested function. Preserve the eight-seed cap and all other budgets; keep private argument evidence and case-insensitive closure fixes. Regression fixtures cover a duplicate-heavy group competing with other known object names and fragment-only seeds consuming only remaining slots. No new language support or Stack Trace changes.

Acceptance: Windows/Ubuntu CI and same repository/org/persona live retest. Restore 672 analyzed variants, 27 known caller, 73 conditional, three partial, 569 complete, six known variants at the affected bounded site, all baseline findings and no new budget failures. If this one focused correction does not restore coverage, stop the A1 refinement and revert its implementation changes to the accepted engine baseline e72c334 (preserving the roadmap/backlog and history). Do not raise limits as a substitute for proof.
