import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-local analysis progress. Only aggregate milestones leave the API:
 * never SOQL, metadata identifiers, usernames, object names or file paths.
 * Percent is an estimate of completed WORK, not a prediction of time left.
 */
export type SoqlProgressStage = "starting" | "scanning" | "preparing" | "permissions" | "excel" | "complete" | "failed";
export type SoqlProgressMode = "ORG_AND_REPOSITORY" | "REPOSITORY_ONLY";
export type SoqlProgressKind = "single" | "all";
export type SoqlProgressState = "running" | "completed" | "failed";
export type SoqlUserMatchingState = "pending" | "in_progress" | "complete" | "skipped";

export interface SoqlProgressSnapshot {
  state: SoqlProgressState;
  stage: SoqlProgressStage;
  kind: SoqlProgressKind;
  mode: SoqlProgressMode | null;
  percent: number;
  elapsedSeconds: number;
  completedPersonas: number;
  totalPersonas: number;
  completedObjects: number;
  totalObjects: number;
  userMatching: SoqlUserMatchingState;
}

const weights: Record<Exclude<SoqlProgressStage, "failed">, number> = {
  starting: 0, scanning: 2, preparing: 20, permissions: 37, excel: 92, complete: 100,
};
const clamp = (value: number) => Math.max(0, Math.min(100, Math.floor(value)));
const context = new AsyncLocalStorage<SoqlAnalysisProgress>();

export async function withSoqlProgress<T>(progress: SoqlAnalysisProgress | undefined,
  action: () => Promise<T>): Promise<T> {
  return progress ? context.run(progress, action) : action();
}

/** Called only when the actual Salesforce persona matcher is invoked. */
export function noteSoqlUserMatching(): void {
  context.getStore()?.userMatchingStarted();
}

export class SoqlAnalysisProgress {
  private state: SoqlProgressState = "running";
  private stage: SoqlProgressStage = "starting";
  private mode: SoqlProgressMode | null = null;
  private percent = 0;
  private totalPersonas: number;
  private completedPersonas = 0;
  private totalObjects = 0;
  private completedObjects = 0;
  private matchedUsersObserved = false;
  private readonly startedAt: number;

  constructor(
    readonly kind: SoqlProgressKind,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.totalPersonas = kind === "single" ? 1 : 0;
  }

  get isFinished(): boolean { return this.state !== "running"; }

  setMode(mode: SoqlProgressMode): void {
    if (this.state !== "running") return;
    this.mode = mode;
  }

  setTotalPersonas(total: number): void {
    if (this.state !== "running" || this.kind !== "all") return;
    this.totalPersonas = Math.max(0, Math.floor(total));
  }

  moveTo(stage: "scanning" | "preparing" | "permissions" | "excel"): void {
    if (this.state !== "running") return;
    const order: SoqlProgressStage[] = ["starting", "scanning", "preparing", "permissions", "excel"];
    if (order.indexOf(stage) < order.indexOf(this.stage)) return;
    this.stage = stage;
    this.percent = Math.max(this.percent, weights[stage]);
  }

  /** Actual class completion drives the 2–19% scanning milestone. */
  reportClasses(completed:number,total:number):void{
    if(this.state!=="running"||this.stage!=="scanning"||total<=0)return;
    const ratio=Math.max(0,Math.min(1,completed/total));
    this.percent=Math.max(this.percent,weights.scanning+Math.floor(ratio*17));
  }

  /** Exact completed-object counts. Used only for single-persona analysis. */
  reportObjects(completed: number, total: number): void {
    if (this.state !== "running" || this.kind !== "single" || this.stage !== "permissions") return;
    this.totalObjects = Math.max(this.totalObjects, Math.floor(Math.max(0, total)));
    this.completedObjects = Math.min(this.totalObjects, Math.max(this.completedObjects, Math.floor(completed)));
    if (this.totalObjects > 0) this.setPermissionPercent(this.completedObjects / this.totalObjects);
  }

  /** Count a persona only after analyzePrepared has fully resolved it. */
  personaCompleted(): void {
    if (this.state !== "running" || this.kind !== "all" || this.stage !== "permissions") return;
    this.completedPersonas = Math.min(this.totalPersonas, this.completedPersonas + 1);
    if (this.totalPersonas > 0) this.setPermissionPercent(this.completedPersonas / this.totalPersonas);
  }

  userMatchingStarted(): void {
    if (this.state !== "running" || this.mode !== "ORG_AND_REPOSITORY") return;
    this.matchedUsersObserved = true;
  }

  complete(): void {
    if (this.state !== "running") return;
    // Called only once the Excel writer has successfully returned.
    this.stage = "complete";
    this.state = "completed";
    this.percent = 100;
    if (this.kind === "single") this.completedPersonas = 1;
  }

  fail(): void {
    if (this.state !== "running") return;
    this.stage = "failed";
    this.state = "failed";
    // An interrupted analysis must never claim 100%.
    this.percent = Math.min(this.percent, 99);
  }

  snapshot(): SoqlProgressSnapshot {
    const userMatching: SoqlUserMatchingState =
      this.mode !== "ORG_AND_REPOSITORY" ? "skipped" :
      this.stage === "starting" || this.stage === "scanning" || this.stage === "preparing" ? "pending" :
      this.stage === "permissions" ? (this.matchedUsersObserved ? "in_progress" : "pending") :
      this.matchedUsersObserved ? "complete" : "skipped";
    return {
      state: this.state, stage: this.stage, kind: this.kind, mode: this.mode,
      percent: this.percent,
      elapsedSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
      completedPersonas: this.completedPersonas, totalPersonas: this.totalPersonas,
      completedObjects: this.completedObjects, totalObjects: this.totalObjects,
      userMatching,
    };
  }

  private setPermissionPercent(ratio: number): void {
    // 37–91% is the completed-work budget for permission evaluation.
    // Never display 100% until the final Excel serialization succeeds.
    const value = weights.permissions + Math.floor(Math.max(0, Math.min(1, ratio)) * 54);
    this.percent = Math.max(this.percent, clamp(value));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETAIN_COMPLETED_MS = 5 * 60_000;
const MAX_JOBS = 24;

export class SoqlProgressRegistry {
  private readonly entries = new Map<string, { progress: SoqlAnalysisProgress; finishedAt?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  start(id: string, kind: SoqlProgressKind): SoqlAnalysisProgress {
    if (!UUID.test(id)) throw new Error("Invalid progress request identifier.");
    this.prune();
    if (this.entries.has(id)) throw new Error("Progress request identifier already exists.");
    if (this.entries.size >= MAX_JOBS) {
      // Evict the oldest finished job first; do not reject new analyses simply
      // because several quick reports finished within the retention window.
      for (const [previousId, entry] of this.entries) {
        if (entry.finishedAt === undefined) continue;
        this.entries.delete(previousId);
        break;
      }
    }
    if (this.entries.size >= MAX_JOBS) throw new Error("Too many active progress jobs.");
    const progress = new SoqlAnalysisProgress(kind, this.now);
    this.entries.set(id, { progress });
    return progress;
  }

  finish(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.finishedAt = this.now();
  }

  get(id: string): SoqlProgressSnapshot | undefined {
    if (!UUID.test(id)) return undefined;
    this.prune();
    return this.entries.get(id)?.progress.snapshot();
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.finishedAt !== undefined && this.now() - entry.finishedAt >= RETAIN_COMPLETED_MS) {
        this.entries.delete(id);
      }
    }
  }
}
