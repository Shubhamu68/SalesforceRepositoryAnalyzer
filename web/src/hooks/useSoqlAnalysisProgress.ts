import { useEffect, useState } from "react";

/** Public progress fields contain only aggregate counts, no Salesforce/user data. */
export interface SoqlProgressSnapshot {
  state: "running" | "completed" | "failed";
  stage: "starting" | "scanning" | "preparing" | "permissions" | "excel" | "complete" | "failed";
  kind: "single" | "all";
  mode: "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY" | null;
  percent: number;
  elapsedSeconds: number;
  completedPersonas: number;
  totalPersonas: number;
  completedObjects: number;
  totalObjects: number;
  userMatching: "pending" | "in_progress" | "complete" | "skipped";
}

/**
 * One polling lifecycle for both SOQL buttons. The existing POST still owns
 * the actual analysis; polling is read-only and never triggers Salesforce work.
 * 404 is expected briefly while the POST is being accepted.
 */
export function useSoqlAnalysisProgress() {
  const [progressId, setProgressId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SoqlProgressSnapshot | null>(null);

  useEffect(() => {
    if (!progressId) return;
    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/soql-analysis/progress/${encodeURIComponent(progressId)}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (response.ok) {
          const snapshot = await response.json() as SoqlProgressSnapshot;
          if (active) {
            setProgress(snapshot);
            if (snapshot.state !== "running") return;
          }
        }
        // A missing/temporary failed status request never cancels the analysis.
      } catch {
        // A browser disconnect must not be interpreted as finished analysis.
      }
      if (active) timer = window.setTimeout(() => { void poll(); }, 900);
    };

    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [progressId]);

  const start = (): string => {
    const id = crypto.randomUUID();
    setProgress(null);
    setProgressId(id);
    return id;
  };

  const stop = (): void => {
    setProgressId(null);
    setProgress(null);
  };

  return { progressId, progress, start, stop };
}
