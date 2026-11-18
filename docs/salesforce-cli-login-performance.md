# Salesforce CLI login performance: validation guide (Issue #35, PR #39)

## Goal

Measure actual Windows login latency while eliminating unnecessary CLI subprocesses. A fast login must **not** skip fresh access-token retrieval, approved Salesforce HTTPS-origin validation, or Salesforce UserInfo/org identity verification.

## What changed in this branch

- First opening the login screen makes **only** a local `GET /api/salesforce/status` call. It does **not** start `sf --version` or org discovery.
- Click **Load saved orgs** to populate the saved-org dropdown. **Refresh orgs** retries it; discovery is no longer required for **Log in to Sandbox** / **Log in to Production**.
- A fresh browser login starts `sf org login web --instance-url https://test.salesforce.com --json` (or `login.salesforce.com` for Production), without a separate `sf --version` preflight.
- The required secure `sf org auth show-access-token --target-org <username> --json` command is still executed. If the CLI does not support this command, login cannot establish a verified connection.
- The already-authenticated login result's username, orgId and instanceUrl are reused when complete; `sf org display` remains a fallback for missing metadata and saved-org selection.
- Salesforce `GET /services/oauth2/userinfo` and org identity checks still run before reporting connected status.
- The explicit CLI version check remains available **when a user chooses to load saved orgs**, where it is used for compatibility diagnosis. Fresh login instead requires the supported token-retrieval capability directly.

## How to test the application locally

From your local repository (after saving any uncommitted changes):

```powershell
git fetch origin
git switch --track origin/fix/salesforce-cli-post-login-latency
```

If the branch already exists locally, use `git switch fix/salesforce-cli-post-login-latency` followed by `git pull --ff-only`.

Backend terminal:

```powershell
$env:SALESFORCE_AUTH_TIMING = "1"
npm run api
```

Frontend terminal:

```powershell
cd web
npm run dev
```

1. Open the login screen. **Do not** click Load saved orgs yet. Confirm there is no `cli.version` or `cli.savedOrgs` timing entry.
2. Click Log in to Sandbox. Note the time between clicking and the Salesforce login page appearing (manual stopwatch; it is **not** observable in backend CLI JSON timings).
3. Sign in. Note the time from the Salesforce "you can close this window" page to the Analyzer workspace appearing.
4. Copy **only** the lines prefixed `[SF Auth Timing]` from the backend terminal. For complete fresh login metadata, `cli.orgDisplay` should be absent, `cli.accessToken` and `auth.userInfo` must still be present, and `cli.version` should be absent.
5. Return to **Change org** and click **Load saved orgs**. The dropdown should populate. Click **Refresh orgs** to confirm refresh, then select an existing org and verify secure connection. Test cancelled browser login and switching between Sandbox and Production.
6. Keep Issue #35 open until the timing difference is repeatable.

**Important:** `cli.browserLogin` includes time spent typing credentials, completing MFA, and processing post-OAuth CLI work. It cannot be treated as pure application overhead.

## Optional Windows CLI benchmark

Runs `sf --version`, both saved-org listing commands, and optionally **one** protected access-token retrieval. No CLI response or credentials are displayed or saved.

```powershell
.\scripts\Measure-SalesforceCli.ps1 -Runs 3
```

Optional, for a previously authenticated org; the alias is not printed:

```powershell
.\scripts\Measure-SalesforceCli.ps1 -Runs 3 -OrgAlias "your-own-sandbox-alias"
```

Share only the table with operation, run, elapsed seconds and success status. Do **not** share full CLI JSON, an access token, refresh token, browser OAuth URL or `*.json` auth files.

If Windows PowerShell blocks local scripts, consult IT rather than disabling organization-wide script restrictions.

## Timing interpretation

The measured pre-change Windows baseline was approximately:

| Phase | Earlier | PR #39 before on-demand discovery |
| --- | ---: | ---: |
| CLI version | 8.6s | 9.5s |
| Saved-org listing | 13.5s | 19.7s |
| CLI browser login (including user activity) | 44.4s | 29.0s |
| CLI access-token retrieval | 21.2s | 15.8s |
| CLI org display | 20.1s | skipped for complete browser-login metadata |
| Salesforce UserInfo | 0.45s | 0.46s |
| Total login (interactive) | 66.0s | 45.2s |

The **new** implementation should avoid automatic org discovery and the version process on a fresh login, but the token-retrieval and login command may still be slow. Do not predict a speedup from CI alone; compare real Windows timings.

## Deferred investigations

- Use the optional benchmark to decide whether `sf org list auth --json` is faster than `sf org list --skip-connection-status --json`. Do not switch commands based on one sample.
- Evaluate Windows no-shell launcher alternatives using isolated experiments before changing subprocess and cancellation behavior. The `DEP0190` warning is separate and currently unresolved.
- Check installed CLI version and stale authorizations if `sf` startup or post-OAuth processing remains slow.
- Consider direct OAuth with PKCE only as a separately reviewed architecture proposal; do not mix it into this small performance PR.
