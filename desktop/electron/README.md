# Salesforce Repository Analyzer — desktop

This is an **Electron portable Windows .exe** wrapping the same local React UI and Express API as the existing browser launcher. The original Windows ZIP, development UI and analyzer modules remain available.

## Run / build (Windows)

From the repository root:

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
npm start
```

To build locally, run `npm run build:win` from `desktop/electron`. The **Build Windows Desktop EXE** GitHub Actions workflow now publishes **two download options**:

- **Desktop-Folder-ZIP (for testing):** Download, extract fully, open `win-unpacked/Salesforce Repository Analyzer.exe`. All Electron DLLs, resources, the bundled Node runtime, and the Analyzer UI/API must remain together. No installer or self-extraction is involved.
- **Desktop-Portable:** Existing single-file portable `.exe` (self-extracts at launch).

Both distributions still run an **unsigned .exe**. A ZIP does **not** bypass SmartScreen, WDAC, or company endpoint-security policy. If either launch is blocked, ask IT to approve/sign the app; do not disable security protection. The existing **Windows browser portable ZIP** (`Start Analyzer.cmd`) is a separate non-Electron fallback.

**Requirements for users:** Windows 10/11 and Salesforce CLI 2.136+ on PATH for optional org login. Users do not need Node.js, npm, Git or VS Code.

**Settings:** The desktop app saves repository/report paths under Electron's per-user application data folder. It packages only `.env.example`; never a developer's `.env`, CLI authentication files or Salesforce tokens.

**Startup diagnostics:** A small startup screen now appears before the local API is ready. The same user-data folder contains `startup-timing.log`, which records only timestamps, fixed startup phases and durations. Compare `main-loaded`, `electron-ready`, `backend-ready`, and `ui-rendered` after launching the updated build. If the window itself takes a long time to appear before `main-loaded`, Windows scanning or Electron process startup may be involved; the log cannot measure time before Electron main code begins.

**Security:** React runs in a sandboxed Electron window without Node integration. The API stays on a random loopback port, and Salesforce CLI OAuth opens in the system browser. Org checks and permission analysis use the existing backend unchanged.

This first build retains the current Windows PowerShell folder pickers. Electron-native folder dialogs and an installer can be added later after a successful Windows end-to-end smoke test. Portable EXEs may trigger Windows SmartScreen until the app is signed and approved by the organization's IT/security team.
