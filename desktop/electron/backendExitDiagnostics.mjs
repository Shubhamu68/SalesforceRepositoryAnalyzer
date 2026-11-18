// Classify backend failures without writing stderr, user paths, credentials,
// Salesforce tokens or other untrusted output into a persistent diagnostic log.
const stderrCategories = [
  [/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)/i, "MODULE_NOT_FOUND"],
  [/\b(?:EADDRINUSE|EADDRNOTAVAIL)\b/i, "PORT_UNAVAILABLE"],
  [/\b(?:EACCES|EPERM)\b|permission denied/i, "ACCESS_DENIED"],
  [/\b(?:ENOENT)\b/i, "RESOURCE_NOT_FOUND"],
  [/\b(?:ERR_INVALID_ARG_VALUE|ERR_INVALID_ENV_VALUE|ERR_INVALID_ARG_TYPE)\b|bad option: /i, "INVALID_CONFIGURATION"],
  [/\b(?:ERR_DLOPEN_FAILED)\b|DLL load failed/i, "DLL_LOAD_FAILED"],
  [/\bSyntaxError\b/i, "JS_SYNTAX_ERROR"],
];
const nativeExitCodes = new Map([
  [0xc0000135, "DLL_LOAD_FAILED"],
  [0xc0000142, "WINDOWS_INITIALIZATION_FAILED"],
  [0xc0000005, "PROCESS_CRASH"],
  [0xc000001d, "PROCESS_CRASH"],
  [0xc0000409, "PROCESS_CRASH"],
]);
export const BACKEND_EXIT_CATEGORIES = new Set([
  "MODULE_NOT_FOUND", "PORT_UNAVAILABLE", "ACCESS_DENIED",
  "RESOURCE_NOT_FOUND", "INVALID_CONFIGURATION", "DLL_LOAD_FAILED",
  "JS_SYNTAX_ERROR", "WINDOWS_INITIALIZATION_FAILED", "PROCESS_CRASH",
  "BACKEND_SIGNALLED", "BACKEND_EXIT", "UNKNOWN",
]);

/** The error stream is inspected but NEVER stored. Keep only a few characters
 * across chunks so split error identifiers can still be recognized. */
export function createBackendExitClassifier() {
  let category = null;
  let suffix = "";
  return {
    inspect(chunk) {
      const fragment = suffix + String(chunk);
      suffix = fragment.slice(-96);
      if (category) return;
      for (const [pattern, code] of stderrCategories) {
        if (pattern.test(fragment)) { category = code; break; }
      }
    },
    result(exitCode = null, signal = null, spawnError = null) {
      let determined = category;
      const spawnCode = spawnError && typeof spawnError === "object" && "code" in spawnError
        ? spawnError.code : null;
      if (spawnCode === "EACCES" || spawnCode === "EPERM") determined = "ACCESS_DENIED";
      else if (spawnCode === "ENOENT") determined = "RESOURCE_NOT_FOUND";
      if (!determined && Number.isInteger(exitCode)) {
        determined = nativeExitCodes.get(exitCode >>> 0) || null;
      }
      determined ||= signal ? "BACKEND_SIGNALLED" : "BACKEND_EXIT";
      return { category: determined, exitCode, signal };
    },
  };
}
