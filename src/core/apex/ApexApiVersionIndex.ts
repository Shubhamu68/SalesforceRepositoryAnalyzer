import { readFile } from "node:fs/promises";

/** Run-scoped Apex source API-version metadata, shared by analysis consumers. */
export class ApexApiVersionIndex {
  private readonly versionCache = new Map<string, Promise<number | undefined>>();

  /** Refresh metadata between analysis runs; cache still coalesces reads within a run. */
  clearCache(): void { this.versionCache.clear(); }

  getApiVersion(sourceFilePath: string): Promise<number | undefined> {
    const key = sourceFilePath.toLowerCase();
    let cached = this.versionCache.get(key);
    if (!cached) {
      cached = this.readVersion(sourceFilePath);
      this.versionCache.set(key, cached);
    }
    return cached;
  }

  private async readVersion(sourceFilePath: string): Promise<number | undefined> {
    try {
      const xml = await readFile(`${sourceFilePath}-meta.xml`, "utf8");
      const match = xml.match(/<(?:[A-Za-z_][\w.-]*:)?apiVersion\b[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/(?:[A-Za-z_][\w.-]*:)?apiVersion>/i);
      if (!match) return undefined;
      const version = Number(match[1]);
      return version > 0 && Number.isFinite(version) ? version : undefined;
    } catch {
      // Missing/unreadable metadata cannot justify assuming system mode.
      return undefined;
    }
  }
}
