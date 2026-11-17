import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function assertLocalMarkdownLinksExist(file: string): void {
  const markdown = read(file);
  const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)];
  for (const match of links) {
    const rawTarget = match[1];
    if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#")[0]);
    const resolved = path.resolve(root, path.dirname(file), target);
    assert.ok(resolved.startsWith(root), `${file}: unsafe relative link ${rawTarget}`);
    assert.ok(existsSync(resolved), `${file}: broken link ${rawTarget}`);
  }
}

test("professional README exists and documents current, supported capabilities", () => {
  const readme = read("README.md");
  for (const required of [
    "Salesforce Repository Analyzer",
    "SOQL Security Analysis",
    "Access Checker",
    "Object Access Matrix",
    "Stack Trace Impact",
    "Windows Portable",
    "npm run test:all",
    "docs/architecture.md",
    "docs/releases.md",
    "No",
  ]) assert.ok(readme.includes(required), required);
  assert.match(readme, /not an Electron app/i);
  assert.match(readme, /\.env\.example/);
});

test("all navigation links in current guides resolve to checked-in files", () => {
  for (const filename of [
    "README.md", "CONTRIBUTING.md", "docs/README.md",
    "docs/architecture.md", "docs/releases.md", "docs/security.md",
    "docs/setup/development.md", "docs/setup/windows-portable.md",
    "docs/features/org-access-fallback.md",
    "docs/features/soql-aggregates.md", "docs/history/README.md",
    "docs/repository-settings.md",
  ]) {
    assert.ok(existsSync(path.join(root, filename)), filename);
    assertLocalMarkdownLinksExist(filename);
  }
});

test("historical standalone patch notes moved under docs/history without deletion", () => {
  const files = [
    "FIELD_PERMISSIONABILITY_README.md", "NESTED_SOQL_IMPLEMENTATION.md",
    "OBJECT_ACCESS_MATRIX_README.md", "ORG_ACCESS_FALLBACK.md",
    "RELATIONSHIP_RESOLUTION_FIX.md", "REPORT_OUTPUT_FOLDER_SETUP.md",
    "REPOSITORY_SETUP_AND_ORG_PREFLIGHT.md", "SALESFORCE_AUTO_CONNECT_README.md",
    "UI_MESSAGING_CLEANUP_CHANGELOG.md", "changes.patch",
  ];
  for (const original of files) {
    assert.ok(existsSync(path.join(root, "docs/history", original)), original);
    assert.ok(!existsSync(path.join(root, original)), original + " should not clutter repo root");
  }
  assert.ok(!existsSync(path.join(root, "SOQL_AGGREGATE_ANALYSIS.md")));
  assert.ok(existsSync(path.join(root, "docs/features/soql-aggregates.md")));
  assert.deepEqual(
    readdirSync(root).filter(n => n.endsWith(".md")).sort(),
    ["CHANGELOG.md", "CONTRIBUTING.md", "README.md"].sort(),
  );
});

test("release workflow publishes only a tested main-ancestor version tag", () => {
  const workflow = read(".github/workflows/release-windows.yml");
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" "origin\/main"/);
  assert.match(workflow, /package_version=.*package\.json/);
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/windows-portable\.yml/);
  assert.match(workflow, /needs: \[validate-tag, build-portable\]/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /sha256sum SalesforceRepositoryAnalyzer-Windows-Portable\.zip/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /A release already exists/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /unzip -Z1/);
  assert.ok(!/workflow_dispatch:/.test(workflow),
    "Releases must not be published by an untagged manual run");
});

test("existing packaging workflow supports manual builds and reuse without bundling .env", () => {
  const portable = read(".github/workflows/windows-portable.yml");
  assert.match(portable, /workflow_dispatch:/);
  assert.match(portable, /workflow_call:/);
  assert.match(portable, /npm ci --omit=dev/);
  assert.match(portable, /desktop\/windows\/smoke\.mjs/);
  assert.match(portable, /\.env\.example/);
  assert.match(portable, /Packaging must NEVER include/);
  assert.match(portable, /actions\/upload-artifact@v4/);
  const release = read(".github/workflows/release-windows.yml");
  assert.match(release, /\(\^\|\/\)\\\.env\$/); 
});

test("issue and PR templates exist; PR commits remain subject to cross-platform CI", () => {
  for (const f of [
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ]) assert.ok(existsSync(path.join(root, f)), f);
  const ci = read(".github/workflows/analyzer-regression.yml");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /- main/);
  assert.match(ci, /- 'chore\/\*\*'/);
  assert.match(ci, /- 'feature\/\*\*'/);
  assert.match(ci, /- 'fix\/\*\*'/);
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(ci, /npm run test:all/);
  assert.match(read(".github/pull_request_template.md"), /UAT/);
});
