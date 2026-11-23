# Windows portable setup — browser launcher

This is the **browser-based Windows portable edition** (`Start Analyzer.cmd`), **not** the Electron desktop-folder ZIP currently shared with v0.1.0 recipients. For the Electron application launched with `Salesforce Repository Analyzer.exe`, see [Windows desktop setup](windows-desktop.md).

The portable browser distribution bundles Node.js but serves the React UI through a local browser. It does not require recipients to install Node.js/npm or VS Code.

## Obtain a build

- For internal testing, an authorized maintainer can run [Build Windows Portable Analyzer](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-portable.yml) and download the temporary CI artifact. GitHub Actions artifacts may be wrapped in a second archive and expire after 30 days.
- The separate [Publish Windows Portable Release](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/release-windows.yml) workflow creates an official Release **only** after an approved version tag and successful validation. At the time of this documentation update, no `v0.1.0` GitHub Release has been published.
- A new source commit does not modify previously downloaded ZIPs.

## Start

1. Extract the **entire** `SalesforceRepositoryAnalyzer-Windows-Portable.zip` into a writable local folder.
2. Double-click **`Start Analyzer.cmd`**. The launcher opens the application in your default browser and keeps a console window running its local API.
3. Select the root of the Salesforce metadata repository (containing `force-app/main/default`) when prompted.
4. Choose an existing, writable Excel output directory when prompted.
5. Optionally connect to a Salesforce org using your **Salesforce CLI session**. If you do not need connected-org features, continue repository-only where supported.

Keep the launcher console open while using the app; closing it stops the backend.

## Optional Salesforce CLI login

- Install Salesforce CLI **v2.136.0 or newer** and ensure `sf` is available on PATH when you need connected-org features.
- Select a saved authorized CLI org, or use the Analyzer's Salesforce browser login for Sandbox or Production.
- Sign in on Salesforce's official login page (including SSO/MFA where required).
- The Analyzer does **not** request a Salesforce password, custom connected-app client ID, or client secret.
- Disconnecting from the Analyzer does not revoke Salesforce CLI authorization.

The extracted distribution creates a **local**, untracked `.env` file from the bundled `.env.example`. For optional manual path configuration:

```ini
SALESFORCE_REPOSITORY_PATH=C:/Your/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
SALESFORCE_API_VERSION=v62.0
```

Never include your local `.env`, org tokens, CLI auth files, or proprietary Salesforce records when sharing a ZIP.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `runtime/node.exe` missing | Extract the complete ZIP; do not run the launcher from inside the archive. |
| Local UI does not open | Read console output and check organizational endpoint protection policies. |
| Salesforce repository path rejected | Select the root containing `force-app/main/default`, not `classes`. |
| Excel report cannot be saved | Choose a writable output directory. |
| Salesforce org connection unavailable | Install/update Salesforce CLI, ensure `sf --version` works and reauthenticate if needed. |
| Folder picker unavailable | Interactive Windows PowerShell is required for the native folder dialog. |

For packaged-launcher details, see [the browser portable README](../../desktop/windows/README.txt).
