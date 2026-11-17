# Windows portable setup

This distribution is a **local web application with a double-click Windows launcher**—not a native Electron executable. It embeds `node.exe`, so recipients do not need to install Node.js, npm or VS Code.

## Download a tested version

- Preferred: [GitHub Releases](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/releases). A published release includes the approved portable ZIP and a SHA256 checksum file.
- If no Release is available yet, an authorized developer can run **Build Windows Portable Analyzer** from [Actions](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-portable.yml) and retrieve its temporary artifact. Actions artifacts expire after 30 days and may contain an outer archive wrapping the actual ZIP.
- A new application feature does **not** update previously generated ZIPs; rebuild or publish a new release after merging and testing.

## Start

1. Extract the **entire** `SalesforceRepositoryAnalyzer-Windows-Portable.zip` to a writable folder.
2. Double-click `Start Analyzer.cmd`. The launcher opens a local browser URL and keeps a console window running the API.
3. Select your Salesforce metadata repository root, containing `force-app/main/default`, when prompted.
4. Choose a writable Excel report-output folder if prompted on the first SOQL run.
5. Use optional Salesforce org verification only with appropriately authorized credentials. The portable distribution creates a local `.env` from the safe `.env.example` on first run.

Keep the console open while using the app. Closing it stops the backend API.

## Configuration

Only the extracted folder's local `.env` stores paths and any credentials:

```ini
SALESFORCE_REPOSITORY_PATH=C:/Your/SalesforceRepo
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY=C:/Users/You/Documents/AnalyzerReports
SALESFORCE_LOGIN_URL=https://test.salesforce.com
SALESFORCE_API_VERSION=v62.0
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
```

**Never** include your own `.env` in a Git commit or shared ZIP. Each recipient should configure their own paths and obtain credentials through an approved channel. A distributed client secret can be extracted, so do not treat this mechanism as a secure end-user OAuth flow.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Launcher says `runtime/node.exe` missing | Extract the complete ZIP; do not run it inside the compressed folder. |
| Local UI does not open | Read console output; verify no corporate endpoint policy is blocking the runtime. |
| Repository path rejected | Select the root containing `force-app/main/default`, not the `classes` directory. |
| Excel report cannot be saved | Select an existing, writable output folder. |
| Org verification unavailable | Check approved Salesforce credentials and login endpoint; use repository-only mode where supported. |
| Folder picker unavailable | Interactive Windows PowerShell is required by the existing native folder dialog. |

For additional packaged-launcher details, see [`desktop/windows/README.txt`](../../desktop/windows/README.txt).
