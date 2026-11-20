# v0.1.0 SOQL inventory diagnostic export — Test Case 2

This is a **temporary, opt-in diagnostic** for false-negative testing. It exports the same
resolved object/field inventory prepared by the existing SOQL Analyzer. It does **not**
reimplement parsing, relationship resolution or permission checks.

## What it exports

A single JSON file containing:

- Each discovered SOQL query, full SOQL source, Apex file/line, root object, and
  effective execution-mode/enforcement result.
- Each resolved object and field (including deep relationship targets), plus every
  source reference and field usage context (SELECT, WHERE, GROUP BY, HAVING, ORDER BY).
- Object-only Read references such as COUNT() and relationship scopes.
- Unresolved field/relationship references and parser limitations.
- Optional selected org ID from the live relationship metadata provider when present.

**This inventory is persona-independent.** The next testing utility will combine
it with `Persona-User-IDs.csv` and actual `UserEntityAccess`/`UserFieldAccess`
for the **same target org**. It will independently compare the access decisions
against Analyzer findings and enforcement. Exporting this inventory cannot prove
the parser discovered every Apex query; query-discovery coverage remains a separate test.

## Use the diagnostic desktop build

**Do not use the already-distributed v0.1.0 EXE:** it does not contain this exporter.

1. In GitHub, open **Actions → Build Windows Desktop Folder ZIP → Run workflow**.
   Select branch `test/v010-soql-inventory-diagnostics`. Download the artifact
   `SalesforceRepositoryAnalyzer-Desktop-Folder-ZIP` after the workflow succeeds.
2. Extract the full ZIP; run `win-unpacked/Salesforce Repository Analyzer.exe`.
3. Close the app and open the **per-user** settings file:
   `%APPDATA%\Salesforce Repository Analyzer\.env`.
   Add one line with a writable **absolute** local filename, outside the Git repository:

   ```dotenv
   SALESFORCE_SOQL_DIAGNOSTIC_EXPORT_PATH=C:/Users/You/Documents/AnalyzerReports/soql-resolved-inventory.json
   ```

4. Restart the diagnostic desktop app. Select the same **checked-out repository
   branch** and connect to the same **target Salesforce org** used for the v0.1.0
   baseline verification (for the current test, unifiedQA).
5. Open **SOQL Security Analysis** and run **All personas → High Priority Summary**
   (or run the single-persona analysis). The normal Excel report is generated,
   and `soql-resolved-inventory.json` is written to the configured location.
   The inventory is prepared once for All personas, not separately for each user.
6. Check that `summary.queries` matches the number of discovered queries in the
   corresponding Analyzer Excel output. Check `organizationId` when present.
7. Share the generated JSON for the false-negative comparison utility, using the
   existing **16-user CSV and original High report**. Remove the environment
   setting when the diagnostic run is finished.

## Safety and regression expectations

- When `SALESFORCE_SOQL_DIAGNOSTIC_EXPORT_PATH` is absent or blank, this
  feature does **nothing**. It must not alter SOQL scan findings, permission
  evaluations, Excel output, org queries or the packaged v0.1.0 build.
- A configured path must be absolute and end with `.json`. A failed export
  produces a visible analysis error, not a silently incomplete snapshot.
- JSON includes **Apex query text, schema names and local source paths**.
  Keep it private and outside the repository; never commit or distribute it
  with desktop builds. It does **not** contain the `Persona-User-IDs.csv` or
  Salesforce authentication tokens.
- Baseline v0.1.0 and branch diagnostic comparisons require identical repository
  source, target org and configuration. Otherwise, query/finding differences
  may be attributable to changed inputs rather than false negatives.
- Validate with `npm run build`, `npm run test:all`, and `npm --prefix web run build`
  in the diagnostic branch (the Windows Desktop workflow runs these steps).
- **Do not merge this temporary diagnostic feature into `main`** as part of
  v0.1.0 regression validation.
