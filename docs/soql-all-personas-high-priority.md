# All-Personas High Priority SOQL Summary (Issue #41)

## User workflow
On **SOQL Security Analysis**, use the separate **All personas** panel above the Business persona selector and click **High Priority Summary**. This action requires no persona selection; the existing **Run SOQL Analysis** button remains unchanged.

The action observes the existing repository setup, Salesforce preflight and configured output-folder picker. In repository-only mode the result explicitly warns that missing permissions could not be confirmed; an empty High summary must not be interpreted as a clean audit. The Reports page shows the latest generated workbook and folder.

## API
`POST /api/soql-analysis/high-priority`

Optional body: `{ "acknowledgeRepoOnly": true }` after the same UI confirmation used by the original analyzer. No persona names are accepted or needed; the server loads all personas from `config/personas.json` in configuration order.

Response (metadata only):
- `personaCount`, `queryCount`
- `totalHighPriorityFindings` (sum of unique Object + Field groups within each persona)
- `totalHighPriorityOccurrences` (sum of High query references)
- `personas: [{ personaName, queryCount, highPriorityCount, highPriorityOccurrences }]`
- `reportFileName`, `outputFolder`, `verificationMode`

The API rejects overlapping single- or all-personas SOQL analyses with HTTP 409 `ANALYSIS_IN_PROGRESS`. It also retains the original org-verification preflight and folder validation. It fails the entire request if a persona evaluation or report write fails; it never silently skips a configured persona.

## Backend sharing and performance
1. `scanApexSoql()` executes **once** for the action (existing validated file cache may help warm runs).
2. `SoqlSecurityAnalyzer.prepare(queries)` resolves relationships, query scopes, field inventory and execution modes **once**.
3. `analyzePrepared(persona, prepared)` computes **independent OLS/FLS and org evidence** for each configured persona. At most two personas are processed at a time, with output ordered as configured. The shared org-verifier already bounds effective live permission checks globally.
4. Filter each finding on explicit `criticality === "High"` **before Object + Field grouping**, retaining only confirmed high-severity query references. Lower-priority and unverified references cannot leak into a mixed-priority group.
5. `writeAllPersonasHighPriorityReport()` reuses `soqlReportWriter.ts`'s existing eight-column header, rich-text Apex class/line references, grouped severities, styling and widths to emit **one workbook and one worksheet**, not one workbook per persona. Every persona has a heading, analyzed query count, unique High issue count, occurrence count, table, and explicit empty message when appropriate. Cross-persona duplicates are intentional.
6. Repeated persona sections prevent a meaningful global Excel auto-filter. The worksheet freezes its global summary header and repeats styled table headers for each persona instead.

## Verification
Run:

```powershell
npm run build
npm run test:all
cd web
npm run build
```

Integration/manual acceptance:
- Compare a single persona's High entries with the same persona's section in the all-personas workbook. Row count/locations must match after explicitly filtering the single-persona workbook to High occurrences.
- Switch the dropdown and run the new action again: it must include all configured personas in the same stable order.
- Check mixed High/Low SOQL references to one field. The High report must include only High locations; unknown and non-enforcing mode must not appear as High.
- Check a persona with zero High findings; its heading, counts and empty line must still exist.
- Verify only one newly generated Excel file, a single worksheet, and a correct folder/filename banner in both SOQL and Reports views.
- Try clicking both actions concurrently or sending two direct API requests; the second receives 409 instead of executing another analysis.
- Run in repository-only mode and verify the conspicuous uncertainty notice.
- Use `$env:SALESFORCE_SOQL_PERF="1"` in the backend terminal to observe one repository scan and one preparation followed by per-persona verification timings.

**Important:** CI validates structure, behavior and regression tests. The real end-to-end performance of the all-personas action must still be measured against a connected Salesforce org and representative repository.
