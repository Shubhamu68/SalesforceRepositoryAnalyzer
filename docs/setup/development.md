# Development setup

## Requirements

- **Node.js 24** and npm (matching CI).
- Git and a checked-out Salesforce metadata repository with `force-app/main/default`.
- Windows PowerShell and an interactive desktop session if using the native folder-selection dialogs.
- Salesforce connected-app credentials **only** if you want live-org verification; follow your organization's credential and least-privilege policies.

## Run the app locally

```powershell
git clone https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer.git
cd SalesforceRepositoryAnalyzer
npm ci
Copy-Item .env.example .env
npm run api
```

In another terminal:

```powershell
cd web
npm ci
npm run dev
```

Open the Vite URL shown by the frontend. Express defaults to `localhost:3000`; the dev server proxies API requests. Do not assume a green `API connected` indicator means Salesforce credentials or repository metadata are configured.

The UI guides you to select a valid metadata repository, and asks for a writable output directory when needed. To preconfigure them in the untracked project-root `.env`:

```ini
SALESFORCE_REPOSITORY_PATH=C:/Work/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
```

Optional authenticated org verification:

```ini
SALESFORCE_LOGIN_URL=https://test.salesforce.com
SALESFORCE_API_VERSION=v62.0
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
```

If credentials are missing, supported SOQL/Stack analyses can continue in repository-only mode after the relevant warning. If supplied credentials are invalid, org-dependent preflight may block those analyses. Use approved Salesforce integration credentials; never add real credentials to example files.

## Build and test

```powershell
npm run build
npm run test:all
cd web
npm run build
npm run lint
```

The repo's `tests/*.test.ts` files are automatically discovered by `scripts/run-all-tests.mjs`. GitHub Actions runs backend regression, TypeScript builds and frontend production builds on Windows and Ubuntu for PRs.

## Code and PR workflow

1. Update local `main`: `git fetch origin; git checkout main; git pull --ff-only`.
2. Create a topic branch from the verified `main` (`feature/...`, `fix/...`, `chore/...`).
3. Add changes plus focused tests. Do not move permission logic into UI-only components.
4. Run the checks above, push, then open a PR for UAT. Never merge as part of automated implementation.
5. Approved PRs are merged manually; only tagged, tested versions are eligible for a Release.

See [Contributing](../../CONTRIBUTING.md), [Architecture](../architecture.md), and [Releases](../releases.md).
