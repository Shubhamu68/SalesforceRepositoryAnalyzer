import path from "node:path";

/** Pure helpers shared by Electron startup and runtime regression tests. */
export function resolveDesktopPaths(root) {
  return {
    node: path.join(root, "runtime", "node.exe"),
    backend: path.join(root, "app", "dist", "api", "server.js"),
    frontend: path.join(root, "app", "web", "dist"),
    frontendIndex: path.join(root, "app", "web", "dist", "index.html"),
    template: path.join(root, ".env.example"),
  };
}

/** The desktop renderer cannot navigate to untrusted websites. */
export function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username && !url.password &&
      ["github.com", "help.salesforce.com", "trailhead.salesforce.com"].includes(url.hostname);
  } catch { return false; }
}
