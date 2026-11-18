import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { canStartBrowserLogin, shouldShowOrgChooser } from "../web/src/utils/salesforceAuthUi.js";

test("startup auto-enters workspace when an existing backend CLI org is connected", () => {
  assert.equal(shouldShowOrgChooser(false, "startup", true), false);
  assert.equal(shouldShowOrgChooser(false, "startup", false), true);
  assert.equal(shouldShowOrgChooser(false, "manual", true), true);
  assert.equal(shouldShowOrgChooser(true, "startup", false), false);
  assert.equal(shouldShowOrgChooser(true, "manual", true), false);
});

test("Sandbox and Production sign-in are enabled after CLI discovery, even with an active org", () => {
  const ready = { checking: false, busy: false };
  assert.equal(canStartBrowserLogin(ready), true);
  assert.equal(canStartBrowserLogin({ checking: true, busy: false }), false);
  assert.equal(canStartBrowserLogin({ checking: false, busy: true }), false);
  // Neither active nor saved orgs are inputs to the browser-login policy.
  // Change org must offer a fresh browser authorization without disconnecting.
  assert.deepEqual(Object.keys(ready).sort(), ["busy", "checking"]);
});

test("main app auto-enters on connected startup, but keeps explicit Change org open", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");
  const login = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  assert.match(app, /shouldShowOrgChooser\(authDismissed, orgChooserMode, salesforceConnection === "connected"\)/);
  assert.match(app, /setOrgChooserMode\("manual"\)/);
  assert.match(app, /autoContinueConnected=\{orgChooserMode === "startup"\}/);
  assert.match(app, /onBack=\{orgChooserMode === "manual"/);
  assert.match(app, /onSkip=\{orgChooserMode === "startup"/);
  assert.match(login, /if \(autoContinueConnected && session.connected\) \{/);
  assert.match(login, /onComplete\(session\)/);
  assert.match(login, /next\.some\(org => org\.username === session\.username\)/);
  assert.match(login, /Back to workspace/);
});

test("Change org always offers Sandbox and Production login after CLI discovery", () => {
  const login = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  const policy = readFileSync("web/src/utils/salesforceAuthUi.ts", "utf8");
  const css = readFileSync("web/src/components/SalesforceCliLogin.css", "utf8");
  assert.match(login, /disabled=\{!canLogInWithBrowser \|\| busy === "sandbox"\}/);
  assert.match(login, /disabled=\{!canLogInWithBrowser \|\| busy === "production"\}/);
  assert.match(login, /checking: loading/);
  assert.match(login, /busy: busy === "select" \|\| busy === "switching" \|\| busy === "cancelling"/);
  assert.match(login, /Cancel login/);
  assert.match(login, /\/api\/salesforce\/login-web\/cancel/);
  assert.doesNotMatch(login, /hasActiveCliOrgs|hasError: Boolean\(error\)|connected: Boolean\(current\?\.connected\)/);
  assert.doesNotMatch(policy, /!state\.connected|!state\.hasActiveCliOrgs/);
  assert.match(login, /Change Salesforce org/);
  assert.match(login, /Current org:/);
  assert.match(css, /\.sf-cli-login-actions button:disabled/);
});

test("Salesforce Org page contains only connection details and query testing", () => {
  const orgPage = readFileSync("web/src/components/SalesforceOrgConnection.tsx", "utf8");
  assert.doesNotMatch(orgPage, /SalesforceCliLogin|Log in to Sandbox|Log in to Production/);
  assert.doesNotMatch(orgPage, /Refresh CLI session|Disconnect Analyzer|function reconnect\(|function disconnect\(/);
  assert.match(orgPage, /Connection details/);
  assert.match(orgPage, /Test Salesforce query/);
  assert.match(orgPage, /Test OrderItemSummary access/);
  assert.match(orgPage, /Connect org in the top bar/);
});
