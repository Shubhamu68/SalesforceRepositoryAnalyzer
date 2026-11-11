# Full and Selective Metadata SOQL Analysis

This is the **analysis scope** foundation for a future pre-deployment permission-risk gate. It deliberately does **not** predict the effective state of the target org after deployment, and **must not** be used as an automatic Azure release blocker yet.

## Select a run mode

- **Full Repository**: all static SOQL in non-test `.cls` files in the configured repository.
- **Selective Metadata**: analyze SOQL potentially affected by selected Salesforce metadata members, using a checked-out deployment `package.xml` and/or explicit member entries.

Both modes share SOQL scanning, recursive relationship resolution, persona permission aggregation, repository-first and Salesforce-org fallback verification, and the existing Excel/TXT report writer.

The UI offers both options on **SOQL Security Analysis**. In selective mode, supply a repository-relative `manifest/package.xml` path, metadata members, or both.

Supported exact selectors:

```
ApexClass:OrderSummaryHandler
CustomObject:OrderSummary
CustomField:OrderSummary.CSR_External_Notes__c
CustomField:OrderSummary.*
```

The component names must match the Salesforce metadata fullName (case insensitive for scoping).

The `package.xml` structure follows Salesforce Metadata API:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>OrderSummaryHandler</members>
    <name>ApexClass</name>
  </types>
  <types>
    <members>OrderSummary.CSR_External_Notes__c</members>
    <name>CustomField</name>
  </types>
  <version>66.0</version>
</Package>
```

## Conservative expansion

PermissionSet, PermissionSetGroup, Profile, MutingPermissionSet and unsupported metadata types **expand** a selective run into a full static SOQL scan and emit warnings. Such changes may affect unrelated classes, and pretending to identify a narrow impact would be unsafe.

Wildcards `*` also expand to a full scan, intentionally. Unknown relationship paths are included conservatively in field/object selections so unresolved dependencies cannot be silently excluded.

No matching static queries is **not** a pass verdict. The UI and output explicitly say so.

## Run from Azure DevOps or a local checkout

```powershell
npm ci
npm run soql:scope -- --repository . --persona "Order Management Specialist CORE" --mode FULL --output ./reports

npm run soql:scope -- --repository . --persona "Order Management Specialist CORE" --mode SELECTIVE --manifest manifest/package.xml --output ./reports

npm run soql:scope -- --repository . --persona "Order Management Specialist CORE" --mode SELECTIVE --component ApexClass:OrderSummaryHandler --component CustomField:OrderSummary.CSR_External_Notes__c --output ./reports
```

Use secure pipeline variables and approved Salesforce org credentials when enabling live-org verification. Select the target sandbox explicitly and verify the org ID as part of the **future** deployment-gate implementation.

Output includes TXT and Excel reports, an `Analysis Scope` sheet, and a JSON result. `deploymentGateReady: false` explicitly prevents interpreting the JSON as a deployment approval. The CLI exit status reports tool errors, not permission finding counts.

## Current limits and next phases

- Scans static SOQL in Apex classes; dynamic queries, triggers, Flow metadata, and compile-time field existence are not yet in scope.
- Repository grants are candidate-source metadata; the current org verifier checks **current** effective access for a representative persona user, not post-deployment access.
- A permission grant in an undeployed source file cannot yet be distinguished from an effective deployed permission.
- Selective dependency resolution for custom field/object metadata is static and conservative; cannot prove completeness for every automation entry point.
- No full target-org + deployment-package **proposed permission state** simulator exists yet.
- No Azure pipeline pass/review/block decision should be inferred from current output.

Next: deployment package versus target-org schema differences, proposed-state Profile/PS/PSG permission overlay, user coverage policy (rather than one most-recent user), cross-feature dependencies and safe pipeline gating, then post-deployment reconciliation.
