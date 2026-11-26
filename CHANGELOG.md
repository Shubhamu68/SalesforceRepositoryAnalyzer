# Changelog

Notable changes to Salesforce Repository Analyzer are summarized here. Versions follow [Semantic Versioning](https://semver.org/). **GitHub Releases are created only after an approved tag**, not on every merge to `main`.

## Unreleased

- Planned for v0.1.2: integrate Stack Trace Impact Analysis with the shared Apex Understanding Engine (issue #58). Not included in v0.1.1.

## 0.1.1 — dynamic SOQL resolution

- Introduced a shared, bounded Apex Understanding Engine for source, type, method, caller and expression analysis, with supported control flow, instance state and collection effects.
- Reconstructs supported dynamic SOQL, including proven caller arguments, Custom Labels, Field Sets, Custom Metadata and Schema Describe dependencies; retains qualified partial/conditional evidence and explicit Unable to Verify findings when runtime structure or execution mode is unproven.
- Uses the existing shared persona permission, relationship, object and field Read verification layers. No Apex execution or blanket permission bypass.
- Adds actual live verification-user provenance to single-persona and All Personas SOQL Excel reports, while retaining the existing findings structure.
- Improves repeated analysis through scan-local metadata batching and dependency-validated Apex reconstruction reuse. Release-owned HTTP/verification/persona concurrency is fixed at 6/5/2; no manual performance environment settings required. Existing permission freshness windows are unchanged.
- Live reference benchmark (prior validated optimization configuration): 716 query inventories, 1,835 distinct field references, 312 grouped CORE findings (7 High, 290 Low, 15 Unable), 950 grouped All Personas High findings; best fully cached warm run 5.799s. Timings vary by repository, org latency and cache state.

Release scope: dynamic SOQL and its associated optimizations only; existing Stack Trace remains static-query based. New Stack Trace/AUE integration and full repository-versus-live-org comparison are deferred. This version is prepared on the integration branch; official release publication and desktop distribution require maintainer approval and packaging validation.

- Clarified public repository visibility, v0.1.0 Electron desktop-folder ZIP distribution, and Salesforce CLI login across README and setup/security/release guides (documentation only; application behavior unchanged).
- Professionalized repository README, documentation navigation, contribution templates and the versioned Windows Release workflow (documentation/distribution only; analyzer behavior unchanged).

## 0.1.0 — development baseline

Capabilities present in the project before formal GitHub Releases:

- Apex SOQL Security Analysis, aggregate and nested-query parsing, and persona-based object/field permission checks.
- Optional Salesforce live-org verification, field permissionability and compound Name/Address metadata, polymorphic relationship resolution, and explicit Review outcomes.
- Access Checker, Object Access Matrix, Stack Trace Impact Analyzer and Excel Summary reporting.
- Windows portable ZIP packaging with bundled Node runtime and first-run repository/output-folder setup.

> This is a historical development baseline, **not** an assertion that a `v0.1.0` GitHub Release has already been published.
