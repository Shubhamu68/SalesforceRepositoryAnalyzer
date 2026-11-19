# SOQL live progress indicator (Issue #46)

## User experience

One compact loading overlay is used by both **Run SOQL Analysis** and **All personas → High Priority Summary**, reusing the original magnifying-glass motif at a smaller size.

- Shows simple milestones: **Scanning Apex code**, **Preparing analysis**, **Checking permissions**, **Generating Excel report** (or **consolidated Excel** for all personas).
- **Finding matching Salesforce users** appears only when the connected-org verifier actually calls the shared persona matcher. Repository-only runs never show Salesforce-user progress; connected-org runs without a needed user lookup do not pretend one happened.
- When checking all personas, show **X of Y personas completed**, and **Y-X remaining**. A persona only counts after `analyzePrepared` resolves its full permission check. With one persona, don't show persona counts.
- Displays **whole-number estimated work progress** and elapsed seconds. Progress is *not* time remaining; Salesforce API latency, cache hits, and per-persona work vary.
- The backend emits work-boundary milestones and counts; **no timer increments percentages**. The percent stays below 100 until the Excel writer returns successfully. Failures never show 100%.
- Display the existing SOQL success banner and output-folder actions when the original POST succeeds.

## Architecture

`src/services/SoqlAnalysisProgress.ts` contains the status model, per-request `AsyncLocalStorage` context for org matching, monotonic integer work-based progress, and bounded 5-minute retention of completed snapshots.

The browser creates an unguessable UUID and sends it as an **optional** `progressId` in the existing SOQL POST body. The existing single/all-personas POST response contracts remain unchanged.

`GET /api/soql-analysis/progress/:id` returns only aggregate stage, mode, state, integer percent, elapsed seconds, and completed/total counters. It does **not** return usernames, user IDs, query text, record IDs, file paths, object names, org names or tokens. The endpoint reads only in-process state (no Salesforce or filesystem calls) and is served before repository resolution middleware.

`web/src/hooks/useSoqlAnalysisProgress.ts` polls the status at 900 ms intervals, with cleanup on completion/unmount. A temporary missing job ID or request error does not cancel the underlying analysis.

The service starts scan, preparation, permission, and Excel stages at actual boundaries. Single-persona checks additionally report completed object evaluations via the existing bounded analyzer loop. All-personas mode reports completed personas after each full evaluation, with the existing cap of **two concurrent personas** unchanged. Org-user matching is observed from the central `SalesforcePersonaAccessVerifier` without adding any verification queries.

This is an **in-process** workflow designed for the single-process local/desktop API. A backend restart loses in-flight progress; the POST continues to own the real result/error response.

## Verification

- `npm run build`
- `npm run test:all` (includes `tests/soqlAnalysisProgress.test.ts`)
- `cd web; npm run build`
- Manual checks: single persona / all personas, connected-org / repository-only, empty queries, slow Salesforce checks, failed Excel output, simultaneous-run 409, reload during active analysis, output folder selection.

**Accuracy note:** Percent is an estimate of the fraction of work steps completed, not elapsed fraction of total execution time. It can pause on long Salesforce checks without implying a hang.

**Branch sequencing:** This PR starts from `main` after #44, independent of the still-open UI cleanup PR #45. If #45 is merged first, refresh this PR against the updated `main` before merging.
