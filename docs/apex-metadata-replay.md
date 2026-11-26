# AUE metadata capture and offline replay (Phase 1)

This is an opt-in developer diagnostic, not a permissions report. The capture records the exact projected inputs returned by the shared ApexMetadataProvider: field inventories, typed Describe fields, Field Sets, Custom Labels and Custom Metadata query results (including typed equality filters and completeness). It does not dump raw REST responses, source files, record data, org identifiers, connection credentials, permission grants or raw provider error messages. Metadata configuration values themselves may contain confidential data or credentials; review locally before sharing. Never commit a real snapshot. Files are saved under the ignored .apex-metadata-snapshots directory in the backend working directory, with owner-only permissions where supported by the OS. No upload is performed.

## Capture

In the PowerShell terminal used to start the backend:

```powershell
$env:SALESFORCE_APEX_METADATA_CAPTURE = "1"
$env:SALESFORCE_SOQL_TRACE = "1"
npm run api
```

Connect to the intended sandbox and run normal SOQL Security Analysis (individual or all personas). The repository scan writes a uniquely named *.local.json snapshot and logs its path with [AUE Metadata Capture]. No extra org calls are made. A failed/oversized/conflicting capture is not saved and does not change analysis findings. Capture is off by default. Stop the backend and remove the capture variable when finished.

```powershell
Remove-Item Env:SALESFORCE_APEX_METADATA_CAPTURE
```

## Replay

Use the same Salesforce repository revision and analyzer commit to reproduce the baseline:

```powershell
npm run replay:metadata -- ".apex-metadata-snapshots/<actual-file>.local.json" "C:\path\to\salesforce-repository" DynamicReportController.cls
```

The command runs the same repository scanner and AUE with a file-only provider. It does not connect to Salesforce, evaluate persona grants or produce a security workbook. The optional filename filters the final detailed output, not repository discovery or cross-class context. Trace output is enabled. Exit code 2 means at least one exact metadata request was absent; no live fallback or fabricated empty result is permitted. Exit code 1 means failure; 0 means replay completed with no missing requests (not that all queries resolved). Captured incomplete reads remain incomplete. Original source tags indicate historical provenance, not current org verification. Error prose is redacted, so explanations of failed reads may differ. A newly discovered dependency may require a fresh capture.

The snapshot is bounded to 2,000 requests / 32 MiB. No org identity or source fingerprint is stored; select the matching source revision manually. This phase does not change helper semantics, query reconstruction or permission decisions. The capture boundary is reusable by other AUE consumers; integration is currently the SOQL repository scan.
