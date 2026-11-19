import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Persona } from "../src/models/Persona.js";
import type { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { SoqlAnalysisService } from "../src/services/SoqlAnalysisService.js";
import {
  SoqlAnalysisProgress, SoqlProgressRegistry, noteSoqlUserMatching, withSoqlProgress,
} from "../src/services/SoqlAnalysisProgress.js";

const example = (name: string): Persona =>
  ({ name, permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] });

test("progress: whole-number milestones only, never 100% before Excel succeeds", () => {
  let now = 100_000;
  const progress = new SoqlAnalysisProgress("single", () => now);
  progress.setMode("REPOSITORY_ONLY");
  assert.equal(progress.snapshot().percent, 0);
  progress.moveTo("scanning");
  assert.equal(progress.snapshot().percent, 2);
  progress.moveTo("preparing");
  assert.equal(progress.snapshot().percent, 20);
  progress.moveTo("permissions");
  progress.reportObjects(0, 4);
  progress.reportObjects(1, 4);
  assert.equal(progress.snapshot().percent, 50);
  progress.reportObjects(2, 4);
  assert.equal(progress.snapshot().percent, 64);
  progress.reportObjects(2, 4);
  assert.equal(progress.snapshot().percent, 64, "duplicate completion must not count twice");
  progress.reportObjects(4, 4);
  assert.equal(progress.snapshot().percent, 91);
  progress.moveTo("excel");
  assert.equal(progress.snapshot().percent, 92);
  now += 24_000;
  assert.equal(progress.snapshot().elapsedSeconds, 24);
  assert.equal(progress.snapshot().userMatching, "skipped");
  progress.complete();
  assert.equal(progress.snapshot().percent, 100);
  assert.equal(progress.snapshot().state, "completed");
  assert.equal(progress.snapshot().completedPersonas, 1);
});

test("progress: all-personas count completed evaluations, not launched workers", () => {
  const progress = new SoqlAnalysisProgress("all");
  progress.setMode("ORG_AND_REPOSITORY");
  progress.setTotalPersonas(16);
  progress.moveTo("scanning");
  progress.moveTo("preparing");
  progress.moveTo("permissions");
  for (let i = 0; i < 7; i++) progress.personaCompleted();
  const snapshot = progress.snapshot();
  assert.equal(snapshot.completedPersonas, 7);
  assert.equal(snapshot.totalPersonas, 16);
  assert.equal(snapshot.percent, 60);
  assert.equal(Number.isInteger(snapshot.percent), true);
  assert.equal(snapshot.userMatching, "pending");
  for (let i = 0; i < 20; i++) progress.personaCompleted();
  assert.equal(progress.snapshot().completedPersonas, 16, "never exceed configured count");
  assert.ok(progress.snapshot().percent < 100);
});

test("progress: real org user matching is contextual and request isolated", async () => {
  const repoOnly = new SoqlAnalysisProgress("single");
  repoOnly.setMode("REPOSITORY_ONLY");
  repoOnly.moveTo("permissions");
  const live = new SoqlAnalysisProgress("all");
  live.setMode("ORG_AND_REPOSITORY");
  live.moveTo("permissions");
  await Promise.all([
    withSoqlProgress(repoOnly, async () => { noteSoqlUserMatching(); await Promise.resolve(); }),
    withSoqlProgress(live, async () => { noteSoqlUserMatching(); await Promise.resolve(); }),
  ]);
  assert.equal(repoOnly.snapshot().userMatching, "skipped");
  assert.equal(live.snapshot().userMatching, "in_progress");
  live.moveTo("excel");
  assert.equal(live.snapshot().userMatching, "complete");
  const unused = new SoqlAnalysisProgress("single");
  unused.setMode("ORG_AND_REPOSITORY");
  unused.moveTo("permissions");
  unused.moveTo("excel");
  assert.equal(unused.snapshot().userMatching, "skipped",
    "do not claim user matching when no live lookup was needed");
});

test("progress: failures never produce a completed/100% result", () => {
  const progress = new SoqlAnalysisProgress("all");
  progress.setTotalPersonas(4);
  progress.moveTo("permissions");
  progress.personaCompleted();
  progress.moveTo("excel");
  progress.fail();
  assert.equal(progress.snapshot().state, "failed");
  assert.equal(progress.snapshot().percent, 92);
  progress.complete();
  assert.equal(progress.snapshot().percent, 92);
});

test("progress registry: opaque identifiers, isolation, duplicate prevention and expiry", () => {
  let now = 10_000;
  const registry = new SoqlProgressRegistry(() => now);
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const first = registry.start(a, "single");
  const second = registry.start(b, "all");
  assert.throws(() => registry.start(a, "all"), /already exists/);
  assert.throws(() => registry.start("../admin", "all"), /Invalid progress/);
  first.moveTo("permissions");
  assert.equal(registry.get(a)?.stage, "permissions");
  assert.equal(registry.get(b)?.stage, "starting");
  assert.equal(registry.get("invalid"), undefined);
  first.complete();
  registry.finish(a);
  now += 5 * 60_000 - 1;
  assert.equal(registry.get(a)?.percent, 100);
  now += 1;
  assert.equal(registry.get(a), undefined);
  assert.ok(registry.get(b), "still-running job must not be evicted by completed retention TTL");
  second.fail();
  registry.finish(b);
  assert.equal(registry.get(b)?.state, "failed");
});

test("single-persona service: actual object completions reach 91%, then Excel 92%", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-progress-single-"));
  try {
    await writeFile(path.join(root, "Example.cls"),
      "public class Example { [SELECT Id FROM Account WITH USER_MODE]; }");
    const progress = new SoqlAnalysisProgress("single");
    progress.setMode("REPOSITORY_ONLY");
    const percentages: number[] = [];
    const analyzer = {
      prepare: async () => ({}),
      analyzePrepared: async (_persona: Persona, _prepared: unknown,
        onObjectProgress?: (done: number, total: number) => void) => {
        for (let n = 0; n <= 4; n++) {
          onObjectProgress?.(n, 4);
          percentages.push(progress.snapshot().percent);
        }
        return [];
      },
    } as unknown as SoqlSecurityAnalyzer;
    const service = new SoqlAnalysisService(root, analyzer, path.join(root, "reports"));
    const result = await service.analyze(example("OMS View Only"), progress);
    assert.equal(result.summary.queriesAnalyzed, 1);
    assert.equal(progress.snapshot().stage, "excel");
    assert.equal(progress.snapshot().percent, 92);
    assert.deepEqual(percentages, [37, 50, 64, 77, 91]);
    assert.equal((await readdir(path.join(root, "reports"))).length, 1);
    progress.complete();
    assert.equal(progress.snapshot().percent, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all-persona service: shared preparation, bounded workers and exact completion counter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-progress-all-"));
  try {
    await writeFile(path.join(root, "Example.cls"),
      "public class Example { [SELECT Id FROM Account WITH USER_MODE]; }");
    const progress = new SoqlAnalysisProgress("all");
    progress.setMode("REPOSITORY_ONLY");
    let preparedCount = 0;
    let active = 0;
    let maxActive = 0;
    const analyzer = {
      prepare: async () => { preparedCount++; return {}; },
      analyzePrepared: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => setTimeout(resolve, 4));
        active--;
        return [];
      },
    } as unknown as SoqlSecurityAnalyzer;
    const service = new SoqlAnalysisService(root, analyzer, path.join(root, "reports"));
    const result = await service.analyzeAllHighPriority(
      Array.from({ length: 7 }, (_, i) => example(`Persona${i + 1}`)),
      "REPOSITORY_ONLY", progress);
    assert.equal(preparedCount, 1);
    assert.ok(maxActive > 1 && maxActive <= 2);
    assert.equal(result.personaCount, 7);
    assert.equal(progress.snapshot().completedPersonas, 7);
    assert.equal(progress.snapshot().totalPersonas, 7);
    assert.equal(progress.snapshot().percent, 92);
    assert.equal(progress.snapshot().userMatching, "skipped");
    progress.complete();
    assert.equal(progress.snapshot().percent, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("web and API: one polling hook, optional UUID, no extra Salesforce calls for progress", async () => {
  const [api, service, app, overlay, hook, verifier] = await Promise.all([
    readFile(new URL("../src/api/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/services/SoqlAnalysisService.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/AnalysisLoadingOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/hooks/useSoqlAnalysisProgress.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/salesforce/SalesforcePersonaAccessVerifier.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /app\.get\("\/api\/soql-analysis\/progress\/:id"/);
  assert.ok(api.indexOf('app.get("/api/soql-analysis/progress/:id"') <
    api.indexOf('app.use("/api", async'),
    "read-only progress polling must bypass costly repository-validation middleware");
  assert.match(api, /res\.setHeader\("Cache-Control", "no-store"\)/);
  assert.match(api, /withSoqlProgress\(progress,/);
  assert.match(api, /soqlProgressRegistry\.finish/);
  assert.match(app, /useSoqlAnalysisProgress\(\)/);
  assert.match(app, /progress=\{soqlProgress\}/);
  assert.match(app, /acknowledgeRepoOnly: preflight\.acknowledgeRepoOnly, progressId/);
  assert.match(hook, /crypto\.randomUUID\(\)/);
  assert.match(hook, /setTimeout\(\(\) => \{ void poll\(\); \}, 900\)/);
  assert.match(overlay, /progress\?\.mode === "ORG_AND_REPOSITORY"/);
  assert.match(overlay, /personas completed/);
  assert.match(overlay, /Math\.floor\(progress\?\.percent/);
  assert.match(service, /progress\?\.personaCompleted\(\)/);
  assert.match(verifier, /noteSoqlUserMatching\(\)/);
});
