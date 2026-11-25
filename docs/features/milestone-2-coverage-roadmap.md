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

## SOQL permission-oriented direction — owner-approved 2026-11-25

Focus the new policy in the SOQL layer, not an increasingly general Apex interpreter. Resolve structural dependencies; abstract data-only typed values; aggregate permission references from feasible branches and proven callers while preserving object, relationship and clause usage and execution mode. Do not execute representative queries against Salesforce. Arbitrary UI-selected field names stay REVIEW; constructor metadata lifecycle deferred until the end; DynamicReportController configuration and malformed SOQL still require source investigation. Stack Trace integration remains #58.

First implementation is additive at uncovered dynamic sites: SOQL-only simple root permission aggregation, typed date/datetime/boolean/decimal/double placeholders, and a bounded local String builder proof using shared syntax and symbols. No Apex execution changes; no global budget increase. Validate individual literal ternary arms and optional WHERE/ORDER clauses independently, preserve SELECT vs WHERE evidence, reject unknown structural expressions and mode conflicts. Group known alternatives by object/mode. Representative text is synthetic parser input; retain the site REVIEW. Nested scopes, complex functions, arbitrary structural strings and unsupported mutations stay unproven. Existing complete and known-caller/framework variants are retained rather than deduplicated in this increment.

Recovered earlier business code demonstrated typed Date wrapper fields, literal optional predicates and trailing AND removal. Generic fixtures test this pattern without committing business source. The first live target is the OMSPatchHandler structural cohort; caller-return aggregation awaits a proof of independent structural alternatives, rather than accepting incomplete execution captures. Full helper control flow/caller provenance, immutable label-backed static cache (including normalized split/trim loop and date formatter), and explicit UI source classification remain follow-up work. Do not promise resolution of all 21 candidate sites. Compare per-site/object/field/mode evidence against 672 variants, 314 unique findings and 820 raw findings; do not lose baseline evidence.

CI hardening: initial broad known-capture fallback failed existing negative tests (unknown structural loops and Custom Metadata branches can expose a known zero-iteration query without proving the remaining field inventory). Remove that fallback instead of relaxing those tests. Restrict local builder ternary arms to individually validated complete SELECT-list or WHERE fragments; never combine correlated identifier parts. Exclude the exact indexed method token when checking the query variable's references (Database.query(query) is not two variable reads). Existing Apex interpreter and regression expectations remain unchanged.

### SOQL increment B — caller template evidence and reporting

Live first increment: 673 variants (+1 structural), 314 unique findings, 821 raw, 102 objects / 1812 unique fields; recovered OMSPatchHandler:116. Runtime 75.703s. One pre-existing path-budget regression expected zero queries for seven independently appended predicates; update it to require one parser-only inventory containing all nine SELECT/WHERE references while retaining the execution REVIEW.

Use already collected bounded caller vectors directly in the SOQL layer for simple literal/unchanged parameter/constant separator String.join templates. This does not raise the execution probe budget or generate a cross-product of arguments. Aggregate only groups with new clause-specific permission evidence; retain existing variant IDs and counts. Simple same-owner private literal-return helpers can contribute separate object/mode groups when the full return is unproven. Unknown structural arguments, mutation, unsupported control flow, nested scopes remain unresolved. Add explicit AGGREGATED_STRUCTURE permission evidence and count alongside PROVEN_PARTIAL_STRUCTURE; reports distinguish parser-only aggregate evidence from runtime reconstruction. Do not certify exhaustive permission coverage merely from a sampled context. Constructor and static label-cache work remain separate. No shared Apex interpreter changes.

### SOQL increment C — immutable label-backed field list

Recover only the source-proven local private static cache pattern: null guard, fresh List<String>, blank label guard, literal semicolon normalization, comma split, trim/nonblank append, return. No class names/label names hardcoded. Require private uninitialized cache, no external writes or mutable alias escapes; only same-owner local getter aliases consumed by inert size/isEmpty, String iteration or the selected read-only private query helper. Read authoritative label using the existing metadata resolver; reuse existing replace and split expression support. For an exact same-owner ISO GMT formatter of a source-typed Date with fixed midnight, abstract its output as a DateTime slot. Submit the proven label fields through the same SOQL caller-template aggregation. No simulation of batch lifecycle or assumption of static persistence. Test mutation, unknown alias, wrong date type and public cache rejection. Recovered older source motivates the pattern but the current repository must be retested.

### SOQL backward dependency increment — source evidence instead of execution samples

Accepted live checkpoint 05cadc7: 674 analyzed (569 complete / 27 known caller / 73 conditional framework / 5 partial), 2 aggregate inventories, 102 objects, 1813 unique fields, 822 raw and 314 unique findings. 29 uncovered review sites. Both CI workflows passed. The owner requested recursive backward tracing across variable definitions, arguments, callers, List/Set operations, conditional clauses and report configuration. The source caller index now exposes read-only exact caller edges to the SOQL consumer. No change to Apex execution, sample selection, or existing permission rules.

SOQL-only fallback, initially at sites without any existing usable variants: trace the relevant expression to preceding lexical declaration, supported writes, then the exact incoming caller argument. Follow up to six caller levels with a 64-edge/row and 2400-operation bound; preserve each caller vector and metadata row, never combine unrelated objects and fields. Aggregate add-only List/Set fields, known enhanced-for iterables and independently validated optional predicates; source-typed data-only scalar and quoted String.escapeSingleQuotes markers are parser evidence only (not proof of injection safety). Unknown UI strings, arbitrary structural holes, unsupported mutations, aliases, unresolved loops, dynamic dispatch and missing metadata remain REVIEW. Authoritative bounded getInstance candidate rows are read via existing metadata resolver only when the metadata record type and direct member use are source-proven; preserve record correlation and do not broaden the generic Apex exact-filter model. Preserve baseline variants; newly aggregated queries must survive the existing parser, relationship and mode checks.

Five exact business classes are still unavailable in supplied sources. New generic fixtures exercise multi-hop caller filters, conditional collection additions and finite loops, caller-object correlation, unknown input negatives, and metadata row correlation. Actual site recovery is unverified; do not claim all six problems are closed. Switch-return proof is a separate narrowly scoped extension; frontend caller interpretation and constructor lifecycle remain deferred.

CI hardening: the first source-only tracer passed the new fixtures but violated two prior negative tests. Restrict source caller edges to standalone/direct-return/simple-assignment statements, rejecting condition/header and short-circuited calls. Reject unknown existence-check guards such as Describe map.containsKey rather than assume fields are valid. Preserve correlation by selecting one metadata row per originating expression even when later projections differ. Permit only scalar reads of a proven configuration record, track latest unconditional String assignment, direct label splits and comma-delimited SELECT fragments. Extend literal helper proof with scalar switch cases parsed using shared source boundaries, all arms explicitly returning; unknown returns/dispatch remain REVIEW. No existing test expectations relaxed.

### Shared engine boundary refactor

Owner requested project-wide separation of reusable Apex understanding from SOQL-only permission interpretation for future DML. Extract the generic backward traversal, literal returns, caller String templates, label-backed cache provenance, typed source proofs and API-version metadata to core/apex. Consumer policy callbacks own SOQL grammar-specific placeholders/annotations/conditional merges. All backward outputs are SOURCE_CANDIDATES; do not treat a synthetic inventory or union collection as an exact execution value. No new query resolution patterns, no widened budgets, no change to existing permission outcomes. Rename generic metrics to apex.backward.*. Add core-only fixtures and a dependency boundary test. See docs/architecture.md for the audit and deliberate Stack Trace / write-policy deferrals. Compare same-repo/persona/org output at the pre-refactor head 2ac09d7 once a live run is available; the last live-validated checkpoint is 05cadc7 (674 variants, 1813 fields, 314 unique and 822 raw findings). CI passing on 2ac09d7 does not establish its live output.

Audit follow-up: consolidate identical Stack Trace lexer/offset utilities with shared source model, generic Apex operand boundaries and invocation diagnostics, API default/AccessLevel parsing, and CRUD privilege contracts that previously lived in the Matrix feature result. Preserve exported compatibility names, all SOQL descriptions and report/API schemas; no Stack Trace reachability or operation-specific permission changes. Keep SOQL bind positioning and enforcement in the SOQL adapter.

### Diagnostic checkpoint after shared architecture validation

Live 211108f: 674 variants / 5 partial / 2 aggregate / 1813 fields / 822 raw findings / 314 unique findings; 14 backward caller edges, 63.239s wall time. No additional live coverage from the recursive tracer. Next increment is instrumentation only: trace source candidate lifecycle and final SOQL acceptance for every unresolved site, preserving existing evidence and budgets. Inspect actual blockers before extending further. Run with SALESFORCE_SOQL_TRACE=1; share final BEGIN/END block plus performance counters and summary report. No claims of new coverage until tested.
