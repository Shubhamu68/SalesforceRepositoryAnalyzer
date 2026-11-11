# One-time report output folder setup

The **Run SOQL Analysis** button now checks a report directory before starting the scan.

## Windows / localhost experience

1. Launch the backend from the Analyzer root with `npm run api` and the UI from `web` with `npm run dev`.
2. Open SOQL Security Analysis, select a persona, and click **Run SOQL Analysis**.
3. If `SALESFORCE_ANALYZER_OUTPUT_DIRECTORY` is missing, empty, nonexistent, a file, or inaccessible, the UI shows **Choose Report Output Folder**.
4. Click **Choose Folder & Run Analysis**. A **native Windows folder chooser** opens from the local Express backend. Select an existing folder or create one.
5. The backend verifies that it can create a file in that folder, saves the setting in the Analyzer root `.env`, updates its live process configuration, closes the modal, and runs the requested SOQL analysis automatically.
6. On later runs, an existing valid directory skips the modal and SOQL analysis starts normally. No API restart is required after choosing.

Cancelling the native picker or the modal does not write `.env` or execute the SOQL analysis.

## What is written to .env?

Example:

```properties
SALESFORCE_ANALYZER_OUTPUT_DIRECTORY="C:/Users/Example/Desktop/SalesforceAnalyzerOutputReports"
```

- If `.env` is missing, it is created with this entry.
- If `.env` exists, its existing entries, comments, and Salesforce credentials are preserved.
- If this key is present but invalid, it is **replaced**, not duplicated.
- Backslashes in Windows paths are normalized to forward slashes in the saved value; Windows accepts these paths.
- The selected directory is reflected in `process.env` immediately, because Node does not automatically reread `.env` after startup.

This path is a **folder**, not an Excel filename. Excel and TXT files are generated in the chosen directory as before.

## Why not the browser's file selector?

Browsers intentionally do not reveal unrestricted absolute filesystem paths. Our Analyzer runs on the **same Windows workstation** as the UI, so the Express backend invokes a native Windows Forms folder picker using PowerShell with a fixed script and no user-provided shell input.

The configuration HTTP endpoint never accepts an arbitrary output path from the browser. It persists only a folder selected by the native dialog. API access is bound to loopback, and the configuration router also rejects nonlocal browser origins.

This mechanism is for **local Windows testing only**. It is not suited to a remote multiuser deployment or to a Linux-hosted backend. When an Electron version is introduced, replace the folder-picker adapter with Electron's native dialog and use an application-data configuration path.

## Advanced / headless configuration

The backend still reads `SALESFORCE_ANALYZER_OUTPUT_DIRECTORY` from an existing shell environment or the Analyzer root `.env`, and will not prompt if that value points to a valid writable directory.

The interactive CLI (`npm run analyze`) has no graphical dialog; it uses the configured path or defaults to `./reports`. The UI/API workflow **does not** fall back silently: it requires folder configuration to be valid.

`SALESFORCE_REPOSITORY_PATH` remains a separate, required startup setting. Selecting the report output folder does not configure the Salesforce source repository.

## Validation

The new Node test suite covers: missing setting, .env creation, preservation of existing secrets/comments/CRLF, replacing duplicate or invalid entries, cancellation, invalid and non-writable selection, concurrent picker requests, immediate real Excel/TXT generation, localhost HTTP routes and origin restriction, and non-Windows error handling.
