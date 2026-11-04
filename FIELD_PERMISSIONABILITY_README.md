# Field permissionability snapshot — Salesforce Repository Analyzer

## Purpose

Uses the supplied Salesforce EntityParticle.IsPermissionable export to avoid treating a missing FLS XML entry as missing Read access when Salesforce reports that a field cannot have configurable FLS.

This change is centralized in `src/analyzer/personaAccessEvaluator.ts`, shared by Stack Trace Impact, SOQL Security Analysis and the regular Field Access Checker. Profile, Permission Set, PSG, and muting resolution are unchanged.

## Install

Copy the contents of this ZIP over the **project root** (`salesforce-repository-analyzer`), preserving the `config/`, `src/`, `scripts/`, and `web/` paths. Replace files with matching names; don't replace entire directories.

Run in the project root:

```powershell
npm run build
npm run api
```

In a second terminal:

```powershell
cd web
npm run build
npm run dev
```

Restart the backend when replacing the snapshot; its contents are cached per running process.

## Snapshot information

- Input: supplied `field-permissionability.csv` (Salesforce EntityParticle.IsPermissionable)
- Included snapshot: `config/field-permissionability.json`
- Coverage: 9 objects / 1,190 fields
- Values: 371 `false`, 819 `true`
- `false`: field does **not** require a separate configurable FLS Read grant; object Read remains mandatory
- `true`: resolve field Read normally from Profile + Permission Sets + PSGs and View All Fields
- Field absent from snapshot: retain previous evaluation, **not** assume permissionable=false
- `IsPermissionable` by itself does **not** establish field Edit access. Existing edit grants are unchanged.

The snapshot is an export of one Salesforce org at one point in time. Refresh it when org schema or feature access changes; do not assume it matches a different org.

## Refresh the snapshot

1. Re-export the same EntityParticle columns and place the CSV at `config/field-permissionability.csv`.
2. From the project root:

```powershell
npm run import:field-metadata
```

3. Restart the API server.

No third-party CSV parser is required. The import command validates the columns, booleans, and duplicate fields before writing JSON.

## What changed

- `src/analyzer/fieldPermissionability.ts`: single, cached, case-insensitive snapshot lookup.
- `src/analyzer/personaAccessEvaluator.ts`: applies the snapshot at the shared field evaluator; object Read stays mandatory.
- `src/analyzer/fieldPermissionAggregator.ts`, `src/models/FieldAccessCheckResult.ts`, `src/services/PersonaFieldAccessService.ts`: report the optional `permissionable` field to the UI.
- `web/src/App.tsx`: explains non-configurable FLS for field access.
- `src/analyzer/soqlSystemFields.ts`, `src/analyzer/soqlFieldInventoryBuilder.ts`, `src/services/StackTraceImpactService.ts`: remove blanket Account billing-field exclusions. For fields included in the snapshot, do not silently ignore them as system/compound fields: the shared evaluator makes the decision.
- `config/field-permissionability.json`, `config/field-permissionability.csv`: metadata snapshot and its raw export.
- `scripts/import-field-permissionability.mjs`, `package.json`: refresh command.

## Important examples from the supplied export

- `OrderItemSummary.Quantity`, `.OrderSummaryId`, `.Product2Id`, `.UnitPrice`, `.QuantityCanceled`, `.ProductCode`, `.Status`, `.Description` are `false` (Read follows object Read).
- `Account.BillingCity`, `.BillingState`, `.BillingCountry`, `.BillingStreet`, `.BillingPostalCode` are `true` (do not blanket-exclude).
- `Account.Account_Code__c` is `false` in this export.

## Validation performed

- Validated the CSV: 1,190 unique object+field rows, no missing data.
- Regenerated the JSON with the bundled importer.
- TypeScript syntax checks passed for modified files.
- Targeted strict TypeScript checks passed for the changed analysis modules using temporary local type declarations for external libraries missing in this container. These declarations are **not included** in the ZIP.
- Runtime verification of the shared evaluator passed for non-permissionable and permissionable fields, including a Profile with ModifyAllData.
- A complete npm build of the whole project wasn't possible here because the uploaded archive excludes installed dependencies. Run the full backend and frontend builds locally.

No tests or test files were added or packaged.
