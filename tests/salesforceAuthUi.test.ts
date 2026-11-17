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

test("browser sign-in stays disabled while checking CLI or any CLI org is active", () => {
  const ready = {
    checking: false, busy: false, hasError: false,
    connected: false, hasActiveCliOrgs: false,
  };
  assert.equal(canStartBrowserLogin(ready), true);
  assert.equal(canStartBrowserLogin({ ...ready, checking: true }), false);
  assert.equal(canStartBrowserLogin({ ...ready, hasActiveCliOrgs: true }), false);
  assert.equal(canStartBrowserLogin({ ...ready, connected: true }), false);
  assert.equal(canStartBrowserLogin({ ...ready, hasError: true }), false);
  assert.equal(canStartBrowserLogin({ ...ready, busy: true }), false);
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

test("login shows visibly disabled browser buttons until no active CLI authorizations remain", () => {
  const login = readFileSync("web/src/components/SalesforceCliLogin.tsx", "utf8");
  const css = readFileSync("web/src/components/SalesforceCliLogin.css", "utf8");
  assert.equal((login.match(/disabled=\{!canLogInWithBrowser\}/g) ?? []).length, 2);
  assert.match(login, /orgs\.some\(org => org\.status === "saved"\)/);
  assert.match(login, /Connected Salesforce CLI authorizations are available above/);
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
