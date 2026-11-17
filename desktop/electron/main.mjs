import { app, BrowserWindow, dialog, session, shell } from "electron";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import path from "node:path";
import { isAllowedExternalUrl, resolveDesktopPaths } from "./runtimePaths.mjs";
import { createDesktopStartupTrace } from "./startupTrace.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = app.isPackaged
  ? path.join(process.resourcesPath, "analyzer")
  : path.join(dirname, "staging");
const userData = app.getPath("userData");
const localSettings = path.join(userData, ".env");
const startupTrace = createDesktopStartupTrace(userData);
startupTrace.mark("main-loaded");
let backend = null;
let window = null;
let allowedAppOrigin = null;
let shuttingDown = false;

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

function prepareLocalSettings(template) {
  mkdirSync(path.dirname(localSettings), { recursive: true });
  if (!existsSync(localSettings)) copyFileSync(template, localSettings);
}

async function pickUnusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a local port.");
  await new Promise(resolve => listener.close(resolve));
  return address.port;
}

function stopBackend() {
  shuttingDown = true;
  if (backend && backend.exitCode === null) backend.kill();
  backend = null;
}

/**
 * Create the window BEFORE waiting for the API. Showing a local startup
 * screen makes backend initialization visible instead of a silent 1–2 minute
 * wait on Windows. The real React UI replaces it once the API is healthy.
 */
function openWindow() {
  const splashFile = path.join(dirname, "splash.html");
  const splashUrl = pathToFileURL(splashFile).href;
  window = new BrowserWindow({
    title: "Salesforce Repository Analyzer",
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#f5f7fb",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
    },
  });
  startupTrace.mark("window-created");

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    // Only the bundled startup screen or the dynamically assigned local API
    // may load in the desktop window. External links use the system browser.
    let allowed = url === splashUrl;
    if (allowedAppOrigin) {
      try {
        allowed ||= new URL(url).origin === allowedAppOrigin;
      } catch { /* Reject invalid navigation URLs. */ }
    }
    if (!allowed) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("did-finish-load", () => {
    const loaded = window?.webContents.getURL();
    if (loaded === splashUrl) startupTrace.mark("splash-rendered");
    else if (loaded && allowedAppOrigin) {
      try {
        if (new URL(loaded).origin === allowedAppOrigin) startupTrace.mark("ui-rendered");
      } catch { /* A malformed navigation is never trusted. */ }
    }
  });
  window.on("closed", () => { window = null; app.quit(); });
  return window.loadFile(splashFile).then(() => true).catch(() => {
    startupTrace.mark("startup-failed");
    if (!shuttingDown) {
      dialog.showErrorBox("Unable to show startup screen",
        "The desktop application resources are incomplete.");
      app.quit();
    }
    return false;
  });
}

async function showWorkspace(origin) {
  if (!window || window.isDestroyed() || shuttingDown) return;
  allowedAppOrigin = origin;
  await window.loadURL(origin);
}

async function startBackend() {
  const paths = resolveDesktopPaths(desktopRoot);
  for (const required of [paths.node, paths.backend, paths.frontendIndex, paths.template]) {
    if (!existsSync(required)) throw new Error("Desktop package is incomplete. Reinstall the application.");
  }
  prepareLocalSettings(paths.template);
  const saved = parseEnv(readFileSync(localSettings, "utf8"));
  const environment = { ...process.env };
  // The app has no OAuth client secret; CLI owns authorization.
  for (const key of ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET", "SALESFORCE_LOGIN_URL"]) {
    delete environment[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (key.startsWith("SALESFORCE_") &&
        !["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET", "SALESFORCE_LOGIN_URL"].includes(key)) {
      environment[key] = value;
    }
  }
  const port = await pickUnusedPort();
  const origin = "http://127.0.0.1:" + port;
  backend = spawn(paths.node, [paths.backend], {
    cwd: desktopRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      SALESFORCE_ANALYZER_ENV_PATH: localSettings,
      SALESFORCE_ANALYZER_PORT: String(port),
      SALESFORCE_ANALYZER_STATIC_DIR: paths.frontend,
    },
  });
  startupTrace.mark("backend-spawned");
  backend.stdout.on("data", chunk => {
    if (!app.isPackaged) process.stdout.write(chunk);
  });
  // Do not write CLI output, Salesforce tokens or user data to persistent logs.
  backend.stderr.on("data", chunk => {
    if (!app.isPackaged) process.stderr.write(chunk);
  });
  backend.once("error", () => {
    if (!shuttingDown) {
      dialog.showErrorBox("Analyzer could not start", "The local Analyzer service could not be started.");
      app.quit();
    }
  });
  backend.once("exit", () => {
    if (!shuttingDown) {
      dialog.showErrorBox("Analyzer stopped", "The local Analyzer service stopped unexpectedly.");
      app.quit();
    }
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend.exitCode !== null || backend.killed) break;
    try {
      // Liveness does not rescan the user's Salesforce repository. Detailed
      // setup status is still returned by the existing /api/health endpoint.
      const response = await fetch(origin + "/api/health/live", {
        signal: AbortSignal.timeout(800),
      });
      if (response.ok && (await response.json()).status === "ok") {
        startupTrace.mark("backend-ready");
        return origin;
      }
    } catch { /* Backend is not ready yet. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Analyzer API did not start. Verify the application package.");
}

app.on("before-quit", stopBackend);

if (primaryInstance) app.whenReady().then(async () => {
  startupTrace.mark("electron-ready");
  // The UI is local, but still sandbox its renderer and deny sensitive privileges.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  try {
    const splashReady = openWindow();
    const origin = await startBackend();
    // Preserve the startup view until its local file load completes; otherwise
    // a very fast backend could race the first page navigation.
    if (await splashReady) await showWorkspace(origin);
  } catch {
    startupTrace.mark("startup-failed");
    if (!shuttingDown) {
      stopBackend();
      dialog.showErrorBox("Unable to open Analyzer",
        "The desktop service could not start. See startup-timing.log in the app data folder.");
      app.quit();
    }
  }
}).catch(() => app.quit());
