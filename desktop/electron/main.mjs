import { app, BrowserWindow, dialog, session, shell } from "electron";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import path from "node:path";
import { isAllowedExternalUrl, resolveDesktopPaths } from "./runtimePaths.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = app.isPackaged
  ? path.join(process.resourcesPath, "analyzer")
  : path.join(dirname, "staging");
const localSettings = path.join(app.getPath("userData"), ".env");
let backend = null;
let window = null;
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

function openWindow(origin) {
  window = new BrowserWindow({
    title: "Salesforce Repository Analyzer",
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#0d1b2f",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    // Never navigate the privileged desktop window away from the local UI.
    if (!url.startsWith(origin + "/") && url !== origin) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => { window = null; app.quit(); });
  void window.loadURL(origin);
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
      const response = await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(800),
      });
      if (response.ok && (await response.json()).status === "ok") return origin;
    } catch { /* Backend is not ready yet. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Analyzer API did not start. Verify the application package.");
}

app.on("before-quit", stopBackend);

if (primaryInstance) app.whenReady().then(async () => {
  // The UI is local, but still sandbox its renderer and deny sensitive privileges.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  try {
    const origin = await startBackend();
    openWindow(origin);
  } catch (error) {
    stopBackend();
    dialog.showErrorBox("Unable to open Analyzer",
      error instanceof Error ? error.message : "Desktop application could not start.");
    app.quit();
  }
}).catch(() => app.quit());
