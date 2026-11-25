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

## Source verification from uploaded AdvantageConstants.cls (November 24, 2026)

The actual class was inspected, not inferred from sample JSON. Its declarations establish:

| Field | Apex declaration | Initializer | Static analysis |
| --- | --- | --- | --- |
| PRODUCT_APINAME (line 505) | `public static String` | `Product2` | **Unverified runtime value:** publicly writable |
| AUTHORIZED_PRODUCT_APINAME (line 504) | `public static String` | `Authorized_Product__c` | **Unverified runtime value:** publicly writable |
| BILL_ONLY (line 322) | `public static String` | `Bill Only` | **Unverified runtime value:** publicly writable |
| ORDER_SUMMARY (line 346) | `public static String` | `OrderSummary` | **Unverified runtime value:** publicly writable |
| ORDER_DELIVERY_GROUP_SUMMARY (line 349) | `public static String` | `OrderDeliveryGroupSummary` | **Unverified runtime value:** publicly writable |
| TRX_SET_945 (line 664) | `public static final String` | `945` | Proven scalar |
| OTC_DRAFT_INVOICE_CREATION (line 665) | `public static final String` | `OTC Draft Invoice Creation` | Proven scalar |
| SHIPMENT (line 695), SHIPMENT_LINE (line 694) | `public static final String` | Object API names | Proven scalars |
| INVOICE (line 666), INVOICELINE (line 667) | `public static final String` | Object API names | Proven scalars |

This **explains** the ProductSelectorController map-key errors: the metadata label itself might be entirely readable, while its field map still uses publicly mutable static keys. The analyzer must not silently replace those keys with initializer values and mark query structure proven. The 4 OTCInvoiceController query expressions also depend on a separate private-helper caller-context problem; resolving final 945/type filters alone cannot fix that. Two OTC source-object branches use mutable ORDER_SUMMARY/ORDER_DELIVERY_GROUP_SUMMARY constants, unlike the Shipment/ShipmentLine branches.

The reusable evaluator now carries the exact source-backed constant-rejection reason through Map initializer keys and condition comparisons, rather than emitting only "unproven key." Regression fixtures use the **exact relevant declarations** from the uploaded class.

If these declarations are *intended* as invariants, changing their Apex modifiers to `public static final String` could make them provable, **but do not change production Apex without scanning every writer across the complete repository, impact-testing tests/integrations, and deploying it through normal change controls.** This analyzer does not automatically modify production Apex. Treat runtime mutability as a legitimate unresolved finding unless immutability is proven.

The requested `Utils.cls` and a real-repository rerun are still necessary to close the remaining Field Set and helper-path cases. Keep Stage 4 on hold.

## General Apex declaration and scope support

The value resolver recognizes scalar String/Integer/Long/Decimal/Double/Boolean/Id member declarations at class scope from the actual source, case-insensitive primitive types, and flexible modifier order. Modifier order does not supply the security proof. public static final String, private static final String, final static String, global STATIC FINAL STRING, and default static final String qualify only when their initializer chain is completely proven. @TestVisible private static without final is treated as externally mutable.

### Declarations and safe resolution

| Apex declaration | Class.FIELD | Instance/same-method |
| --- | --- | --- |
| public static final String FIELD = 'Name'; | Proven after initializer proof | Unqualified FIELD inside the declaring class |
| private static final String FIELD = 'Name'; | Proven from owning source class | Proven in owning class |
| public static String FIELD = 'Name'; | UNKNOWN, externally mutable | UNKNOWN without complete path-specific proof |
| private static String FIELD = 'Name'; | Proven only without local writes and @TestVisible exposure | Same |
| private final String FIELD = 'Name'; | UNKNOWN: instance field, not a class constant | Can resolve this.FIELD or unqualified FIELD in instance methods |
| public final String FIELD = 'Name'; | UNKNOWN: instance field | Can resolve in a known instance method |
| final String FIELD = 'Name'; in a method | Not a class member | Tracked as local; shadows class member |
| public static final String FIELD; | UNKNOWN: needs static initializer proof | UNKNOWN |
| private final String FIELD; | UNKNOWN: instance member | UNKNOWN: constructor/initializer-block assignment may vary |
| final List<String> FIELD = ... | Not a scalar constant | Collection contents can change despite final reference |

Member lookup uses the source method's static/instance classification, the central repository index, and the same query security pipeline. Static methods cannot use this.FIELD. A method-local variable or parameter takes precedence over a class member.

Recognition of a declaration does not imply its runtime value is proven. Instance-field reads through arbitrary object references, constructor-assigned final fields, static initializer blocks, properties/getters, inherited members, incomplete repositories, reflection, and mutable runtime fields remain unproven without dedicated object and control-flow analysis.

Regression tests: tests/apexStaticValueIndex.test.ts (modifier matrix, scope, @TestVisible, blank fields, mutations, cycles) and tests/dynamicSoqlIntegration.test.ts (end-to-end static, final instance and shadowed local SOQL construction).

## Revised value-certainty policy — declared initializer snapshot

**This policy supersedes the earlier mutability restrictions above.** At the user's direction, a class-level scalar field with an evaluable declaration initializer is treated as fixed at its repository-declared value, regardless of final, static-field visibility, TestVisible or possible later reassignment. No class-name whitelist or hardcoded object names are used. This is a deliberate repository-analysis assumption, not a statement of Apex runtime immutability.

- Class-qualified static scalar references and valid this/unqualified instance scalar references use the same policy. Constant aliases and supported scalar expressions are evaluated recursively.
- Missing, null, ambiguous, cyclic, or unsupported initializers remain unresolved. Static and instance scoping is retained. Constructor-only initialization, arbitrary instance objects, collection members, and unsupported metadata/runtime inputs remain separate analysis cases.
- Method-local assignment and query construction still follow the actual tracked execution path; the snapshot policy does not freeze local variables or their collections.
- The analyzer does not reject a declaration initializer merely because repository code might subsequently write to the field. As an intentional trade-off, later writes can produce runtime query variants not represented by the snapshot. Reports disclose this limitation, including the all-personas High report. This policy does not relax OLS/FLS or change permission grants.

Regression fixtures use the actual nonfinal PRODUCT_APINAME and AUTHORIZED_PRODUCT_APINAME declarations, the nested Product Selector JSON mapping pipeline, mutable and final aliases in unrelated classes, the OTC mapping names, and local reassignment. Re-run the full repository with the same persona/org against the 522 analyzed / 76 unresolved baseline; check individual sites and preserve existing permission findings. Stage 4 remains on hold until this validation.

## Collection initializer snapshots and metadata dependency discovery (P1/P2)

This extends the declared-initializer snapshot policy to initialized List, Set and Map members, including nested maps and string collection aliases, without a class-name whitelist. Static/member scope is preserved, and missing, null, cyclic, oversized or unsupported values remain unknown. The supported abstract collection shape is a string-valued list/set or a map with scalar keys and supported nested values; arbitrary Apex objects and constructor-only assignments are not implied. In a method frame, modeled collection operations (add, addAll, clear, known-index List.remove, known-element Set.remove, Map.put/remove/putAll) update the frame and tracked aliases without changing the shared repository cache. Unknown mutators remain unknown. Arbitrary object aliases and escaping/interprocedural side effects are not fully modeled.

For live org metadata, query reconstruction now discovers referenced Custom Labels, known Field Sets and Describe object identities on demand through helper evaluation, including class-level label-backed initializers. The scanner deduplicates reads across files within a scan, uses fresh metadata between scans and evaluates again with a fresh resolver identity after each batch of discovered values (bounded at five passes and per-source read limits). Existing source-local Custom Metadata row support is unchanged. Missing/ambiguous/locale-dependent metadata still does not supply invented field names. Unknown input causes are retained through JSON.deserialize, Map.keySet/get and loop/collection diagnostics.

Acceptance: class-level collection and cross-class label nested-loop integration fixtures, update a label between scans, simulate metadata permission failure, retain all previously supported regression cases. Real-repository validation remains separate: compare against 523 analyzed / 75 unresolved / 7 High findings; inspect ProductSelectorController 129, 149, 224, 267 and 545 plus class collection cases. Do not interpret fixture success as a verified improvement in the user's live org. Constructor tracking, private-helper context, arbitrary object flow, unsupported loop control flow and broader CMDT cross-class discovery remain deferred.

## Master Custom Labels and invocation-scoped Custom Metadata

Supersedes the earlier mandatory translation check and source-local CMDT preloading. The live provider reads the uniquely identified master Custom Label Value from ExternalString via Tooling API only. ExternalStringLocalization is not required; translated values are outside the repository snapshot analysis policy. Missing, ambiguous and failed label reads remain unresolved.

Custom Metadata SELECT expressions are evaluated in the actual lexical method environment. A helper returning a static CMDT query can now resolve known scalar parameters, local variables and class-level values in equality/AND predicates; each invocation filters a complete inventory independently. Source type and selected/filter fields must be valid, and unsupported predicates and unknown binds remain unresolved. Inventory reads use the existing read-only Data API provider, are deduplicated per type/field projection within a scan, and are refreshed in subsequent scans. Field casing is normalized when consuming Salesforce responses. Unmatched records do not invalidate selected-field values merely because an unrelated row has null fields. Matching records must still contain supported values and valid field paths. No arbitrary Apex execution, unfiltered substitution for unknown binds, or org writes occur. The existing metadata discovery and matching-row limits remain in place.

Acceptance: master-label-only retrieval when localization is unavailable; same metadata helper used by two callers with distinct known EDI codes; case-insensitive field names; inactive and mismatching rows excluded; fresh inventories after changes; unknown filters and unsupported OR remain unresolved. This targets the 9 label and 11 CMDT primary-blocker sites in the latest 523 analyzed / 75 unresolved / 7 High workbook. Actual recovery is not yet verified. Constructor, wrapper, private execution-context and operation-budget work remains deferred.

## Filtered CMDT retrieval and shared read transport

Supersedes whole-type inventory retrieval. Proven equality filters are passed through ApexMetadataProvider to the live Salesforce Data API with validated identifiers and escaped, typed scalar literals. String, number and known Boolean values remain distinct. No LIMIT silently truncates a successful result. The cache identity includes object, selected field set and sorted typed equality filters; identical requests share a read per analysis, different filter contexts do not. The local completeness checks remain as a defensive validation layer. Unknown filters stay unresolved, and no unfiltered fallback is attempted.

The SalesforceOrgConnection read-only request gateway limits concurrent query/Describe/Field Set reads to four per connection; each attempt retains the 20-second timeout. Transient transport failures and selected transient HTTP statuses have up to two retries with backoff; invalid SOQL, denied permissions and other permanent errors are not retried (existing session refresh remains separate). Long Retry-After delays return the actual response instead of blocking the analysis. Transport diagnostics use a sanitized error code, request context, attempt count and elapsed time, not tokens or request URLs. Queued and retried reads verify the selected org epoch before proceeding. CLI authentication is unchanged. The 274 total/51 matching CMDT counts from the user's console are evidence that the query is valid and the inventory is modest, not proof of the actual analyzer HTTP failure.

Baseline for acceptance: 559 analyzed, 69 unresolved, 7 High; specifically inspect 11 CMDT-related sites. Live-org improvement is not yet verified. No constructor, private-helper or operation-budget expansion is part of this iteration.

## Bounded execution optimization and malformed-query evidence

The execution engine now uses independent core modules for conservative root-method scalar liveness, alias-aware state identity, and operation/path budget accounting. Dead scalar locals may be removed only at method-root statement boundaries after their last lexical reference; fields, parameters, mutable collections, and loop-carried symbols are not projected. Known foreach loops clean up explicitly declared iteration locals and stop promptly when a budget is exhausted. State deduplication preserves mutable alias topology, so equal-but-independent Lists/Maps are not conflated with shared references. Existing 5,000 operation, 32 path, depth and loop-size limits remain unchanged. Budget diagnostics distinguish operation exhaustion from path explosion and include the method/offset and counts. No arbitrary execution or unconditional budget increase is introduced.

Malformed reconstructed SOQL remains unresolved and receives a bounded preview of its actual punctuation and structure (quoted literal contents masked). This is diagnostic evidence, never an automatic comma cleanup or parser bypass. The latest live workbook establishes 569 analyzed queries, 59 unresolved, seven High; 11 budget failures and three parse failures are primary targets. The supplied business-source archive does not contain CreditOrderService, OTCCreditInvoiceController, or ShipmentReconciliationHelper. Their specific syntax/control-flow root causes are not yet verified and need exact source or the new structural diagnostics. No production Apex changes were made.


## Shared Apex analysis session (P0) and metadata-driven execution refinement

`core/apex/ApexAnalysisEngine.ts` now provides a scan-scoped session. It owns metadata dependency discovery, bounded resolution passes, read deduplication and repository resolver assembly. The SOQL scanner no longer owns this orchestration. New consumers can use `analyzeInvocations(source, filePath, select)` with a qualified invocation selector and consumer-chosen argument indices, or the generic `analyze(filePath, consumer)` entry point. The returned invocation evidence contains source offsets, selected abstract argument values, failures and proven skipped invocations. The SOQL-specific adapter retains its query parsing, security-mode interpretation and reporting responsibilities. Legacy query/access-level aliases remain temporarily for compatibility. Stack Trace integration and broader full-language support are still Stage 4 work; the interface is not a complete Apex compiler or whole-program execution proof.

* Complete live Custom Metadata responses now carry explicit SERVER_FILTERED evidence. The engine trusts the exact server-executed predicates, including Salesforce-specific blank/null representation, while retaining schema/completeness/row-limit validation. Providers without that evidence retain defensive local predicate evaluation. Unknown filter binds remain unresolved.
* String-valued List/Set membership is evaluated centrally, preserving case-sensitive membership and unknown operands. Ternary expressions and invocation reachability share balanced source structure; provable pure guards skip the inactive branch, and unknown/side-effecting guards remain conservative. No malformed query is automatically repaired.
* Direct throws terminate supported normal paths. Caught exception continuation is not fully modeled; when it cannot be established, values remain unknown. Full exception transfer, finally blocks and arbitrary conditional side effects are deferred. The original budget limits are unchanged.
* Invocation dependency slicing is reusable and includes loop-carried dependency closure, and pruned nodes bypass redundant per-state processing.

The actual supplied Apex and exported metadata were inspected locally: 76 blank-code credit order rows, 60 blank-code OTC credit invoice rows, 36 shipment rows, including 13 shipment item mappings with 12 unique source fields. The regression suite uses synthetic structural equivalents of those cardinalities, not the customer source or customer metadata. Expected real root SELECT counts for follow-up comparison: CreditOrderService 61/62/63 = 45/18/19; OTCCreditInvoiceController 219/223 = 36/31; ShipmentReconciliationHelper 142/147/152 = 10/12/14. Counts exclude nested subquery projections. These are expected from the supplied source/export, not yet verified reconstructed live query results. Exact org response representation and all remaining live failures require the user's rerun. Baseline: 569 analyzed, 59 unresolved, 7 High.


## Pre-Stage-4 caller and instance analysis refinement

The shared core now supports bounded multi-hop incoming argument evidence for unique explicit static method calls, including same-class unqualified calls. Known contexts are kept separate from open-entry coverage. Public/protected/global callers can still receive unknown external inputs: finding repository call sites never establishes exhaustive coverage. `inspectApexInvocationContexts` exposes known argument variants for consumers. The SOQL adapter includes the number of structurally valid variants in unresolved diagnostics, without publishing them as complete permission-analysis results. Traversal is capped at six hops, 64 caller contexts/work probes and eight invocation seeds; per-context operations are bounded. Ambiguous overloads, instance dispatch and recursion remain conservative.

`ApexInstanceModel.ts` indexes source-defined classes, including supported nested wrappers, and creates distinct abstract instances with scalar instance fields. It interprets declaration initializers and straight-line instance initializer blocks in source order, then a uniquely selected constructor with proven arguments. Explicit member reads/writes and direct aliases share abstract state; separate allocations remain independent. Unknown effects invalidate known references. Inheritance, properties, arbitrary constructor helper calls, static initialization blocks, polymorphic instance calls, object return/heap transfer and arbitrary collections of objects remain outside this first supported domain. In particular, a constructor-dependent field on an externally constructed receiver cannot be guessed from a source declaration.

Target-prefix root-scalar liveness excludes locals whose only remaining uses occur after the invocation's complete containing statement/block. Member writes and alias dependencies remain in the slice. Existing path and operation ceilings have not been increased.

Synthetic regression tests in `tests/apexCallerInstanceFlow.test.ts` exercise multi-hop contexts, open external entries, nested wrappers, independent allocations, alias writes, initializer order, unknown effects and bounded path reduction. No business-specific classes or mapping fields are embedded. Live baseline before this slice: 575 analyzed, 53 unable to verify, 7 High; actual coverage and runtime cost must be established on the same repository/org/persona after CI. This is a bounded pre-Stage-4 refinement, not a claim that all remaining sites have been resolved.


## Iterative language refinement: scalar semantics and caller-variant coverage

`ApexScalarOperators.ts` centralizes typed null comparisons, bounded numeric comparisons/arithmetic and operator splitting/precedence. A null literal is distinct from the string "null", empty text and an unknown value. Supported Boolean guards short-circuit; static String blank/empty tests handle null; scalar concatenation and += share the same operation. The pagination regression fixture reproduces the null checks and positive/nonnegative integer conditions from the reviewed service method. Arithmetic is intentionally bounded to exact signed Integer-range operations (division only where the quotient is integral); full Decimal/Long type promotion, precision, locale-sensitive String/Id distinctions, null concatenation, safe navigation and arbitrary operators are not claimed. Custom Metadata null filters remain unsupported rather than changing the authoritative server-filter contract.

Known explicit caller contexts and partially known contexts are propagated separately from exhaustive coverage. Unknown parameters that are not needed to reconstruct a SELECT (for example, a record-ID bind) need not invalidate the known query structure. The shared engine probes complete selected invocation arguments; the SOQL adapter accepts only structurally parsed SELECT variants with established access mode. These variants carry `coverage: "KNOWN_CALLER_CONTEXT"` and distinct variant IDs and enter the existing security analyzer. The original unresolved site remains a REVIEW; variant-level findings explicitly state their limited scope. The queries-analyzed count can now increase even when the unresolved-site count does not decrease. This is not permission proof for every caller, and no unknown structural fragments or unknown access-mode expressions are fabricated. Traversal and sample ceilings remain bounded.

Completed normal-path returns/throws now share a terminal marker for state deduplication; return values and captured invocation evidence remain separate. The path budget measures live states, not obsolete environments for completed exits. The existing 32-path and 5,000-operation ceilings remain unchanged. This is a targeted optimization, not a general heap/control-flow join or exception-transfer model.

Tests cover null vs literal text, guarded pagination, precedence/overflow, known caller variants with unrelated runtime parameters, explicit user mode, unknown structural inputs, retention of unresolved reviews and terminal-path consolidation. Earlier integration assertions have been revised to distinguish a partial variant from complete site resolution, rather than suppressing otherwise valid query evidence.

Live validation baseline: 575 analyzed variants, 53 unresolved sites, 8 budget failures, 7 High, 250 Low. Compare actual caller-variant coverage, unresolved identities, findings and runtime against that baseline. Constructor-to-framework-receiver propagation, static initialization blocks and collections of custom objects require further source-backed refinement; do not infer full support from the preceding instance-domain tests. Stage 4 is not gated on zero unresolved queries, but on stable, accurately qualified evidence, shared-core reuse and verified regressions.


## Pre-Stage-4: bounded static initializer blocks

The shared `ApexStaticValueIndex` now recognizes top-level static blocks that consist entirely of direct, single assignments to previously declared blank static scalar or string-collection members. The assigned expressions must be independently evaluable by the existing Apex expression evaluator. This slice deliberately does not assume field dependencies within the block, helper side effects, conditional initialization, repeated writes or lazy initialization.

New block-derived snapshots are invalidated when the indexed repository contains another detectable direct assignment, compound assignment, increment/decrement, indexed assignment or standard collection mutator for the same field, including class-qualified writes. Shadowed locals may conservatively invalidate evidence. This guard is not a general alias/escape analysis or a proof of runtime immutability. The existing declaration-only initializer snapshot policy is unchanged; revisiting that policy and accurately modeling later static writes, aliases and lazy initialization are separate work items.

Tests exercise supported scalars/collections, unsupported control flow, direct mutations and cross-class SOQL consumption. Live comparison baseline before this slice: 596 analyzed variants, 51 unresolved sites, 6 path-budget failures, 7 High findings. These figures are a reported baseline, not validation of this implementation. In particular, the source behind the cached static field diagnostic must be inspected before claiming that this slice resolves it. Stage 4 remains deferred.


## Pre-Stage-4: bounded object-oriented Apex interpretation

- The instance index evaluates scalar constructor locals, scoped blocks, known Boolean branches and compound assignments. Unknown conditions, arbitrary helper effects and unsupported statements remain unknown. Constructor delegation via first-statement `this(...)` is supported only for unique arity, proven arguments and bounded acyclic chains; instance initializers run once.
- The value domain supports bounded typed lists of repository-defined instances, with list literals, empty initialization, add/addAll/set/clear, get and enhanced for. Object/member correlation and tracked reference identity are retained, including member updates through aliases. Unknown calls, unsupported indexed writes, structural changes during iteration and unproven alias transfers must not be treated as complete evidence. This is not full generic collection, inheritance or heap analysis.
- Direct `Database.executeBatch(new BatchClass(...))` allocations can supply known receiver evidence to the first direct invocation in a compatible `Database.Batchable<T>.start(Database.BatchableContext)` method. This is deliberately partial: existing local batch aliases, scheduler dispatch, additional interfaces, intervening statements and arbitrary receiver effects are not resolved by this slice. The ordinary unresolved site REVIEW remains, and any parsed variant is qualified as known caller context.
- The previous blank-final regression expectation was updated to reflect the explicitly supported straight-line static initialization case; unknown or conditional initialization remains covered by negative tests.

Synthetic regression tests cover these behaviors. The live baseline remains 596 analyzed variants, 51 unresolved sites, 6 budget failures and 7 High findings; these changes are not yet measured against that repository. Stage 4 remains deferred. Broader static mutation/alias policy, deep caller resolution and path-budget optimization still require additional work.


## Pre-Stage-4: execution intelligence and symbolic/static state slices

This section supersedes the earlier policy that every evaluable class-level static initializer is fixed regardless of later writes.

- Dependency slices converge to a bounded fixed point, normalize identifier comparisons, and retain unfamiliar statements rather than silently discard possible effects. Direct repeated Boolean parameter guards can retain correlated outcomes only when the parameter occurs exclusively in identical guards, with no other references or writes. The existing path/operation/depth limits remain unchanged.
- Incoming caller seeds and helper memoization distinguish argument alias identity, avoid redundant contexts, retain upstream truncation diagnostics, and avoid caching mutable return allocations. Class-qualified helper evaluation requires a proven static method. These changes improve bounded recursive traversal; they do not imply exhaustive dispatch or deeper-than-limit call support.
- The shared value model carries source-backed scalar runtime symbols and ordered, bounded literal/hole fragments for incomplete concatenation, including `+=`. Unknown fragments remain unknown and are not executable SOQL. The scanner reports counts and types without disclosing literal contents or inventing field names, predicates, access mode or numeric values. Structural-only permission analysis of symbolic numeric slots is deferred.
- Unsupported compound or indexed writes invalidate tracked state rather than preserve stale values. A security suffix cannot turn an unknown base into a fully resolved query.
- Declared static snapshots and static-block values are rejected when repository-visible additional direct writes or unproven direct collection aliases/returns are detected. Local shadow declarations/parameters and bounded read-only typed collection alias chains (including nested collection get() into read-only locals) are distinguished. This is not complete heap, escape or cross-method effect analysis; global invalidation can conservatively reduce coverage.
- Canonical zero-argument static lazy getters consisting of a null check, one independently evaluable assignment, and return of the scalar (or a defensive List/Set copy) are recognized. Calling the getter can establish a value; direct reads of an uninitialized backing field cannot. Additional writes, runtime initialization, mutable return escapes and unsupported control flow fail closed. Defensive copies have independent abstract identity. Repository static getFields() helpers are distinguished from Schema Field Set calls.

Regression fixtures cover repeated guards under a low path budget, reassignment, unsupported writes, partial expressions, alias read-only/mutation distinctions, lazy getter calls and previous metadata-backed collection behavior. Prior positive collection fixtures use an explicit local copy rather than assume shared mutable static state stays at its declaration value; a separate negative integration fixture exercises direct static mutation. The previous fixed-initializer regression expectations and Excel disclosure are updated accordingly.

Live baseline: 596 analyzed variants, 51 unresolved sites, 6 budget failures, 7 High, 252 Low. Actual coverage, correctness and runtime effects must be checked on the same source/org/persona. These are bounded implementation slices across the planned Batch 1 and Batch 2, not proof that all pending execution-intelligence and symbolic-state capabilities are complete. Batch 3 control flow and advanced collection work remains deferred.


## Pre-Stage-4: performance and regression recovery

Live comparison after the prior iteration: 592 analyzed variants (previously 596), 51 unresolved sites, 8 path-budget failures (previously 6), 7 High and 252 Low. Known caller-specific variants dropped from 27 to 23. Runtime is not measured by the workbook. Treat these as reported baselines, not evidence of a specific bottleneck.

- Exact-source, bounded syntax cache reuses masked source and immutable parsed method structures; repository-owned method arrays are passed to caller/helper engines rather than reparsing. Cache contains syntax only, no org metadata, permission grants or evaluated runtime state. Source changes invalidate by text/graph identity. Built-in query invocation discovery reuses results; arbitrary consumer selectors remain independent.
- Preindex overload lookups and reuse qualifier-shadow checks. Avoid batch invocation discovery in classes without executeBatch and dynamic evaluation in static-only classes. Reuse frozen-node dependency slices and lexical liveness. Discard dead scalar parameter bindings only at safe method-root statement boundaries.
- Bounded caller sampling ranks diverse, concrete query-relevant projections before taking additional representatives. The original complete argument vectors and alias topology are retained, the eight-context sample ceiling remains, and incomplete coverage is explicitly preserved. Ranking is a heuristic, not proof that omitted arguments are irrelevant or that the four missing variants have been recovered.
- Optional SALESFORCE_SOQL_PERF=1 now includes aggregate shared-engine parse/cache counters, interpreter counts, helper evaluations, caller-context and probe counts/timing, analysis passes, candidate/selected seed counts and graph timing. Cumulative nested timings overlap; do not add them together to obtain wall time.
- Actual completed class counts drive scanning progress between the existing milestones (2–19%); concurrent in-flight scan subscribers receive updates. Periodic event-loop yielding improves polling opportunities, but a single synchronous expensive class or initial graph construction may still block progress. Percent remains estimated completed work, not ETA.
- Tests exercise exact-source invalidation, immutable syntax reuse, bounded sampling diversity, scalar liveness, aggregate metrics and scanning progress. Existing security and metadata freshness rules are unchanged. Worker threads, broader interprocedural effect caching and further path/state optimizations are deferred until measured profiling and actual affected Apex source are available.

Retest with the same OMS Core persona, repo and org, record elapsed time and [SOQL Perf] diagnostics, compare site/variant coverage and confirm all permission finding changes. Do not infer successful recovery of the actual four lost variants or reduction in the eight budget failures from synthetic fixtures alone. Stage 4 and Batch 3 remain on hold.


## Pre-Stage-4: performance round two

Live Round 1 baseline: 72.010 s wall clock, 40.024 s scanning (12.121 s repository graph, 25.827 s class processing), 31.882 s security evaluation, 595 queries, 51 unresolved sites, 8 budget failures, 7 High and 252 Low. Aggregate overlapping query/engine times are not additive. The reported 8,620 syntax misses, 2,369 engine instances, 307 queryAll invocations and 118 exact fallback requests motivate this round; no runtime reduction has yet been measured.

- A single repository-owned syntax inventory shares exact-source masks and immutable method trees across static, instance and method indexes. Short classes qualify too. Transient masks have a 24-million-character cap and the inventory releases its references after graph construction; indexed method owners retain their immutable trees. Classes with no eligible blank/null static fields skip lazy getter discovery. Existing source fingerprint and graph invalidation are unchanged.
- Caller argument probes may reuse completely known scalar results for the identical lexical site, expression list, original argument vector and resolver identity, with no reuse of mutable reference results or incomplete probes. Cache hits do not relax traversal or execution budgets. Repository helper cache uses bounded individual eviction instead of clearing the entire cache. Caller graph skips names absent from the candidate class before argument parsing. No evaluated result crosses a live metadata resolver boundary.
- Shared UserFieldAccess gateway coalesces simultaneous exact fallbacks for the same org, user and object into bounded targeted IN batches of up to 20 fields. Accept only explicit, identity-matched, consistent boolean Read/Edit rows. Missing, conflicting, incomplete or rejected batches retain original equality lookups; absence is never a grant or denial. Unsupported HTTP 400 batches and unproductive object/user batches are suppressed for the existing 60-second freshness window. Org scope is checked before and after the queued query. Compound-parent, metadata and permission policies are unchanged. Live Tooling API support and actual savings must be measured; an unsupported/sparse response can add a speculative request before fallback.
- Query failure metrics now include fixed category and HTTP status counters, without exception messages, source, identifiers, SOQL or payloads. These diagnose future failures, not the historical eight failures retroactively.
- Regression tests cover repository syntax reuse, targeted explicit grants/denials, absent rows, unsupported filters, conflicting and unexpected rows. Compare a cold and a warm run on the same repo/persona/org, including new probe-cache and targeted-batch counters, and verify report coverage and permission findings. Under 50 seconds is a target, not a measured result.

Source-backed refinements (including the remaining OMSQueryService variant, eight budget failures and other unresolved sites), deeper cross-resolver evaluation reuse, worker threads and Batch 3 are deferred. Do not infer readiness for Stage 4 from synthetic test coverage.


## P0 correction and bounded P1 refinements

Round two live baseline: 64.886 s total, 25.038 s repository scan, 2.339 s graph build, 3,170 syntax misses for 3,170 classes; 595 queries, 51 unresolved sites and 8 budget failures. The four targeted batches resolved none of 12 requested fields and added four queryAll calls; all eight historical failures were HTTP 400 in org.other.

- P0: exact equality field-access checks are the default again in the shared gateway. Targeted batching is retained only as an explicit constructor opt-in, for controlled testing. All existing verification and compound-parent rules remain unchanged. Diagnostics separate Custom Labels, Field Sets, Custom Metadata, schema and permission metadata, and UserLogin; structured Salesforce error codes are restricted to a fixed allowlist. No query values, arbitrary error text or custom metadata names appear in performance counter labels.
- P1: repeated identical scalar parameter comparisons retain a path-specific truth fact, only when every lexical reference is in that guard. No runtime value is invented; additional reads/writes disqualify correlation. Root liveness removes the fact after its last lexical use. Existing path and operation budgets are unchanged.
- Direct leading calls in if conditions can contribute caller argument evidence. Nested/non-leading calls with unknown execution order are not promoted by this rule.
- Direct executeBatch(new T(...)) receiver evidence extends to a restricted scalar local-declaration prefix in start, requiring actual constructor-backed receiver fields and no arbitrary calls, member writes or property chains. Open framework coverage still remains REVIEW.
- Constructors allow a narrow set of supported pure String built-ins; reversed null checks in otherwise canonical lazy getters qualify under the existing write/alias safeguards.

The affected Salesforce business-class source files were not available in this project; these are analyzer-code-backed generic refinements with synthetic regression fixtures, not verified fixes of the eight actual budget failures or the remaining lost OMSQueryService variant. Obtain the affected methods and actual callers/constructors before site-specific work. Batch 3 and Stage 4 remain deferred.


## Field Set retrieval correction after P0/P1 live retest

The live retest reported 67.371 s total, 25.082 s repository scan, 595 analyzed queries, and 307 queryAll invocations. All eight queryAll failures were HTTP 400 / INVALID_FIELD in the Field Set category (16 Tooling queries in total). This identifies the failing operation family, not the precise unsupported field or prior SOAP fallback success rate.

The live metadata provider now prefers the existing read-only Metadata API readMetadata(FieldSet, Object.FieldSet) call, with exact fullName validation and ordered displayedFields. The previous two-step Tooling inventory/detail path is retained only when SOAP is unavailable or incomplete. Both paths validate member paths and bounds; if neither proves a complete result the query stays unresolved. No permissions or metadata snapshot lifetime rules were relaxed.

New counters: org.field_set.soap.calls, successes, failures, cumulative_ms; org.field_set.tooling_fallbacks, tooling_inventory.calls/failures, tooling_detail.calls/failures, tooling_fallback_successes, unresolved. SOAP calls are distinct from queryAll counts. Live validation must check both transports, not just a decrease in queryAll failures.

No further speculative execution-engine changes in this patch. The actual Apex classes for the eight budget failures and remaining lost variant are required before source-backed P1 work.


## Source-backed execution refinements

Reviewed the six source files supplied with the 67.371 s live baseline. The previous report's exact UTF-16 source offsets match the uploaded source. Four sites at DynamicReportController lines 307, 318, 899, 958 fail at getReportData line 288 (pagination branch; 96/32 or 144/32 paths). The last two are private helper invocations whose caller reaches the budget before their own bodies. LookupFieldComponentController line 192 fails at line 165 (optional filters; 64/32). OMSPatchHandler line 116 fails at line 111 (trailing AND cleanup; 48/32). Both related-list sites fail at their ORDER BY branch (48/32). The OMSQueryService line 5687 SELECT-fragment caller is outside the supplied files. These are observed failure locations, not a claim that every branch contribution has been measured locally.

Shared core changes (no business-specific execution rules):
- Nested straight-line scalar liveness, preserving loop-carried values; unknown-provenance-only frontier compaction at path pressure keeps known values, distinct runtime symbols and alias topology. No increase to the 32-path/5,000-operation defaults.
- Invocation-prefix reachability prunes only branches that cannot reach the selected lexical target, outside loops, and avoids retaining post-invocation continuations as live frontier states. Private caller fallback now uses the actual caller argument dependency slice. Selector-agnostic; no security-policy changes.
- Unknown-loop effect summary recognizes indirect reference escapes (including helper parameters), direct/indexed/compound writes, lexical locals and unproven returns. Runtime while loops preserve their lexical boundaries and remain abstract; known enhanced-for iteration consumes nearest-loop break/continue. Full general traditional for/while/do/exception execution remains deferred.
- Bounded exact string chains (substring, length, suffix/prefix checks, literal replace, etc.), integer min/max, and lexical indexed reads; unknown runtime strings remain unknown. Partial escapeSingleQuotes evidence is preserved without fabricating content.
- Custom Metadata LIMIT 1 is supported only when the complete filtered inventory proves zero or one matching row; no arbitrary row selection. Singleton configuration fields can contain null or text templates; a known record can be read through singleton [0]. Unknown binds, ambiguous rows and unsupported query structure remain unresolved.
- Synthetic regression fixtures mirror the source patterns and exercise non-SOQL invocation selectors. The supplied business classes are not committed.

The Field Set SOAP-first patch has passed its prior CI. Final combined CI and live report comparison are required. Do not interpret a changed budget diagnostic as a fully resolved query; unknown runtime SELECT/object/filter values must still remain REVIEW. The caller of the SELECT-fragment method and actual wrapper type are needed to investigate the lost variant and date serialization precisely. Batch 3 broader language coverage and Stage 4 remain deferred.


## Caller-source follow-up and remaining private helper budget

Live baseline after source-backed refinements: 60.074 s total, 20.884 s repository scan, 595 analyzed queries, 51 unresolved sites, one remaining execution-budget failure. Eight SOAP Field Set reads succeeded, no Tooling fallback or queryAll failures, 291 queryAll invocations. Permission finding inventory was unchanged.

Review of the additional caller source revealed two distinct issues: the alternative `Schema.SObjectType.<Object>.fieldSets.getMap().get(...).getFields()` expression was not recognized by the shared evaluator, and the SELECT accumulator is a mutable static String appended to within a separate Field Set iterator helper. The older declaration-only snapshot is not proof of its complete value. The alternative Field Set syntax is now supported through the same existing authoritative metadata resolver. No special-case business class, field set, or object name was introduced.

The remaining private helper budget failure occurs after the target Database invocation. Invocation analysis now uses the actual non-loop target's lexical prefix when entering its owning method through a private caller fallback, rather than charging its post-target return computation to the invocation budget. Target-bearing local helpers bypass the ordinary return-summary cache. Ordinary full helper-return summaries and loop-carried targets retain their existing execution requirements.

Cross-method transfer of mutable static scalar state and proof of a fresh transaction entry remain open. Do not restore declaration-only snapshots to claim a complete query or treat Field Set retrieval alone as complete caller resolution. Regression fixtures exercise both fixes without committing supplied business classes. Final CI and live comparison are required before claiming the last budget issue or lost variant resolved.


## Bounded member effects and partial structural verification

Previous live baseline: 60.074 s total, 20.884 s repository scan, 595 analyzed query variants, 51 unresolved sites, one budget failure, eight successful Field Set SOAP reads and zero reported queryAll failures. The separate alternate Field Set syntax and private-helper cutoff patch has passed CI; its live effect is not yet measured.

Shared Apex core:
- ApexMemberEffectModel indexes directly owned private mutable scalar declarations with literal initializers and lexical shadow checks. Normal method entry does not assume fresh mutable state. Explicit resets and qualified member writes are tracked in the frame. A separate direct public static @AuraEnabled fresh-entry sample is admitted only for a supported class initialization shape without inheritance or other executable static initialization. The normal open Apex entry remains unproven; fresh samples are never used to establish exhaustive private caller closure.
- Bounded effect replay uses the existing interpreter, not another Apex executor. It transfers agreed scalar member states and supported reference parameter mutations across uniquely resolved private static local helpers. Argument pins distinguish caller alias mutation from parameter reassignment; divergent exits, unknown calls, unenumerated loop effects and DML callbacks remain conservative. Effectful calls bypass return-only caches. Unsupported receivers, overloads, application property getters and arbitrary constructors are not proven pure.
- A narrow nested DTO proof accepts scalar automatic properties and inert constructors assigning only those properties, allowing known Field Set iterator/UI-column patterns to preserve independent member effects. No business class/Field Set/object name is hardcoded; no supplied business source is committed. Cross-class arbitrary heap/static effects, general exception handling and polymorphic dispatch remain outside this bounded implementation.
- Caller probes keep partial abstract argument fragments for downstream consumers. Fresh framework samples are labeled in the unresolved-site context evidence and are not complete coverage.
- ApexPartialStructure supplies a reusable bounded proof interface without changing an unknown Apex value into known text. The SOQL adapter proves only complete Integer/Long numeric slots in supported predicate, LIMIT or OFFSET positions, parses the representative structure, verifies the established OLS/FLS references, and retains site REVIEW. Numeric placeholders are synthetic parser values, never executed or claimed as actual query input. Unknown structural String holes are not substituted. Coverage is tagged PROVEN_PARTIAL_STRUCTURE; reports identify partial findings and maintain the original unresolved site.
- Logs split queries.analyzed into queries.complete, queries.known_caller, and queries.partial_structure. Do not interpret additional partial variants as fully reconstructed queries.

Synthetic fixtures cover explicit reset and append, reference alias vs reassignment, divergent early returns, unsupported callbacks, fresh entry isolation, a Field Set iterator plus inert DTO and serialization, partial numeric structure and private helper inputs. The synthetic cross-class fixture proves the complete SELECT accumulator in a sampled fresh request but leaves the externally callable query REVIEW. Live org comparison and Stack Trace Impact Analysis regression remain necessary. The 32-path/5,000-operation defaults are unchanged; Batch 3 broader control flow and Stage 4 remain deferred.


## Milestone 2 — typed dispatch and bounded object-reference foundations

Milestone 1 is preserved in `feature/apex-static-analysis-engine` at merge commit `7ed21b39e0282cc688949da1ccb12c9cd8a67320`. Active work continues on `feature/v0.1.1-dynamic-soql-resolution`; draft PR #57 targets the milestone branch, not main. PR #56 to main remains open and must not merge before final approval.

- `ApexTypeSystem` canonicalizes primitive/custom type names, nested generics and array aliases, parses declarations, and selects uniquely matching exact declared argument signatures among equal-arity overloads. Unknown source types, ambiguous nulls and unsupported conversion rankings remain unresolved. The prior single-candidate arity behavior is retained; this is not a full Apex compile-time compatibility checker.
- `ApexSymbolTable` associates method parameters, locals, enhanced-for variables and supported direct class fields with lexical ranges and owning classes. The source index retains method return signatures. Type inference is distinct from abstract runtime values: Object containing a text value does not become a String overload. Exact local, cross-class static and constructor dispatch share the type-resolution contract; nested class methods cannot impersonate outer class static calls.
- Repository caller evidence selects overload declarations by source type and keeps ambiguous dispatch as unproven. Private closure checks distinguish different overloads, without closing externally callable execution contexts.
- `ApexInstanceModel` supports bounded typed constructor selection, supported this-delegation, direct collection fields and nested source-backed allocation, with recursion/depth protection. Unsupported constructors/properties/inheritance remain conservative.
- `ApexReferenceState` supplies shared nested member access, case-insensitive lexical reads, bounded reference graph pins and simultaneous identity-based substitutions. `ApexInstanceEffects` proves a narrow same-class private static helper subset (direct scalar leaf writes and known collection add/clear on modeled instance arguments, simple supported control flow). Reference effect joins compare alias topology as well as values; divergent or oversized effects stay unknown. No arbitrary virtual dispatch, cross-class heap transfer or general reference-return alias transfer is claimed.
- Fixtures use generic invocation selectors as well as SOQL to test exact vs ambiguous overloads, declared vs runtime type, constructor chaining, lexical lifetime, nested aliases, independent allocations and conservative divergent effects. Existing regression suite remains required. No supplied business Apex was committed. No path/operation budget increase.

Live validation must compare against 596 analyzed variants, 569 complete-coverage variants, 27 known-caller variants, 51 unresolved sites, zero budget and API failures, 7 High / 252 Low unique findings, 60.512 s, 3,170 scanned classes. New helper.instance_effects.transferred metric measures bounded instance effect replay. No promised coverage count: unresolved instances and dynamic configuration may require additional language capabilities. Live Stack Trace Impact regression remains a release gate.


## Milestone 3 increment — framework receivers and configuration-driven objects

Source review (private supplied Apex, not committed): three configuration helpers contain a fresh 19-entry Integer-to-object factory (including a test-context-dependent scalar), a 36-entry static final object map and a 25-entry mutable static object map. The utility methods demonstrate read-only Field Set access, String splitting/trimming and business-hours calculations dependent on runtime data.

- Shared ApexClassModel recognizes multiple interfaces, Database.Batchable and Database.Stateful, and classifies Queueable/Schedulable declarations. Inherited or unsupported allocations remain conservative. Classification is not full framework execution support.
- Repository batch submission index accepts direct allocation or a supported typed receiver expression. Actual state at submission is probed using the existing engine. Start-prefix proofs accept bounded local assignments, branches, read-only map access and terminating catch paths; unsupported callbacks, member writes, arbitrary exception continuations and loops are not assumed safe. No complete start/execute/finish persistence or chained job simulation is claimed.
- ApexFrameworkReceiver supports separate source-initialized constructor scenarios and finite Integer-key samples (bounded, retain other unknown contexts). The scenario constructor may follow a supported normal initialization path in a try block; actual allocation must not drop exception alternatives. Conditional evidence is not a real submission or proof that every map key is feasible.
- Typed Integer/String map key semantics and alias identity are retained across supported operations. ApexPureFactory validates fresh local map factories with literal entries, source-backed object constructors and bounded puts; test-dependent literal alternatives are preserved. ApexObjectMapReadProof recognizes a narrow Integer-to-nested-scalar-object map with direct reads or private field aliases and no unproven escapes/mutations. Static final does not establish mutable-object immutability. Static object initializers without an adequate read proof are rejected.
- Constructor interpreter supports bounded private instance void initialization helpers, with lexical argument scope and recursion limits. Shared metadata provider resolves exact __mdt.getInstance developer-name access and lazily requests only source-read fields; missing, ambiguous or unavailable records do not fabricate metadata. Business-hours computations are still unknown, and general constructor/helper/exception handling remains pending.
- Unknown Id assignments retain their source-proven type. The SOQL structural adapter permits only exact quoted Id slots and previously supported Integer/Long slots; parser placeholders are synthetic, never executed. Business record values are not fetched to reconstruct queries.
- Coverage CONDITIONAL_FRAMEWORK_CONTEXT is separate from KNOWN_CALLER_CONTEXT and PROVEN_PARTIAL_STRUCTURE. Conditional source scenarios can also have safe synthetic parser placeholders; unresolved REVIEW is retained. queries.conditional_framework and caller.batch_receiver_samples are separate counters. A reported query-count increase may be conditional coverage, not a complete reconstruction.
- Generic regression fixtures cover stateful declarations, local alias submission, independent constructor scenarios, correlated map keys, factory test alternatives, mutating/escaping object aliases, private instance initializer, metadata availability, and quoted Id safety. Existing budgets unchanged. Private source class contents and real object inventories are not embedded in analyzer code.

Remaining source gaps: live confirmation of the five supplied batches, broader read-only utility proof (including split/trim and business-hours dependencies), propagation into execute/finish and receiver-bearing private instance methods, queueable/scheduled lifecycle execution, full stateful chained jobs, richer symbolic collections and comprehensive exception semantics. The 32-variant cap remains; conditional scenarios are bounded samples, especially for maps with more than 32 entries. Compare live results with Milestone 2: 596 analyzed (569 complete, 27 known caller, 0 partial), 51 unresolved, zero budget/API failures, 7 High / 252 Low unique findings, 58.422 s. Live Stack Trace regression remains pending. No merge into milestone or main.

## Receiver inventory reuse and bounded configuration overflow

- The repository method index caches incoming batch receiver inventories per source method and metadata resolver identity. Snapshot clones preserve aliases without sharing mutable results. The cache is bounded to 32 inventories, and recursive helper evaluation bypasses it. Query-site prefix proofs and argument evaluation remain independent; no receiver lifecycle inference is added.
- Baseline sampling order and limits remain first. If exact argument-vector deduplication leaves capacity, up to 32 additional Integer-key scenarios may be probed. The SOQL adapter retains its existing grammar proof and 32 published variant limit. This is not semantic SOQL normalization, complete key coverage or a change to security severity.
- Metrics: caller.batch_receiver_inventory_evaluations, caller.batch_receiver_cache_hits, caller.batch_receiver_inventory_ms, caller.batch_submission_probes, caller.batch_constructor_probes and caller.batch_receiver_overflow_samples. Existing caller.batch_receiver_samples continues to count evaluated receiver scenarios.
- Compare live results against 668 variants (569 complete, 27 known caller, 69 conditional framework, 3 partial), 51 unresolved sites, 7 High / 255 Low / 52 unable-to-verify unique findings, 82.28 s overall / 40.21 s repository scan, zero execution-budget failures. Recheck both SOQL and Stack Trace. No guarantee of 60–65 s or complete resolution of stateful execute/private helper sites.

## Bounded first-execute and same-receiver private invocation evidence

- For an explicit non-inheriting Database.Batchable + Database.Stateful class, a modeled constructor/submission receiver may seed a conditional first execute() only when the unique QueryLocator start() is proven read-only by the supported statement subset. No transient fields, arbitrary callbacks, receiver escape, or unproven member writes are accepted. The actual scope rows are unknown; no claim about subsequent execute chunks or finish().
- A bounded path of up to three direct same-class private instance calls may preserve the incoming receiver from start() or the first execute(). Overload selection uses lexical source types; each call and selected query site has a separate prefix/reachability proof. Local arguments are evaluated in caller context. No polymorphic dispatch, arbitrary heap mutations or closure of the unresolved site. Existing start map sampling is unchanged.
- New counters: caller.batch_first_execute_scenarios, caller.batch_private_start_scenarios, caller.batch_private_receiver_paths. Per target: at most 8 paths, 8 argument vectors per hop and 32 probes; incomplete cases remain REVIEW.
- Generic fixtures cover read-only first execute, rejection after mutation/escape, non-stateful/transient rejection, private receiver dispatch, zero-argument call and unreachable call. Live baseline: 672 variants (569 complete, 27 known caller, 73 conditional framework, 3 partial), 51 unresolved, 64.227s total and 23.366s repository scan. Constructor metadata utility effects and broad lifecycle support remain future work; no business Apex is embedded.

## Lifecycle integration repair and rejection diagnostics

- The SOQL adapter now invokes the shared context probe for zero-argument private instance methods as well as existing parameter-bearing methods. Zero-argument static/public methods remain outside this new entry gate. The existing conditional label and unresolved REVIEW are retained.
- Bounded same-receiver path discovery (including an empty result) is cached by immutable repository source method and supported entry set, not by receiver state or metadata values. Each metadata pass still reconstructs its own receiver inventories and verifies the path/site independently.
- Batch lifecycle rejection codes are attached to the unresolved query's diagnostic, including rejected_class, rejected_start_signature, rejected_execute_signature_or_state, rejected_platform_shadow, rejected_dispatch, rejected_constructor, rejected_start_effects, rejected_target_prefix, rejected_caller_prefix, rejected_call_reachability and rejected_query_arguments. They describe failed proof steps, not missing Salesforce permissions. Aggregate counters under caller.lifecycle.* and discovery timing expose the same categories without source text or business data. A site can have both accepted and rejected conditional scenarios.
- Regression cases verify zero-argument integration, rejected constructor/start/caller prefix and syntax cache reuse across different metadata resolver identities. Existing budgets and lifecycle proof restrictions are unchanged. Cross-class constructor utility interpretation is deliberately deferred until source evidence identifies the next safe subset.

## Shared repository discovery boundary

- SOQL discovery previously walked all directories, including Salesforce CLI's generated .sfdx/tools/*/StandardApexLibrary/System/Database.cls. This could pollute the repository method index and trigger the intentional platform-name shadow safeguard, including blocking explicit batch submissions. Stack Trace discovery already excluded these trees.
- Both walkers now use the same case-insensitive, whole-directory-name policy (repositoryDiscoveryPolicy.ts): .git, .sfdx, .sf, node_modules, dist, build, .next, coverage. Symlinks are not followed. Discovery remains repository-wide, including additional metadata packages; SOQL retains its existing test filename exclusion and Stack Trace still includes test classes.
- Do not bypass platform class shadowing based on class names alone. An actual application source Database.cls still reaches the index and retains the safeguard. Lifecycle rejection categories distinguish inheritance, class identity, lexical owner and actual indexed platform class shadow.
- Filesystem regression fixtures verify both consumers' discovery, nested/case-insensitive exclusions, conditional first-execute evidence with a tooling stub, real custom class rejection, and restoration of evidence after removing the custom class. No changes to permissions, SOQL mode, receiver budgets or completeness semantics.
- Live baseline must be re-established using the corrected source inventory. The prior 3170 classes, 672 query variants, 314 distinct findings, 820 raw findings and 60.966s runtime may include generated source artifacts; compare application query/finding identities, not only totals.

## Source-proven constructor collection utilities

- Constructor assignment expressions may now invoke a proven public/global static String-list factory with scalar arguments. The dedicated proof recognizes fresh local lists, typed Schema describe/Field Set aliases, exact Field Set member loops appending getFieldPath(), literal/local string additions, and return of the fresh list. No business helper name is privileged; unsupported statements, arbitrary callbacks, writes and alias escapes reject the allocation.
- Metadata is requested only after proving the complete helper shape; incomplete or unavailable metadata stays unknown while unrelated proven constructor members survive. Resolver scopes and existing metadata request budgets remain intact. This is not general cross-class effect interpretation or a claim of complete runtime receiver coverage.
- Constructor failures now distinguish unsupported expression calls, unproven private helpers, unknown conditions, unsupported control flow/statements/assignments, local shadows, nested allocation, delegation and operation/depth limits. Lifecycle REVIEW diagnostics retain the broad rejected_constructor code and attach the more specific constructor code when available.
- Target-prefix proof supports platform String.join only for lifecycle query paths with no indexed String class or visible shadow. Query parsing and conditional coverage rules are unchanged.
- Generic fixtures exercise a metadata-backed collection utility, missing metadata, an unsafe callback, an unrelated runtime constructor field, and specific failure codes. No proprietary business code is included. Static collection initialization and finish() analysis remain separate work.
