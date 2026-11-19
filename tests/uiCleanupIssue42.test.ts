import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const src = (path: string) => readFile(new URL("../" + path, import.meta.url), "utf8");

test("Issue 42: navigation contains only six supported pages in required order", async () => {
  const app = await src("web/src/App.tsx");
  const nav = app.match(/const NAV_ITEMS:[\s\S]*?= \[([\s\S]*?)\];/)?.[1];
  assert.ok(nav, "navigation must have a single ordered source of truth");
  const items = [...nav.matchAll(/page: "([^"]+)", label: "([^"]+)"/g)]
    .map(([, page, label]) => ({ page, label }));
  assert.deepEqual(items, [
    { page: "dashboard", label: "Dashboard" },
    { page: "access", label: "Access Checker" },
    { page: "soql", label: "SOQL Security Analysis" },
    { page: "matrix", label: "Object Access Matrix" },
    { page: "stack", label: "Stack Trace Impact" },
    { page: "salesforce", label: "Salesforce Org" },
  ]);
  assert.match(app, /NAV_ITEMS\.map\(/, "sidebar renders only supported pages");
  assert.match(app, /PAGE_COPY\[page\]\.heading/);
  assert.match(app, /PAGE_COPY\[page\]\.description/);
  assert.doesNotMatch(app, /\bpage\s*===\s*["']reports["']|navigate\(["']reports["']\)|"reports"\s*\|\s*"salesforce"|Generated reports/);
});

test("Issue 42: header removes API badge and RA without disabling health/status handling", async () => {
  const app = await src("web/src/App.tsx");
  const css = await src("web/src/App.css");
  const header = app.match(/<header className="topbar">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header);
  assert.doesNotMatch(header, /API connected|API unavailable|className="avatar"|>RA<\/span>/);
  assert.doesNotMatch(css, /\.avatar\s*\{/);
  assert.match(app, /fetch\("\/api\/health",\s*\{ cache: "no-store" \}\)/);
  assert.match(app, /setApiConnected\(true\)/);
  assert.match(app, /setApiConnected\(false\)/);
  assert.match(header, /repositoryConnectionIndicator\(apiConnected, repoChecked, repoReady\)/);
  assert.match(header, /salesforceConnectionLabel\(salesforceConnection\)/);
  assert.match(header, /Change org/);
});

test("Issue 42: Reports screen and shortcut removed, but Excel and folder flows remain", async () => {
  const app = await src("web/src/App.tsx");
  const css = await src("web/src/App.css");
  const api = await src("src/api/server.ts");
  assert.doesNotMatch(app, /\bpage\s*===\s*["']reports["']|navigate\(["']reports["']\)|latestSoqlReportKind|setLatestSoqlReportKind|View report location|Latest Excel report/);
  assert.doesNotMatch(css, /\.reports-panel|\.empty-reports/);
  assert.match(css, /\.quick-actions\{[^}]*grid-template-columns:repeat\(2,/);
  assert.match(app, /<ReportOutputSetupModal/);
  assert.match(app, /fetch\("\/api\/report-output\/status"/);
  assert.match(app, /fetch\("\/api\/report-output\/choose"/);
  assert.match(app, /fetch\("\/api\/soql-analysis\/high-priority"/);
  assert.match(app, /soql-success-banner/);
  assert.match(app, /Copy folder path/);
  assert.match(app, /allPersonasResult\?\.outputFolder/);
  assert.match(api, /createReportOutputRouter|\/api\/report-output/);
  assert.match(api, /\/api\/health/);
});
