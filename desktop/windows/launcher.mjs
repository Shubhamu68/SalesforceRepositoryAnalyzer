import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = path.join(root, "runtime", "node.exe");
const backend = path.join(root, "app", "dist", "api", "server.js");
const frontend = path.join(root, "app", "web", "dist");
const exampleEnv = path.join(root, ".env.example");
const localEnv = path.join(root, ".env");

for (const file of [node, backend, path.join(frontend, "index.html"), exampleEnv]) {
  if (!existsSync(file)) {
    console.error("This distribution is incomplete. Missing: " + file);
    process.exit(1);
  }
}

// The checked-in release contains .env.example only. Never overwrite a user's
// existing local settings or configured paths.
if (!existsSync(localEnv)) {
  try {
    copyFileSync(exampleEnv, localEnv, 0);
    console.log("Created .env from the safe template. Salesforce login uses your local sf CLI.");
  } catch (error) {
    console.error("Cannot create .env. Extract the ZIP to a writable folder before launching.");
    process.exit(1);
  }
}

const loadedEnv = parseEnv(readFileSync(localEnv, "utf8"));
const environment = { ...process.env };
// Avoid forwarding old OAuth secrets to the packaged backend at all.
const obsoleteAuthKeys = ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET", "SALESFORCE_LOGIN_URL"];
for (const key of obsoleteAuthKeys) delete environment[key];
for (const [key, value] of Object.entries(loadedEnv)) {
  // Local .env wins over stale inherited PowerShell or Windows variables.
  if (key.startsWith("SALESFORCE_") && !obsoleteAuthKeys.includes(key)) environment[key] = value;
}

async function freeLocalPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No local port available.");
  const port = address.port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launch() {
  const port = await freeLocalPort();
  const url = "http://127.0.0.1:" + port;
  const backendProcess = spawn(node, [backend], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      SALESFORCE_ANALYZER_PORT: String(port),
      SALESFORCE_ANALYZER_STATIC_DIR: frontend,
    },
  });
  backendProcess.stdout.on("data", chunk => process.stdout.write(chunk));
  backendProcess.stderr.on("data", chunk => process.stderr.write(chunk));
  backendProcess.once("error", error => console.error("Could not start local Analyzer API:", error.message));

  const stop = () => { if (backendProcess.exitCode === null) backendProcess.kill(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", stop);

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (backendProcess.exitCode !== null) break;
      try {
        const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(800) });
        if (response.ok && (await response.json()).status === "ok") {
          ready = true;
          break;
        }
      } catch { /* Wait for the local API to become ready. */ }
      await pause(150);
    }

    if (!ready) throw new Error("Analyzer could not start. Check the error details above.");
    console.log("\nSalesforce Repository Analyzer is ready: " + url);
    console.log("Keep this window open while using the tool; close it to stop the local API.\n");

    // Start is a built-in Windows CMD command. The URL contains only a chosen
    // numeric localhost port, never user-supplied arguments.
    const opener = spawn("cmd.exe", ["/d", "/s", "/c", 'start "" "' + url + '"'], {
      windowsHide: true,
      stdio: "ignore",
    });
    opener.once("error", error => {
      console.error("Could not open the browser automatically: " + error.message);
      console.log("Open this address manually: " + url);
    });

    await new Promise(resolve => backendProcess.once("exit", resolve));
    throw new Error("The local API stopped unexpectedly. Restart Start Analyzer.cmd.");
  } finally {
    stop();
  }
}

try {
  await launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
