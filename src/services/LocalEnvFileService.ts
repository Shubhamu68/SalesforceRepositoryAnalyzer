import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";

/**
 * Atomically creates or updates exactly one .env setting, preserving all
 * unrelated entries, comments, credentials and the existing newline format.
 */
export async function saveLocalEnvEntry(filePath: string, key: string, value: string): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("Invalid environment setting.");
  }
  let previous = "";
  let mode = 0o600;
  try {
    previous = await readFile(filePath, "utf8");
    mode = (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const newline = previous.includes("\r\n") ? "\r\n" : "\n";
  const lines = previous ? previous.split(/\r?\n/) : [];
  // Quote paths because they may contain spaces or '#' on Windows.
  // Forward slashes make Windows paths safe for .env parsers.
  const entry = key + "=" + JSON.stringify(value.replaceAll("\\", "/"));
  const matching = new RegExp("^\\s*(?:export\\s+)?" + key + "\\s*=");
  let seen = false;
  const updated: string[] = [];
  for (const line of lines) {
    if (matching.test(line)) {
      if (!seen) updated.push(entry);
      seen = true;
    } else {
      updated.push(line);
    }
  }
  if (!seen) {
    if (updated.length && updated[updated.length - 1] !== "") updated.push("");
    updated.push(entry);
  }
  const content = updated.join(newline).replace(newline === "\r\n" ? /(?:\r\n)*$/ : /\n*$/, "") + newline;
  const temporary = filePath + ".tmp-" + randomUUID();
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// One-time migration: remove obsolete OAuth secrets from the Analyzer's local
// .env. Preserve every unrelated setting, comment, newline and file permission.
export async function removeLocalEnvEntries(filePath: string, keys: readonly string[]): Promise<boolean> {
  if (keys.some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid environment key.");
  let original: string;
  try { original = await readFile(filePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const target = new Set(keys);
  const updated = original.split(/(?<=\n)/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    return !match || !target.has(match[1]);
  }).join("");
  if (updated === original) return false;
  const mode = (await stat(filePath)).mode & 0o777;
  const temporary = filePath + ".tmp-" + randomUUID();
  try {
    await writeFile(temporary, updated, { flag: "wx", mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}
