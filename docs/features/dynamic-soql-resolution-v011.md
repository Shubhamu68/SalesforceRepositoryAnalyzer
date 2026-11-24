# Dynamic SOQL resolution v0.1.1 — approved architecture

Status: **Approved design rule, implementation in progress / not yet validated**  
Decision date: 2026-11-23  
Backlog: [#53](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/53)

## Objective

Resolve dynamic Apex SOQL queries, including metadata-driven and cross-method query construction, using shared Apex parsing and data-flow infrastructure so other Analyzer features (notably [missing SELECT-field analysis #20](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/20)) can reuse the same abstractions.

Keep current v0.1.0 static SOQL behavior and existing High/Low/Unable to verify Excel layout and rules.

## User-approved decision: exhaustive feasible variants

At each actual `Database.query*()` or supported dynamic SOQL execution site:

- **RESOLVED** only when **all feasible reachable complete query-structure variants** can be reconstructed and validated by the existing SOQL parser. A single execution site may yield several distinct valid queries. Run all through the unchanged existing security engine and deduplicate only truly identical variants.
- **UNRESOLVED** when any relevant reachable variant has unknown structure, incomplete metadata, unsupported Apex semantics, invalid/reconstruction-unverifiable SOQL, or exceeded analysis limits. Produce one existing-style **Unable to verify** finding with the precise source/dependency/reason. Do not produce partial field findings and do not claim that resolving one branch resolves a site.
- No **PARTIALLY_RESOLVED** public or internal status.
- Unknown bind *values* that do not affect SOQL structure can remain Apex bind placeholders; unknown object names, SELECT fields, ORDER BY expressions, WHERE clauses or pagination structure cannot.
- Preserve mutually exclusive conditional branches. **Never concatenate all branches together** as if they occurred on the same execution path.
- Model loop effects and repeated `+=` in statement order. A bounded variant enumeration / recursion budget is mandatory; hitting the budget => UNRESOLVED.
- Distinguish query execution mode from string reconstruction, including explicit `AccessLevel.USER_MODE/SYSTEM_MODE` and the existing class/API mode logic.
- Analysis must **not execute arbitrary Apex or business SOQL**. Metadata can be read through read-only Salesforce APIs when connected; use appropriate providers (SOQL for queryable Custom Metadata, Describe/Metadata API for other metadata).

## Reusable architecture (proposed contracts, not a requirement to create a file per class)

```text
Apex source -> Apex parser / program & symbol index
                   |
                   v
            On-demand backward slice
                   |
                   v
        Versioned variables + call-context dataflow
                   |
          +--------+------------------+
          |                           |
          v                           v
   Expression/collection         Metadata adapters
        evaluator                 (org/repo)
          |                           |
          +------------+--------------+
                       v
           Path-sensitive reconstruction
                       |
         +-------------+--------------+
         |                            |
     RESOLVED                    UNRESOLVED
      variants                       |
         |                    existing Unable to verify
         v                            |
  existing SOQL security analyzer    |
         |                            |
         +------------+---------------+
                      v
            existing Excel reporter
```

Shared foundation belongs to a SOQL-independent `core/apex` area. Metadata provider interfaces belong to `core/metadata`. SOQL-specific discovery/reconstruction/results belong to a separate feature module. The feature must be consumable without importing persona permissions or Excel generation into core parsing/evaluation.

### Query-site identity

Use immutable `file path + source span/offset + invocation ordinal` to identify an execution site and include variant identity for internal inventories. The current file+line-only association is insufficient when multiple calls/variants share a line. The Excel file does **not** gain new columns.

### Symbolic execution contract

- Index declarations, symbol binding scopes, method parameters/calls/returns, object fields and class state.
- Build dependency graph *on demand* from each query invocation, with versioned assignments (`q0`, `q1`, ...); reconstruct forward by source/execution order.
- Preserve branch feasibility. Enumerate feasible query-structure alternatives conservatively without needing runtime boolean values for a conditional whose branches are both known.
- Cache parse trees and context-equivalent helper summaries, not results for unrelated method arguments or class state.
- Track provenance/reason for unresolved dependencies, including missing metadata, dynamic UI parameter, unsupported Apex operation and path-budget exhaustion.
- Reuse existing test scanning/exclusion rules, static query parser, relationship resolver and persona OLS/FLS verifier.

### Metadata adapters

Read-only provider abstraction can resolve Field Sets, Custom Metadata, object fields/Describe, Apex constants and supported labels. Include org/repository identifier, snapshot or version, and completeness evidence. Where current configuration differs from repo or a complete snapshot cannot be established, do not report RESOLVED.

## Golden fixture matrix from user examples

| # | Pattern | Required evidence/behavior |
|---|---|---|
| 1 | Case Field Set + class variable | Helper call, Field Set metadata, method order/class state |
| 2 | OrderSummary mapping `__mdt` loop | Metadata records/filters, parameterized helper, `removeEnd` |
| 3 | Describe-driven history tracking | Object identity, complete field list, DELETE/normal variants |
| 4 | Opportunity datatable metadata | Filtered fields, `fields.isEmpty()` fallback |
| 5 | Generic related list UI inputs | Unknown structural runtime inputs => UNRESOLVED when not provably bounded |
| 6 | ContentVersion Set/label fields | Set mutations + `String.join(new List(...))` |
| 7 | Alternate Describe-driven history | Reuse example 3 capabilities, distinct call site |
| 8 | Ship-to Accounts | Known optional WHERE fragment variants |
| 9 | Product Price Header | Fixed SELECT, cross-method `whereClause`, deep relationship fields |
| 10 | OrderSummary/ODGS/OIS fields | List parameter joins, method calls, `escapeSingleQuotes`, relationships |
| 11 | Related list pagination | Schema-driven FORMAT, branches, LIMIT/OFFSET, explicit access level |
| 12 | Location literal | Inline `Database.query('SELECT ...')` with bind |
| 13 | Dynamic child object | Unknown object/field/where/sort input; USER_MODE handling |

Each fixture needs tests for exact known variants and unknown dependency outcomes, plus no static-query regression.

## Invariants / exit criteria

1. Current v0.1.0 static query inventory, findings, severity classification and Excel columns remain unchanged for the same repository and permission snapshot.
2. Comments/strings do not generate execution sites.
3. No skipped unresolved dynamic site and no implied success for unknown alternatives.
4. No same-line identity collision, no combining mutually exclusive branches, no fabricated fields from incomplete metadata.
5. Parse, graph and metadata inventory are prepared once and reused across personas where safe; permission decisions remain persona/user specific.
6. CI TypeScript build and full regression suite pass, and single/all-personas report behavior is checked before merging. Existing CI failures must be investigated rather than ignored.

## Non-goals in v0.1.1

- Implement missing SELECT-field feature #20 itself.
- Make strict persona matching changes #51 / #52.
- Execute production business queries to determine runtime values.
- Add a dynamic query summary tab or change user-visible Excel statuses.

## Implementation checkpoint — initial reusable engine (not release-ready)

The feature branch now includes:

- `src/core/apex/ApexSourceModel.ts`: shared source masking, source offsets, method index and structured block boundaries.
- `src/core/apex/ApexValueEvaluator.ts`: conservative symbolic text/numeric/List/Set values and supported string operations.
- `src/core/apex/ApexDataFlowEngine.ts`: bounded branch enumeration, ordered assignments, collection mutation, local helper-call summaries and source-offset execution-site capture.
- `src/scanner/dynamicSoqlScanner.ts`: translates **only exhaustively reconstructed** query variants to the existing `SoqlQuery` inventory; incomplete/unsupported sites become one review decision.
- Internal `queryVariantId` propagation through inventory, security analysis and deduplication to avoid same-line variant misattribution, with no Excel format changes.
- New regression suites for dynamic discovery and single/multi-variant construction.

**Do not interpret a successful code push as proof that this implementation handles all 13 supplied examples.** Live Salesforce **Describe-based complete field lists are now wired** where the object name is provable, using the read-only, org-scoped `SalesforceApexMetadataProvider`. A generic queryable Custom Metadata read method is available for reuse, but full `__mdt` utility-method interpretation, Field Sets, class-instance-state tracking and cross-class/caller-context tracing are **not yet wired**. These queries must remain UNRESOLVED instead of being guessed. An arbitrary `for` loop, complex `try/finally`, runtime `String.format` or unknown utility method is not a proven resolved query.

### Validation gate before merging

1. On a machine with the repository and dependencies installed: `npm run build` then `npm run test:all`.
2. Confirm static-only baseline is unchanged. Any additional dynamic findings belong to the new feature, not to static scanner regressions.
3. Confirm both single-persona and all-personas pipelines handle resolved variants; the latter intentionally only exports High rows, per its existing contract.
4. Add explicit unit/integration fixtures as metadata adapters and advanced call tracing become supported. Never mark the feature complete based solely on the simple literal/concat tests.
5. GitHub Actions on this repository have also failed on `main` in prior runs; do not assume a new workflow failure proves or disproves this code. Investigate build/test evidence separately.


## Report-driven follow-up corrections (2026-11-23)

The first real-world analyzer report exposed two systematic scanner defects and additional implementation limitations. Fixes and regression fixtures were added to the **same** feature branch:

- **Independent execution-site budgets:** source and method indexes are built once, but query evaluation now restricts work to each site's enclosing method and the prefix leading to that call. Exhaustion of one method/site cannot invalidate unrelated sites in the class. A query that itself exceeds the cap still reports one Unresolved finding.
- **Static locator exclusion:** bracketed SOQL supplied to `Database.getQueryLocator([SELECT ...])` remains exclusively in the existing static scanner; the dynamic scanner no longer emits a duplicate review.
- **Private helper caller context:** proven local field-list and scalar arguments are propagated through visible callers of explicitly private same-class helpers, enumerating all known complete variants. Public and external inputs without proven values are deliberately Unresolved.
- **Mutable collection guard:** passing a selected-field List/Set into an unsupported helper can mutate it. The engine now taints such collections rather than treating stale values as a complete SELECT field list.
- **Regression coverage:** synthetic tests exercise heavy unrelated methods, a genuinely over-budget query next to a valid one, bracketed static locators, multiple known private callers, a mixed known/unknown caller, collection joins, and unknown collection mutation. Fixtures intentionally avoid production data, IDs and customer-specific class names.

### Known limits

The real-world report was generated using an earlier feature commit; it has **not** been regenerated here against the user's private Apex repository. Therefore, improved unresolved counts are not claimed. Field Sets, arbitrary Custom Metadata utility methods, cross-class public caller chains, mutable instance fields and unrestricted UI inputs can remain Unresolved until their complete inputs are proven. A passing synthetic regression suite is not proof that every one of the 13 example patterns is resolved. Re-run the same repo/persona/org analysis and compare source locations, no duplicate static-query reviews, and unchanged confirmed permission findings before promotion.

## Stage 2 — repository-wide caller and helper evaluation (2026-11-23)

Implementation on `feature/v0.1.1-dynamic-soql-resolution`:

- `ApexRepositoryMethodIndex` indexes Apex declarations and **explicit class-qualified calls** across all non-test classes in the selected repository. It does not execute Apex, infer virtual dispatch, or treat names inside comments/strings as calls.
- Bounded cross-class helper-return evaluation propagates proven String, numeric, and identical complete List/Set values into the existing symbolic SOQL data-flow engine. Multiple proven text alternatives remain distinct variants; incompatible collection alternatives remain UNKNOWN.
- A separate bounded caller-probe evaluates literal/known arguments **at the lexical call site**, with source-order state and branch guards. Public/protected/global methods always remain potentially callable from outside the repository, so indexed callers are **evidence, not exhaustive coverage**. Unknown methods, unknown runtime arguments, ambiguous overloads, recursion or unsafe depth fail closed.
- The repository scan retains source buffers in the existing bounded cache and refreshes the shared caller graph when any indexed file is changed, added or deleted. Changed callers invalidate dependent callee query analyses even when the callee source is unchanged.
- Same-class List/Set-returning helpers now preserve identical complete values on every return path. Incompatible collection values are not incorrectly unioned. Dynamic queries continue through the same shared parser, permission engine, and existing Excel layout.
- Unresolved dynamic findings can include caller-provenance counts when a method has explicit indexed callers. **A successful caller probe does not mark a public query site RESOLVED.**

### Limitations and validation

1. `OMSQueryService.fetchOrderItemSummaries` and generic `queryRecords` accept structural inputs through public methods. Known repository callers can be identified, but without complete proof of all live/external entry paths these sites must remain UNRESOLVED when their query structure depends on these parameters. Never substitute an arbitrary default SELECT list or assume the repository contains every possible caller.
2. Member/instance dispatch, triggers/Flows/anonymous Apex as caller sources, arbitrary mutable class state, and unbounded method mutation are not fully modeled.
3. Custom Labels, Field Sets and Custom Metadata record-driven query construction remain Stage 3. A user-provided label JSON example is a test fixture, not authoritative live metadata; do not assume its values are current for another org.
4. The real repository and original 80-review Excel baseline must be rerun before claiming any change in the unresolved count. Check stable v0.1.0 static findings, the seven confirmed High cases and preserved USER_MODE/SYSTEM_MODE semantics.
5. CI covers cross-class constant/collection return propagation, known caller evidence, external-entry fail-closed behavior, recursive utilities, source cache invalidation, incompatible collection branches and previous Stage 1 regressions.


## Stage 2 hardening — complete private-context propagation and diagnostic safety

- A private helper's query site can now consume **exhaustively proven** caller argument contexts from the repository-wide method index instead of only producing a caller count. Local unqualified/this/class-qualified calls, nested private wrappers and source-order argument expressions are bounded and checked before any site is considered RESOLVED. Unknown incoming values, unrecognized receiver dispatch, recursion, ambiguous overloads and incomplete enumeration reject closed-world resolution.
- Public/protected/global Apex methods are **not** closed-world entry points: known repository callers can improve provenance, including known arguments forwarded through a private wrapper, but unknown org/external/UI callers still prevent a RESOLVED claim for structurally dependent queries. The external-entry restriction is unchanged.
- If repository-aware evaluation fails to capture a query inside a recognized method, the scanner retries the unsliced method conservatively and, if needed, recovers a more informative **source-local unresolved reason only**. This fallback never imports a query or verified variant from the source-only pass and preserves org-scoped Describe evidence where available.
- Synthetic regression fixtures now cover two distinct complete private caller variants, nested private wrappers, one known and one unknown caller, the externally callable public-query boundary, guarded fallback dynamic queries, ambiguous structural inputs and earlier Stage 1 branch-scope behavior.
- The first real-world validation target remains the Order Management Specialist Core report (519 analyzed, 79 Unable, seven High before this hardening). Confirm previously resolved cross-class helper sites, especially `CloseTransmittedSampleOrdersBatch:47`, and check that `ProductSelectorController:149,267` now expose source-dependency or precise unreachable-path reasons rather than the generic invocation message. Do **not** assume the new fixes eliminate all 26 public `OMSQueryService` reviews; those depend on runtime structural inputs and can legitimately remain Unable.
- Do not begin Stage 3 Custom Labels / Field Sets / Custom Metadata work until the owner validates stable High findings, no missing previously analyzed sites and no unexpected increase in Unable. PR #55 stays Draft.

## Stage 3 slice 1 — org-backed Custom Labels and JSON field maps

This first Stage 3 slice implements only the metadata-driven field-list path. It **does not** claim complete Custom Metadata or Field Set interpretation.

- Extend the optional read-only Apex metadata provider with `getCustomLabelValue(labelName)`. The live implementation queries `ExternalString` through the existing connected Salesforce Tooling API. Labels are scoped by org connection. Duplicate/missing names, inaccessible metadata, and locale-dependent translations are incomplete and fail closed. Results are fetched afresh when an analysis is rerun, so an edited org label cannot silently retain an obsolete verified query.
- Discover referenced `System.Label.*` dependencies, prefetch complete values before symbolic analysis, and feed them through the existing `resolveExternal` contract. No mock, supplied sample JSON, Apex execution, or source-code field substitution is used for live results.
- Parse `JSON.deserialize` into a bounded abstract nested map using native `JSON.parse` and explicit schema guards; support only known Map/collection/value operations, `map.get`, `map.keySet`, bounded `Map` construction and `containsKey`. Unsupported shapes remain unresolved.
- Index literal static Apex String constants from real source (e.g. object API names used as map keys), rejecting comments, method-local values and runtime expressions.
- Support direct `ObjectApiName.SObjectType.getDescribe().fields.getMap()` as well as the existing global Describe spelling through an authoritative complete Describe snapshot.
- Tests include Product2 / Authorized_Product__c fields from the supplied JSON **as a synthetic fixture only**, a resolved USER_MODE child-query variant, invalid/missing JSON and labels, changed label values without repository edits, Tooling API identity/translation safeguards, and field-map validation without org Describe.
- All normal static queries and existing OLS/FLS evaluation remain unchanged. A dynamic site is RESOLVED only if every feasible full SOQL variant is proven, parseable and within limits.

### Validation in the selected private org

Baseline before this slice: 519 analyzed queries, 79 unresolved, seven High, 237 Low for Order Management Specialist Core. Run with the same repository, connected org and persona. Inspect ProductSelectorController execution lines 129, 149, 224, 267, and 545 specifically. These are candidates, **not guaranteed resolutions**: runtime paths, Custom Metadata limits and unknown control flow may still block them. The five original sites must not disappear silently; either each is fully resolved and contributes its correct object/field findings, or retains a specific Unable-to-verify reason.

`OMSQueryService` public runtime field-list queries remain subject to the open-caller restriction. Four `OTCInvoiceController` Custom Metadata sites and `DynamicReportController` Field Set/report metadata sites are **not implemented by this slice**. Extend those in subsequent Stage 3 slices only after this source-level and real-repository comparison is validated. Keep PR #55 Draft.


## Stage 3 completed — implementation scope and Stage 4 handoff

The three metadata-backed analysis components are implemented on the current feature branch. They all reuse the existing \`ApexDataFlowEngine\`, \`ApexMetadataProvider\`, repository caller index, and SOQL parser/permission evaluator.

### Product Selector: Custom Labels and JSON map fields

- Read the exact referenced \`System.Label.*\` values from the connected org through read-only Tooling API \`ExternalString\`; reject missing/ambiguous names and locale-dependent translations.
- Parse nested JSON objects, iterate proven maps and collections, track source-level String constants only when their initializer is immutable/literal, and ignore comments embedded between Apex query fragments.
- A static mutable \`public static String\` is **not** a proven compile-time constant. When \`AdvantageConstants.PRODUCT_APINAME\` or another field is non-final or not present in the indexed repository, it remains unknown. The analyzer must not substitute the user's sample JSON or a guessed API name.
- Existing Product Selector methods may remain unresolved if a feasible path depends on runtime values or unmodeled operations. Source comment handling is corrected separately from metadata evaluation.

### OTC Invoice: Custom Metadata record-driven field lists

- Index source-local literal \`[SELECT fields FROM Object__mdt WHERE A = :knownValue AND B = true ...]\` iterators.
- Fetch a complete set of selected/filter fields through the existing read-only Salesforce data API; apply **all** supported equality predicates using proven literal/immutable source constants; reject unknown predicates, missing data, invalid field paths, oversized row sets and unsupported query shapes.
- Interpret bounded \`for (Metadata__mdt row : [SELECT ...])\` loops, typed row fields, and source-ordered \`Map.put()\`/query concatenations. Do not treat a dynamic WHERE filter or runtime input as a known mapping.
- Metadata records and dependent dynamic execution sites refresh on every connected-org analysis; cross-class helper dependencies cannot reuse stale dynamic SELECT lists.

### Field Sets: known object/name paths and field members

- Resolve \`Object.SObjectType.getDescribe().fieldSets.getMap().get('Known_Set')\`, \`.getFields()\`, \`FieldSetMember.getFieldPath()\`, and \`Utils.getFieldListFromFieldSet('Object','Known_Set')\` when both identifiers and all returned members are proven.
- Read ordered members through Tooling API when the complete \`Metadata.displayedFields\` inventory is exposed. When Tooling only exposes the FieldSet record, use the connected user's **read-only** Metadata SOAP \`readMetadata(FieldSet, Object.Set)\` as an optional fallback. No user permission changes or metadata writes are performed.
- If the connected user lacks the Metadata API permission, the Field Set contains unsupported data, or object/name originates from an unknown report configuration, the result is UNVERIFIED. DynamicReportController receives no guessed Field Set or report configuration.

### Stage 2 follow-up included

- Recover source-level SOQL expression values across line/block comments without damaging quoted strings.
- Distinguish unknown instance members (\`info.objectApiName\`) from indexed static Apex constants in diagnostics.
- Preserve complete known List/Map inventories only across supported mutations; unmodeled \`.remove()\`, \`.putAll()\`, etc., and potentially mutating helper calls taint the structural field inventory.
- Existing public/external Apex entry points, including \`OMSQueryService\`, remain open-world. Known repository callers alone do not prove all runtime query variants.

### Release/acceptance gate

Before merging PR #55, rerun the analyzer in the same private repository and org with the **Order Management Specialist Core** persona. The pre-Stage-3 baseline is 519 analyzed queries, 79 Unable to verify, seven High, and 237 Low findings. No category count reduction is guaranteed solely by source-level tests; some contexts are genuinely runtime-driven.

Check these sites against the previous Excel: ProductSelectorController:129,149,224,267,545; OTCInvoiceController:435,440,452,463; DynamicReportController:307,318,454,899,958; OMSQueryService:2453,3733; CloseTransmittedSampleOrdersBatch:47; and OrderSummaryEnrichmentBatch:64. Existing verified High findings and their permission classifications must not disappear.

The next planned engineering stage is **Stage 4: remaining provable runtime/caller variants, budget/path edge cases, full-repository security regression analysis, and final merge readiness**. Stage 3 metadata readers are feature-complete within the explicit bounded grammars above; new unsupported metadata patterns are labeled clearly and remain UNVERIFIED until separately designed and tested.

## Pre-Stage-4 correction: repository static initializer proof and control-flow diagnostics

- The repository-wide `ApexStaticValueIndex` now collects source-backed scalar static initializers at class scope and evaluates **bounded, cyclic-safe chains** of simple references, including `AdvantageConstants.PRODUCT_APINAME = Objects.PRODUCT` and local constant aliases. Pure scalar conversions such as `String.valueOf(knownNumber)` can participate. It never substitutes remembered or hardcoded values.
- `public/protected/global static` fields without `final` remain **UNKNOWN** even if their initializer looks literal: org execution can modify them outside the scanned repository. A private nonfinal static scalar is proven only when no lexical write is found in its declaring class. Cycles, ambiguous/missing classes, unsupported initializer expressions and null values all fail closed with explicit explanations.
- The indexing step uses comment/string-masked source boundaries and class-body depth. Local declarations, quoted pseudo-code and commented declarations are never imported as static field definitions. New tests cover chained aliases, nested expressions, public/private mutability, cycles, absent definitions and real query reconstruction using the synthetic Product2 pattern.
- `ApexExecutionPathDiagnostics` explains database calls recognized in source but not captured by bounded symbolic execution. Earlier loops that may change query symbols are noted when syntactically observable. This is **diagnostic-only**: it does not promote uncaptured queries into permission findings.
- **Critical validation limitation:** the four-class uploaded Apex archive does not include `AdvantageConstants.cls`. The real modifiers/initializers of `PRODUCT_APINAME`, `AUTHORIZED_PRODUCT_APINAME`, `TRX_SET_945` and `OTC_DRAFT_INVOICE_CREATION` therefore remain unverified in this development context. For real-repository acceptance, compare the next Excel against the 522-analyzed / 76-unverifiable / 7-High report, and inspect those constants' exact new provenance messages. A live mutable static field must not become a verified query simply to reduce the count.
- Stage 4 is **on hold** until the end-to-end repository report validates this correction, no prior High finding disappears, and the six previously degraded reconciliation explanations are checked against source. PR #55 remains Draft.
