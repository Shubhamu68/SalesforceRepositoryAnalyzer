# Project-neutral field metadata (Issue #48)

## What changed
The Analyzer **does not ship any project's `EntityParticle.IsPermissionable` export**.
The former `config/field-permissionability.json` held 1,190 field values from an OMS org and incorrectly influenced field access plus relationship inference for other repositories.

The shared `SalesforceFieldMetadataService` now resolves in this order:

1. **Live selected Salesforce org**: object-level Tooling `EntityParticle` query is preferred. If it fails, omits a field, or has no `IsPermissionable` value, the Analyzer uses the same org's REST sObject Describe `permissionable` property before reporting UNKNOWN. Metadata is cached by org/session/API version and object.
2. **Explicit optional local cache**, only if the source org ID matches the selected connected org, or the explicit target org in repository-only mode; at most **90 days old**.
3. **UNKNOWN**: no inferred grant/denial; field security checks remain Review where verification is unavailable.

The repository's own Profile/Permission Set/Permission Set Group object and field grants, plus schema-required field metadata, still work without a connection or cache.

Standard fields are **not globally classified as nonpermissionable**. Missing field-level grants for fields of unknown permissionability must not be reported as confirmed High risk without Salesforce evidence.

## Repository-only analysis
No extra configuration is required. Repository-only analysis works without any snapshot. Known grants continue to be evaluated. Some standard/managed fields may produce **Review** because their permissionability cannot be proven from the repository alone. For a richer offline report, explicitly export metadata from the relevant org and configure an optional local cache.

### Optional field permissionability cache
This is an opt-in, per-org cache; it is **not** a universal Salesforce field database.

1. Export a CSV from the **relevant Salesforce org** using Tooling `EntityParticle` with exactly these columns:
   `EntityDefinition.QualifiedApiName,QualifiedApiName,IsPermissionable`
2. Run `npm run import:field-metadata -- <export.csv> <local/fields.local.json> --org-id <00D...>`.
3. Set the following in your local, untracked `.env`:

```dotenv
FIELD_PERMISSIONABILITY_SNAPSHOT_PATH=C:/LocalAnalyzerMetadata/fields.local.json
FIELD_METADATA_OFFLINE_ORG_ID=00D000000000001
```

The file has schema `{ "version": 2, "organizationId": "00D...", "capturedAt": "<ISO UTC timestamp>", "objects": { ... } }`.
For connected mode the selected org ID controls matching: the offline target ID is not used as a substitute. In repository-only mode the explicit offline org ID is required. Mismatched, invalid, missing or expired metadata stays UNKNOWN. A previous version-1 OMS export is intentionally not accepted; re-export it for your project.

**Do not commit these files** or distribute them in the portable ZIP. Restart the API after changing local cache settings or replacing cache files.

### Optional relationship schema
Repository `CustomField` XML still provides custom parent/child relationship definitions. Connected mode uses Salesforce REST sObject Describe for additional, particularly standard/managed, relationships.

For repository-only standard relationships, optionally export current-org metadata:

```powershell
npm run export:relationships -- --org MySandbox --objects Account,Contact,Custom_Object__c --output C:/LocalAnalyzerMetadata/relationships.local.json
```

Set `SALESFORCE_RELATIONSHIP_SNAPSHOT_PATH` to this local export in `.env` and `FIELD_METADATA_OFFLINE_ORG_ID` to its source org ID. The export contains `version: 2`, `organizationId`, `capturedAt`, and `objects`; the same 90-day freshness and exact-org safeguards apply.

The Analyzer **does not** assume that a `FooId` field always points to `Foo`, and it no longer hardcodes the OMS-specific `OriginalOrderItemId` relationship. When neither repository XML, current-org Describe, nor a valid optional schema can establish a relationship, analysis should report an unresolved-path **Review** instead of inventing an object.

## Compound fields with confirmed denied-parent Read

The shared `SalesforceUserFieldAccessGateway` uses the current org's
Describe/EntityParticle compound metadata and the actual persona-matched user's
`UserFieldAccess` evidence. It does **not** ignore all `__s` fields.

- A conclusive direct component Read grant or denial takes precedence.
- When a direct component row is absent (or Read is null) and the verified
  compound parent's Read is **true**, component Read can be verified using
  the parent. Parent Edit is never inherited.
- When the parent Read is **false**, the gateway retains a distinct
  `deniedCompoundParent` dependency. It does **not** claim Salesforce
  independently denied the component. Only a unanimous parent-denial
  dependency across every checked user may yield a parent-dependent denied
  outcome; mixed, conflicting, or incomplete evidence remains Review.
- SOQL groups such dependent components under the parent field's finding,
  preventing repeated generic Unable-to-verify rows for the same denied
  parent. Stack Trace groups parent dependencies while preserving the
  original component names. Access Checker explains the same provenance.
- If parent metadata or access is missing, the result stays **Unable to
  verify**. No project-specific object names, Salesforce user IDs, or
  unconditional FLS bypasses are introduced.

This changes **report attribution**, not Salesforce permissions. A
confirmed parent denial is not evidence of a direct component FLS denial.

## Why this preserves safety
- Permissionability is **not** the same as field Read permission. A nonpermissionable field still requires object Read; a permissionable field requires FLS evidence.
- Successful Tooling metadata lookup never borrows absent fields from any offline cache. The current org's REST Describe is a separate authoritative live metadata source, including for custom Address component fields when the Tooling result is incomplete.
- An unavailable or denied Tooling query does not prove a field exists, is nonpermissionable, or is inaccessible.
- EntityParticle and REST Describe work is object-scoped and cached. No extra per-field Salesforce queries are added.
- SOQL, Access Checker, Stack Trace and other callers share the same optional-cache logic; no feature-specific OMS whitelist or bypass is introduced.

## Validation before merge
```powershell
npm run build
npm run test:all
cd web
npm run build
```

Manually test both connected-org and repository-only SOQL, Access Checker, Stack Trace and Object Access Matrix on OMS and one independent non-OMS metadata repository. Confirm no more false High results, and verify that unresolved relationships are honest Review. A repository-only run may have more Review warnings than the old OMS snapshot for standard fields; that is expected when offline metadata is not provided.

### Remaining cross-project configuration
This issue addresses only the field-permissionability export and inference coupled to it. It does **not** change `config/personas.json` or other separate Order Management-specific status/managed Permission Set policies. Those require their own review before declaring the entire application zero-configuration.
