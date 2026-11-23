# Development setup

This guide is for contributors running the source project; **recipients of the v0.1.0 Electron desktop-folder ZIP do not need to install Node.js, npm, Git, or VS Code**. See [Windows desktop setup](windows-desktop.md).

## Requirements

- **Node.js 24** and npm (matching the backend build/CI).
- Git and a checked-out Salesforce metadata repository with `force-app/main/default`.
- Windows PowerShell and an interactive desktop session if using native folder-selection dialogs.
- **Salesforce CLI v2.136.0+** on PATH **only if** using Salesforce org login or connected-org verification. The Analyzer uses individual Salesforce CLI browser authorization, not Analyzer-managed client credentials.

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

Open the Vite URL displayed by the frontend. Express defaults to `localhost:3000`; Vite proxies `/api` requests. The `API connected` indicator confirms the local API, **not** Salesforce org authorization or a valid repository selection.

The UI can request the local metadata repository and Excel output folder. To preconfigure them, edit the untracked project-root `.env`:

```ini
SALESFORCE_REPOSITORY_PATH=C:/Work/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
SALESFORCE_API_VERSION=v62.0
```

For optional connected-org verification, install Salesforce CLI, select a saved authorized org or choose Sandbox/Production login through the Analyzer UI. Salesforce credentials are entered on the official Salesforce login page; **do not configure `SALESFORCE_CLIENT_ID` or `SALESFORCE_CLIENT_SECRET` for this app**. Supported analyses may run repository-only without an org connection, but some org-dependent checks remain unavailable/inconclusive.

## Build and test

```powershell
npm run build
npm run test:all
cd web
npm run build
npm run lint
```

The `tests/*.test.ts` files are discovered by `scripts/run-all-tests.mjs`. GitHub Actions runs compilation/regression checks on Windows and Ubuntu for PRs. Verify actual CI status before merging.

## Electron desktop folder ZIP

The desktop edition is packaged **on Windows** and bundles its own runtime. Its production artifact contains the full `win-unpacked` directory, including `Salesforce Repository Analyzer.exe`, DLLs, `resources`, and the Analyzer backend.

- Build notes: [Electron desktop folder README](../../desktop/electron/README.md)
- CI workflow: [Build Windows Desktop Folder ZIP](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-desktop.yml)
- Recipient guide: [Windows desktop setup](windows-desktop.md)

The desktop ZIP is **not** the browser-based `Start Analyzer.cmd` portable ZIP, and the current automated tagged GitHub Release workflow publishes **only the browser-based portable** artifact. Do not describe an Actions artifact or emailed ZIP as an official tagged Release without confirming it has been published.

## Code and PR workflow

1. Update local `main`: `git fetch origin; git checkout main; git pull --ff-only`.
2. Create a topic branch from verified `main` (`feature/...`, `fix/...`, `docs/...`, `chore/...`).
3. Add focused changes and regression tests when behavior changes; keep permission logic shared rather than UI-specific.
4. Run checks, push the branch and open a PR for review/UAT. Do not merge automatically.
5. The owner/maintainer separately approves any version tag and official Release.

See [Contributing](../../CONTRIBUTING.md), [Architecture](../architecture.md) and [Release process](../releases.md).
