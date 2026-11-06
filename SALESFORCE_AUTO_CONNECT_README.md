# Salesforce Repository Analyzer — Automatic org connectivity

## What this changes

Replaces **Milestone 1 browser OAuth / PKCE** with **backend-only Client Credentials authentication**. This update assumes the `Salesforce_Org_Connectivity_Milestone_1.zip` files have already been installed.

The Salesforce External Client App has already been configured by the user with Client Credentials enabled and a Run As user; no new app is required.

- When `npm run api` starts, the backend obtains a token automatically.
- Opening the dashboard also checks connection status and triggers a connection attempt if necessary.
- The dashboard header and Salesforce Org page show the result automatically.
- The Salesforce Org page retains read-only standard REST and Tooling SOQL test queries.
- On Salesforce API 401 / INVALID_SESSION_ID, the backend reauthenticates and retries the query **once**.
- A failed connection doesn't stop repository/Stack Trace/SOQL static analysis.
- No OAuth login page or callback is used.
- Existing Profile, Permission Set, PSG, Stack Trace, and access-evaluation rules remain unchanged.

## Apply the patch

Extract this zip into the **root of the current analyzer codebase**, merging folders and replacing the included files. Do not delete any unrelated analyzer files.

**Replace files:**

1. `src/salesforce/SalesforceOrgConnection.ts` — replaces PKCE OAuth with Client Credentials.
2. `src/api/salesforceRoutes.ts` — removes browser OAuth routes; adds reconnect endpoint.
3. `src/api/server.ts` — starts authentication automatically when backend listens.
4. `web/src/App.tsx` — displays automatic Salesforce status in the dashboard/header.
5. `web/src/components/SalesforceOrgConnection.tsx` — removes manual login and disconnect, adds retry/status.
6. `web/src/components/SalesforceOrgConnection.css` — adds "connecting" status styling.
7. `.env.example` — shows new environment variables (example only).
8. `.gitignore` — keeps `.env` ignored and allows safe `.env.example` tracking.

**Added:** `SALESFORCE_AUTO_CONNECT_README.md`.

**No separate source file must be deleted.** The old `/api/salesforce/connect`, `/api/salesforce/oauth/callback`, and `/api/salesforce/disconnect` routes are removed by replacing `src/api/salesforceRoutes.ts`. Existing OAuth callback configuration in Salesforce can be left as-is; it is no longer used by the analyzer.

**No modifications required:** `web/vite.config.ts` (keep the Vite proxy installed in Milestone 1), `web/src/App.css`, `package.json`, persona/access evaluator code.

## Update the real `.env` at the project root

Keep the existing `SALESFORCE_REPOSITORY_PATH` and any other project-specific settings.

```properties
SALESFORCE_CLIENT_ID=PASTE_YOUR_CONSUMER_KEY
SALESFORCE_CLIENT_SECRET=PASTE_YOUR_CONSUMER_SECRET
SALESFORCE_LOGIN_URL=https://adpact-advantage--otcdevph3.sandbox.my.salesforce.com
SALESFORCE_API_VERSION=v62.0
```

Use the **exact Consumer Secret** from the External Client App — not a Salesforce user password or security token. Do not upload or commit the real `.env`.

Remove these obsolete Milestone 1 settings from the real `.env` if present:

```text
SALESFORCE_CALLBACK_URL
SALESFORCE_UI_ORIGIN
```

They are ignored by the new code. The Salesforce External Client App must have **Client Credentials Flow enabled** and a **Run As** user configured. No redirect URI is needed by this flow.

The current Run As user is a **System Administrator**, which has broad API access. This is suitable only for a controlled sandbox proof of concept. Before wider deployment, use a dedicated integration user with least-privilege permissions, and restrict/secure local API access.

## Run the analyzer

In a terminal from the analyzer root:

```powershell
npm run build
npm run api
```

In another terminal:

```powershell
cd web
npm run build
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). **Do not click a Connect button:** it no longer exists.

Expected backend message:

```text
Salesforce Repository Analyzer API running on http://localhost:3000
Salesforce org authenticated (Client Credentials).
```

If auth fails, the backend logs a brief error while remaining available for repository analysis. The frontend shows `Salesforce unavailable` and the Salesforce Org page provides `Retry connection`. Opening the dashboard or Salesforce Org page triggers connection attempts (failed attempts are throttled briefly).

## Verify

1. Open the main **Dashboard**. Header should say **Salesforce connected** and the summary should show **Salesforce org: Connected automatically**.
2. Visit **Salesforce Org**. Confirm the `organizationId`, `userId`, and sandbox instance URL.
3. Click **Test standard SOQL** — expected `Organization` record.
4. Click **Test Tooling API SOQL** — expected an `ApexClass` response.
5. Click **Test OrderItemSummary access** — expected the configured **Run As user's** `UserEntityAccess` row (if available). This is **not** proof for other personas.
6. Restart `npm run api`; connection should re-establish automatically without browser authorization.

The backend and frontend continue working with the existing repository-based security rules. Live access verification, dynamic user-to-persona matching, and permission-status fallback are **future milestones**, not included in this patch.

## Local API endpoints

- `GET /api/salesforce/status` — token-free status and auto-connect trigger.
- `POST /api/salesforce/reconnect` — force fresh credentials grant (for manual retry).
- `POST /api/salesforce/query` — `{ "api": "data" | "tooling", "soql": "SELECT ..." }`.

Old browser OAuth endpoints are intentionally removed. There is no manually connected session to disconnect; the configured backend integration can reacquire a token at any time.

## Security

- **Never commit `.env` or share the Consumer Secret.** Only the backend reads it.
- No client secrets or bearer tokens are returned in the connection-status API.
- The local query console runs as your **Run As** user. Keep port `3000` bound to `127.0.0.1`, and do not expose this single-user POC publicly.
- Salesforce's Client Credentials flow has **no refresh token**: requesting a new access token on expiration is the correct mechanism.
- If authentication succeeds but a query is denied, verify the Run As user's object permissions and API access.
- OAuth settings and hostnames are configured for one approved org, not arbitrary user-selected destinations.

## Validation performed before packaging

- TypeScript source syntax checks on changed files.
- Strict TypeScript check for the new connection module (with available Node type definitions).
- Mocked tests of automatic token acquisition, concurrent login deduplication, standard SOQL, Tooling SOQL, 401 token renewal, read-only validation, and retry throttling.
- Full npm/React builds could not run here because the ZIP intentionally omitted dependency folders and this environment has no project dependencies installed. **Run both npm builds locally** to confirm full integration.
- Actual Salesforce login with your Consumer Key and Secret must be tested in your sandbox; the credentials were intentionally never provided to ChatGPT.
