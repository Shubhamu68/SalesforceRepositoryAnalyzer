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
