# Windows desktop setup — Electron folder ZIP

This is the **Electron desktop-folder edition** distributed to v0.1.0 recipients. It is a complete extracted application folder, **not an installer or single-file executable**. The older browser-based `Start Analyzer.cmd` distribution is described separately in [Windows portable setup](windows-portable.md).

## Requirements

- Windows 10/11 and permission to run software approved by your organization.
- A local checkout or copy of the Salesforce metadata repository you want to analyze, with `force-app/main/default`.
- A writable folder for Excel reports.
- **Salesforce CLI v2.136.0 or later**, available on PATH, **only if using connected-org verification or Salesforce login**.
- No separate Node.js, npm, Git or VS Code installation is needed to *run* the packaged desktop application.

## Launch from the shared ZIP

1. Obtain the approved `SalesforceRepositoryAnalyzer-Desktop-Unpacked.zip` from the team. The separate [Build Windows Desktop Folder ZIP](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-desktop.yml) workflow produces temporary test artifacts for maintainers; this is **not** the GitHub Releases publication workflow.
2. Extract the ZIP completely to a local folder. **Do not launch the EXE from inside the archive.**
3. Open `win-unpacked` and launch **`Salesforce Repository Analyzer.exe`**.
4. Keep the `win-unpacked` contents together, including its EXE, DLLs, `resources` directory and bundled runtime. Moving just the EXE will break the app.
5. After the desktop window opens, select the **Salesforce metadata repository root** and a writable Excel report output folder when prompted.
6. To connect to a Salesforce org, select an authorized Salesforce CLI org or choose **Log in to Sandbox** / **Log in to Production**. Sign in on the Salesforce page (including SSO/MFA as required). Alternatively, continue in **repository-only** mode where supported.

The desktop package stores per-user configuration outside the shared ZIP in Electron's user-data folder. It creates the local settings file from the packaged safe `.env.example` template. The distributable ZIP should not contain a real `.env`, Salesforce token, CLI auth file or customer repository.

## Salesforce authentication

The Analyzer uses **Salesforce CLI-managed OAuth**. Install Salesforce CLI v2.136.0+ and ensure `sf` is available on PATH if you intend to connect to a Salesforce org.

- Saved CLI orgs can be selected from within the application.
- New logins open the regular official Salesforce browser login page; never enter your Salesforce credentials into the Analyzer itself.
- The Analyzer does **not** require a custom connected-app client ID, client secret or shared integration identity.
- Disconnecting inside the Analyzer ends its in-memory session but does **not** remove the saved authorization from Salesforce CLI or VS Code.
- Without Salesforce CLI or an authenticated org, supported repository-only analysis remains available, but org-specific verification will not run.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Windows blocks the unsigned executable | Follow your organization's IT approval/signing process; **do not bypass SmartScreen, WDAC or endpoint controls**. |
| Application cannot find resources or does not start | Re-extract the **entire** `win-unpacked` folder; verify the `resources` directory and DLLs are present. |
| Repository selection is rejected | Select the repository **root** containing `force-app/main/default`, not a `classes` subfolder. |
| Excel file cannot be saved | Select a writable local output directory. |
| Salesforce login is not available | Install/update Salesforce CLI (2.136.0+) and ensure `sf --version` works from a terminal; reauthenticate if the saved CLI org has expired. |
| Desktop API stops unexpectedly | Review `startup-timing.log` in the app's Electron user-data folder for safe startup-phase or backend-exit diagnostics. Avoid sharing real customer data or raw sensitive logs. |

## For maintainers

The [desktop build workflow](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-desktop.yml) runs backend/frontend builds, regression tests, staged and packaged smoke tests, and creates a **Desktop Folder ZIP** artifact. Its temporary CI artifact is distinct from the automated **browser-portable** [GitHub Release workflow](../releases.md). The current repository has no published `v0.1.0` Release; don't promise a desktop ZIP through the Releases page unless that publication mechanism is added and validated.

See [Electron build notes](../../desktop/electron/README.md), [Security practices](../security.md), and [Release/distribution process](../releases.md).
