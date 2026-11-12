# Salesforce Repository Setup and Org Verification Preflight

## First launch

The Node/Express API now starts without `SALESFORCE_REPOSITORY_PATH`.
When the React UI opens, the Analyzer calls `GET /api/repository/status`.
If missing or invalid it presents **Choose Salesforce Repository**, using the
same foreground Windows folder picker as the Excel output configuration.

Select the **repository root**, not its `force-app` folder:

```text
SalesforceRepo/
└── force-app/main/default/
    ├── classes/              (contains *.cls)
    ├── objects/
    ├── permissionsets/
    ├── permissionsetgroups/
    └── mutingpermissionsets/
```

`flows/` is optional. Missing required folders or Apex classes cause a
visible validation error. Nothing is saved or analyzed on an invalid selection.

The backend writes `SALESFORCE_REPOSITORY_PATH="..."` in the root `.env`:
- Existing `.env`: replace the setting without duplicating it; preserve comments,
  newline format and unrelated settings, including Salesforce secrets and report output.
- Missing `.env`: create it with only the selected path.
- Cancelled dialog or invalid repo: no changes to `.env` or `process.env`.
- Successful selection: makes the repository available immediately without
  restarting the API and refreshes objects/personas.
- Existing valid path: skips the prompt.
- Repo removed/invalidated later: API blocks every repository-based analysis
  with `409 REPOSITORY_NOT_CONFIGURED` rather than using stale paths.

The API centrally gates Object/Field Access, Object Access Matrix, SOQL Security,
Stack Trace, and repository metadata lookups. No analysis starts with an invalid
repository, even when called directly outside the UI.

## Salesforce OAuth preflight (SOQL and Stack Trace only)

The browser and API check the Salesforce Client Credentials before these two
operations start:

| Condition | Behavior |
| --- | --- |
| Both credentials missing | Warning lists both keys. Confirm to analyze repository only, or cancel |
| One credential missing | Warning names the missing key. Confirm for repository only |
| Credentials present and authentication succeeds | Repository + live-org fallback |
| Credentials present but invalid, login URL incorrect, or org unreachable | Blocking error. No analysis runs |

The server rejects requests that attempt repository-only analysis without
`acknowledgeRepoOnly: true`. In repository-only mode, **no live-org permission
lookup or relationship Describe is attempted**; repo-missing access is
UNVERIFIED, never fabricated as a denial.

To change Client Credentials, edit `.env` and restart the backend.
Neither credentials nor access tokens are returned to the browser.

The local API routes are `GET /api/analysis/preflight`,
`GET /api/repository/status`, and `POST /api/repository/choose` (the
latter only opens a native selector, never accepts user-supplied paths).

## Separate output path

`SALESFORCE_ANALYZER_OUTPUT_DIRECTORY` continues to be configured by the
existing Excel folder picker after repository validation. Each SOQL run
generates one Excel Summary workbook, not TXT files.

## Platform limits

The native folder chooser requires a local Windows desktop session.
The package has not been converted to Electron; Electron can replace this
picker adapter later. The CLI remains headless and expects repository
configuration in its environment.

## Testing

`npm run build`, `npm run test:all`, and `npm --prefix web run build`.
Tests cover missing/valid/invalid repositories, missing structural folders,
.env creation/preservation/deduplication, cancellations, status invalidation,
local-only HTTP routes, missing/partial/valid/invalid credentials, explicit
repository-only acknowledgement, and both Windows picker variants.
