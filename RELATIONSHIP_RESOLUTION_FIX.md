# SOQL Relationship Resolution Fix

## What was broken

- The original relationship builder stored parent-to-child relationship names (used in subqueries), but SOQL dot notation such as `Product2.Client__r.Name` travels child-to-parent. The full-repository analyzer tried to use the map backwards and silently dropped failed paths.
- Stack Trace Impact used an independent reverse lookup and a very short hardcoded list of standard relationships. It could not resolve `OrderItemSummary.Product2.*`, `OrderSummary.Owner.*`, and other standard paths.
- The previous field-permissionability CSV contains field names and IsPermissionable, **not** reference targets. By itself it cannot identify arbitrary lookup targets.

## Changes

1. `salesforceRelationshipResolver.ts`: One object-relationship graph with both parent and child directions, case-insensitive lookups, no fixed depth limit, repository custom-field metadata, conservative standard `FooId -> Foo` inference, and optional Salesforce sObject Describe snapshot.
2. `soqlQueryFieldResolver.ts`: Shared field collector for Stack Trace Impact (including selected fields, child subqueries, and basic WHERE/ORDER BY expressions). Tracks all objects along a resolved path.
3. `StackTraceImpactService.ts`: Uses the shared collector; removes separate hardcoded standard maps and brittle custom relationship guesses. Unresolved fields contain the first missing relationship.
4. `soqlFieldInventoryBuilder.ts`: Uses the same graph for deep SELECT paths and nested child queries; propagates unresolved paths.
5. `soqlSecurityAnalyzer.ts`: Emits REVIEW instead of silently skipping fields whose relationships cannot be identified from metadata.
6. `fieldPermissionability.ts`: Exposes known object/field names in the existing metadata snapshot, for conservative direct-standard relationship inference.
7. `scripts/export-relationship-schema.mjs`: Generates a local relationship snapshot using `sf sobject describe`. No secrets or records are exported.

## Installation

Merge the contents of this ZIP into the root of your current analyzer project, overwriting matching files.

```
npm run build
npm run api
```

`node_modules`, `dist`, frontend components, Profile/Permission Set evaluation, and generated reports were NOT changed or included.

## Complete standard relationship coverage (recommended)

Repository XML rarely contains standard lookup reference targets. For paths such as `OrderSummary.Owner.Name`, we must obtain Salesforce Describe metadata: **do not guess the target**.

If Salesforce CLI has not been authenticated:

```
sf org login web --instance-url https://test.salesforce.com --alias AnalyzerSandbox
```

Export the relevant *source* objects and each intermediate target object used in your SOQL. For your example:

```
npm run export:relationships -- --org AnalyzerSandbox --objects OrderItemSummary,Product2,OrderSummary,OrderItem,Order,Account,User
```

This creates `config/relationship-schema.json`. Restart `npm run api` and rerun the stack trace. To cover other relationships, add their intermediate objects to `--objects` and re-export. Include any additional objects used in your queries, for example `Client_Customer__c`, `Opportunity`, `Case`.

If object names contain managed-package namespace prefixes, pass the full API names. The CLI account must have permission to describe them. You may use a different sandbox alias.

The snapshot is **metadata only**: parent reference target names, parent-to-child relationship names and source field identifiers. It contains no customer records, passwords or access tokens.

For another offline snapshot location, set the environment variable `SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH` to the JSON path before starting the backend.

### Security semantics

- A resolved dot path is assessed against the *actual target object and final field*; Stack Trace Impact also checks Read access to intermediate objects.
- Multi-target (polymorphic), unknown, and truly absent relationships remain unresolved/review. Guessing a single target could falsely mark a persona safe.
- Complex WHERE and polymorphic `TYPEOF` constructs retain the analyzer's existing static-analysis limitations.
- `IsPermissionable` and this relationship snapshot solve different problems. For accurate field-level results on target objects outside your current nine-object permissionability snapshot, extend `field-permissionability.csv` as well.
- The snapshot is a point-in-time view; re-export after schema changes.

## Validation of the fix

A controlled runtime check of the resolver using mock repository custom lookup metadata and the actual nine-object permissionability snapshot confirmed:

- `OrderItemSummary.Product2.ProductCode` -> `Product2.ProductCode`
- `OrderItemSummary.Product2.Client__r.Name` -> `Account.Name`
- `OrderItemSummary.OriginalOrderItem.Order.Client__r.Paid__c` -> `Account.Paid__c`
- `OrderItemSummary.OrderSummary.Owner.Name` remains unresolved without Describe metadata (correct).
- With a supplied Describe relationship snapshot, `OrderItemSummary.OrderSummary.Owner.Manager.Name` -> `User.Name` and all four traversed objects are tracked.

The full npm build could not be executed in this environment because the upload excluded `node_modules` and network dependencies are not available. Syntax checks passed, and TypeScript diagnostic output contained no errors from changed source files beyond missing third-party types. Run `npm install`/`npm ci` (if needed) and `npm run build` in your local project.
