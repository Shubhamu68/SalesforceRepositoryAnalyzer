# SOQL Aggregate & Expression Read-Access Analysis

## Scope

The SOQL Security Analyzer now extracts the **underlying fields** of aggregate expressions instead of suppressing the entire function. The same field inventory is used by Stack Trace Impact Analysis.

The implementation uses the pinned `@jetstreamapp/soql-parser-js@8.1.3` AST. Existing Apex query discovery, nested child/semi-join scope tracking, relationship resolution, Profile/Permission Set/PSG evaluation, Salesforce org verification, and Excel reporting remain shared.

## Supported analysis

- Aggregates: `AVG(field)`, `SUM(field)`, `MIN(field)`, `MAX(field)`, `COUNT(field)`, `COUNT_DISTINCT(field)`; `COUNT()` requires only object Read
- Aliases: implicit aliases such as `SUM(Amount) totalAmount`; aliases referenced by `ORDER BY` are resolved to their source fields
- Grouping: regular `GROUP BY`, `ROLLUP`, `CUBE`, `GROUPING()`
- Filtering: `HAVING` and `WHERE` conditions including grouped/nested AND/OR
- Date and scalar functions: `CALENDAR_YEAR`, `CALENDAR_MONTH`, `DAY_ONLY`, `FISCAL_YEAR`, `FORMAT`, `TOLABEL`, `CONVERTCURRENCY`, `DISTANCE`, `GEOLOCATION`, `FORMULA()`
- Nested functions, parent relationship paths, child subqueries, and semi-/anti-join scopes
- Static Apex queries with `:new Set<String>{...}` / nested `:new Map<...>{...}` bind constructors: only the Apex value is normalized to a parser-safe bind token
- Object/FLS verification respects original query execution mode; older `WITH SECURITY_ENFORCED` does not receive invented high-severity field failures for non-SELECT-only clause references

## Safety properties

1. **Function names and aliases are not fields.** For example `MAX(Amount)` checks `Amount`, not `MAX`.
2. **System fields are handled by the existing field-permissionability policy.** `COUNT()` checks object Read; `COUNT(Id)` may retain `Id` in inventory but does not require configurable Id FLS.
3. **No silent unsupported-syntax bypass.** Parser failures, dynamic `FIELDS()` and ambiguous functions produce `PARSER` review findings; they are not interpreted as confirmed denials or clean scans.
4. **Preserve source paths and nested scopes.** The existing Apex bracket scanner and recursive relationship resolver are retained; the parser provides field operands and clause contexts.
5. **No change to Salesforce permission grants.** The implementation performs read-only metadata and effective-access checks, without modifying an org.
6. **Apex constructor binds are not Salesforce field expressions.** Their generic type tokens must not create findings such as `Shipment__c.String` or `Shipment__c.set`.

## Tests and release notes

The regression suite covers each aggregate family, COUNT edge cases, aliases, GROUP BY/ROLLUP/CUBE/GROUPING, HAVING, date functions, nested scalar functions, relationship fields, parent-child queries, Apex constructor binds, unsupported expressions, mode-specific severity, Excel output and source-line tracing.

No code change can prove that every future Salesforce SOQL feature is understood. An unsupported expression must be reported as Review with its Apex location and diagnostic, and must not silently produce a false clean result.

The library compatibility probe (run before implementation) parsed **16 of 17** representative queries; the only unsupported case was the Apex-specific inline collection constructor. That case is covered by the restricted bind-value adapter and dedicated regression tests. The temporary probe scripts/workflow were removed after validation.

## UAT recommended

Run the analyzer on the same repository/persona that previously showed `OrderItemSummary.MAX`:
- The artificial `MAX` field should disappear.
- The actual aggregate operand field should be present where applicable.
- Missing underlying Read access under user-enforced SOQL should be High when Salesforce confirms a denial.
- Existing object and field Read decisions should not change except for newly recognized field references.
- Unsupported syntax should yield a Review finding, not a clean result.
