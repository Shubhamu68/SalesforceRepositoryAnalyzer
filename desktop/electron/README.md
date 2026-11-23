# Salesforce Repository Analyzer — Windows Desktop Folder

This Electron desktop edition runs the existing React UI and Express API. The team distribution is **one ZIP containing the complete `win-unpacked` folder**, not an installer or separate self-extracting EXE.

**For recipients:** Start with the [Windows desktop installation guide](../../docs/setup/windows-desktop.md). Extract the complete ZIP and open `win-unpacked/Salesforce Repository Analyzer.exe`. Keep the EXE, DLLs, `resources` directory and bundled Node runtime together. The EXE inside the folder launches the application; no additional standalone EXE is provided.

## Build locally on Windows (maintainers)

```powershell
npm ci
npm run build
cd web
npm ci
npm run build
cd ..
node desktop/electron/stage.mjs
cd desktop/electron
npm install --no-audit --no-fund
npm run build:folder
```

[Build Windows Desktop Folder ZIP](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/actions/workflows/windows-desktop.yml) builds the application, runs regression checks, smoke-tests the staged and packaged backend, and publishes **only** the temporary `SalesforceRepositoryAnalyzer-Desktop-Folder-ZIP` Actions artifact containing `SalesforceRepositoryAnalyzer-Desktop-Unpacked.zip`.

**This Electron ZIP is not currently published through the automatic version-tagged GitHub Release workflow**; that workflow handles the distinct browser-based `Start Analyzer.cmd` package. See [Builds and releases](../../docs/releases.md).

## Requirements and authentication

- **Recipients:** Windows 10/11. No separate Node.js, npm, Git or VS Code required to run the packaged app.
- **Optional connected-org features:** Salesforce CLI **v2.136.0+** must be installed and available on PATH. Choose a saved authorized CLI org or log in via Salesforce's official browser page.
- **Repository-only analysis:** does not require Salesforce CLI login, subject to the relevant feature's limitations.
- No Analyzer-specific OAuth client ID or client secret is required. The app never asks for a Salesforce password.

## Security and diagnostics

The executable is **unsigned**. ZIP packaging does not bypass SmartScreen, WDAC or corporate endpoint protection. Seek IT approval/signing instead of disabling security policies.

The renderer is sandboxed and the API listens only on localhost; Salesforce login is delegated to Salesforce CLI. Per-user settings are stored in Electron's user-data folder, not inside the distributed ZIP. `startup-timing.log` records safe phase/error categories; it does not store raw backend stderr, credentials or full local paths.

The blue hexagon from the Analyzer header is also the executable/window icon. If Windows caches an older icon for a shortcut, unpin and re-pin the executable.

The browser-based `Start Analyzer.cmd` package remains a [separate fallback](../../docs/setup/windows-portable.md).
