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
