# Salesforce Repository Analyzer — Windows Desktop Folder

This Electron desktop edition runs the existing React UI and Express API. The team distribution is **one ZIP containing the complete `win-unpacked` folder**, not a separate portable, self-extracting EXE.

## Build locally on Windows

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

The **Build Windows Desktop Folder ZIP** GitHub Actions workflow compiles and smoke-tests the backend and frontend, then runs `electron-builder --dir`. It publishes only:

- **SalesforceRepositoryAnalyzer-Desktop-Folder-ZIP:** Download, extract completely, and open `win-unpacked/Salesforce Repository Analyzer.exe`. Keep the EXE, DLLs, `resources` directory and bundled Node runtime together. The EXE inside the folder is still required to launch the application; there is no longer an additional standalone EXE artifact.

The blue hexagon used in the existing Analyzer header is now also the desktop executable/window icon. Windows may cache the prior Electron icon on a pinned shortcut; unpin and pin the new executable again if needed.

**User requirements:** Windows 10/11 and Salesforce CLI 2.136+ on PATH for optional org login. No separate Node.js, npm, Git or VS Code required.

**Security:** The executable is unsigned; ZIP packaging does not bypass SmartScreen, WDAC or corporate endpoint protection. Contact IT for approval/signing instead of disabling protection. The renderer is sandboxed and the API listens only on localhost; Salesforce browser login is delegated to the CLI.

**Settings and diagnostics:** Per-user settings stay in Electron's userData folder, never in the shared ZIP. `startup-timing.log` records fixed phases and safe error categories only. No developer `.env`, Salesforce tokens or CLI auth files are packaged.

The browser-based Windows portable ZIP (`Start Analyzer.cmd`) remains a separate fallback.
