import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SalesforceCliAuthProvider, assertCliArguments, type CliRunner } from "../src/salesforce/SalesforceCliAuthProvider.js";
import { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";
import { OrgAnalysisPreflightService } from "../src/services/OrgAnalysisPreflightService.js";

const ORG_A = "00D000000000001";
const ORG_B = "00D000000000002";
const USER = "005000000000001";
const token = "sensitive-oauth-token-should-never-be-returned";
function success(result: unknown) { return JSON.stringify({status:0,result}); }
function fakeRunner(calls: string[]): CliRunner {
  return async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return "@salesforce/cli/2.157.8";
    if (args[0] === "org" && args[1] === "list") {
      return success({nonScratchOrgs:[
        { username:"admin@example.com", alias:"unifiedQA", orgId:ORG_A,
          instanceUrl:"https://qa--dev.sandbox.my.salesforce.com", isSandbox:true, connectedStatus:"Connected" },
        { username:"admin-prod@example.com", alias:"production", orgId:ORG_B,
          instanceUrl:"https://corp.my.salesforce.com", isSandbox:false, connectedStatus:"Connected" },
        { username:"expired@example.com", alias:"expiredQA", orgId:ORG_A,
          instanceUrl:"https://qa--dev.sandbox.my.salesforce.com", isSandbox:true,
          connectedStatus:"Unable to refresh session due to expired token" },
      ]});
    }
    if (args[0] === "org" && args[1] === "login") {
      return success({username: args.includes("https://test.salesforce.com")
        ? "admin@example.com" : "admin-prod@example.com"});
    }
    if (args.includes("show-access-token")) return success({accessToken:token});
    if (args[1] === "display") {
      const prod = args.includes("admin-prod@example.com");
      return success({orgId:prod?ORG_B:ORG_A,
        username:prod?"admin-prod@example.com":"admin@example.com",
        instanceUrl:prod?"https://corp.my.salesforce.com":"https://qa--dev.sandbox.my.salesforce.com"});
    }
    throw new Error("Unexpected command " + args.join(" "));
  };
}
test("Salesforce CLI command allowlist rejects shell injection and arbitrary operations", () => {
  for (const args of [
    ["org","logout","--all"],
    ["org","auth","show-sfdx-auth-url","--json"],
    ["org","list","--json;rm"],
    ["org","display","--target-org","bad&whoami","--json"],
    ["org","display","--target-org","x y","--json"],
    ["org","login","web","--instance-url","https://evil.example","--json"],
  ]) assert.throws(()=>assertCliArguments(args), /Invalid|Unsupported/);
  assert.doesNotThrow(()=>assertCliArguments([
    "org","auth","show-access-token","--target-org","admin@example.com","--json"]));
});

test("CLI org discovery lists sandbox and production, preserving stale authorization for explicit re-login", async () => {
  const calls:string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  assert.match(await cli.version(), /2.157.8/);
  const orgs = await cli.listOrgs();
  assert.equal(orgs.length,3);
  assert.equal(orgs.find(o=>o.alias==="unifiedQA")?.environment,"sandbox");
  assert.equal(orgs.find(o=>o.alias==="production")?.environment,"production");
  assert.equal(orgs.find(o=>o.alias==="expiredQA")?.status,"expired");
  assert.ok(calls.includes("org list --json"));
  assert.doesNotMatch(JSON.stringify(orgs), /sensitive-oauth-token/);
});

test("CLI browser login uses default OAuth app and no client ID or secret", async () => {
  const calls:string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  assert.equal(await cli.loginWeb("sandbox"),"admin@example.com");
  assert.equal(await cli.loginWeb("production"),"admin-prod@example.com");
  assert.ok(calls.includes("org login web --instance-url https://test.salesforce.com --json"));
  assert.ok(calls.includes("org login web --instance-url https://login.salesforce.com --json"));
  assert.ok(calls.every(c=>!c.includes("--client-id") && !c.includes("--client-secret")));
});

test("dedicated CLI token command is used and returned only to the server-side connection", async () => {
  const calls:string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  const info = await cli.showToken("admin@example.com");
  assert.equal(info.accessToken,token);
  assert.ok(calls.includes("org auth show-access-token --target-org admin@example.com --json"));
  assert.ok(calls.includes("org display --target-org admin@example.com --json"));
  await assert.rejects(cli.showToken("bad;echo hacked"),/Invalid/);
});

test("invalid CLI JSON and command failures cannot expose bearer tokens", async () => {
  const invalid = new SalesforceCliAuthProvider(async args => args[0] === "--version" ? "@salesforce/cli/2.157.8" : "{not-json}");
  await assert.rejects(invalid.listOrgs(), /invalid JSON/);
  const rejected = new SalesforceCliAuthProvider(async()=>success({bad:"secret"}));
  await assert.rejects(rejected.showToken("admin@example.com"),/valid session/);
});

test("selected CLI org drives existing REST/Tooling methods, supports switching, and disconnect is local-only", async () => {
  const calls:string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  const conn = new SalesforceOrgConnection(cli);
  const original = globalThis.fetch;
  const fetches: {url:string; bearer:string}[] = [];
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    const h = new Headers(init?.headers);
    fetches.push({url:address, bearer:h.get("authorization") || ""});
    if (address.endsWith("/services/oauth2/userinfo")) {
      return new Response(JSON.stringify({user_id:USER,organization_id:address.includes("corp")?ORG_B:ORG_A}),{status:200});
    }
    return new Response(JSON.stringify({done:true,totalSize:1,records:[{Id:USER}]}),{status:200});
  };
  try {
    assert.equal(conn.status.connected,false);
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.connected,true);
    assert.equal(conn.status.organizationId,ORG_A);
    assert.equal(conn.status.userId,USER);
    assert.equal(conn.status.authMode,"salesforce_cli");
    const rest = await conn.query("SELECT Id FROM User LIMIT 1","data");
    assert.equal(rest.totalSize,1);
    const tooling = await conn.queryAll("SELECT Id FROM User LIMIT 1","tooling");
    assert.equal(tooling.length,1);
    assert.ok(fetches.every(f=>f.bearer==="Bearer "+token));
    await conn.selectOrg("production");
    assert.equal(conn.status.organizationId,ORG_B);
    assert.equal(conn.status.environment,"production");
    assert.ok(fetches.some(f=>f.url.startsWith("https://corp.my.salesforce.com/")));
    conn.disconnect();
    assert.equal(conn.status.connected,false);
    assert.equal(conn.status.configured,false);
    assert.ok(!calls.some(c=>c.includes("logout")),"disconnect must preserve developer CLI login");
    assert.equal((await new OrgAnalysisPreflightService(conn).check()).mode,"REPOSITORY_ONLY");
  } finally { globalThis.fetch=original; }
});

test("login UI, .env and API never ask for passwords or client secrets", () => {
  const files = [
    "src/api/server.ts", "src/api/salesforceRoutes.ts",
    "src/salesforce/SalesforceOrgConnection.ts",
    "src/services/OrgAnalysisPreflightService.ts",
    "web/src/App.tsx", "web/src/components/SalesforceOrgConnection.tsx",
    "web/src/components/SalesforceCliLogin.tsx", "web/src/utils/uiMessaging.ts",
    ".env.example", "desktop/windows/smoke.mjs",
  ];
  for (const file of files) {
    const content=readFileSync(file,"utf8");
    assert.doesNotMatch(content,/SALESFORCE_CLIENT_ID|SALESFORCE_CLIENT_SECRET|client_credentials/i,file);
  }
  const login=readFileSync("web/src/components/SalesforceCliLogin.tsx","utf8");
  assert.match(login,/Log in to Sandbox/);
  assert.match(login,/Log in to Production/);
  assert.match(login,/repository-only analysis/);
  assert.match(login,/\/api\/salesforce\/select/);
  assert.match(readFileSync("web/src/App.tsx","utf8"),/shouldShowOrgChooser\(authDismissed, orgChooserMode, salesforceConnection === "connected"\)/);
  assert.match(readFileSync("src/api/salesforceRoutes.ts","utf8"),/onConnectionChange/);
});


test("first-run org selection and browser login both work without prompting for application credentials", async () => {
  const calls: string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  const connection = new SalesforceOrgConnection(cli);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url=String(request);
    if (url.endsWith("/services/oauth2/userinfo")) {
      const prod=url.includes("corp");
      return new Response(JSON.stringify({user_id:USER,organization_id:prod?ORG_B:ORG_A}),{status:200});
    }
    return fetchOriginal(request,init);
  };
  try {
    await connection.loginWeb("sandbox");
    assert.equal(connection.status.environment,"sandbox");
    assert.equal(connection.status.username,"admin@example.com");
    await connection.loginWeb("production");
    assert.equal(connection.status.environment,"production");
    assert.equal(connection.status.organizationId,ORG_B);
    assert.ok(calls.every(c=>!c.includes("--client-id")));
    connection.disconnect();
  } finally { globalThis.fetch = fetchOriginal; }
});

test("disconnection during pending CLI authentication cannot revive stale session", async () => {
  let release!: (data: string) => void;
  const calls: string[]=[];
  const originalRunner=fakeRunner(calls);
  const paused: CliRunner=async (args,timeout) => {
    if (args.includes("show-access-token")) return new Promise<string>(resolve => { release=resolve; });
    return originalRunner(args,timeout);
  };
  const conn=new SalesforceOrgConnection(new SalesforceCliAuthProvider(paused));
  const pending=conn.selectOrg("unifiedQA");
  for(let attempt=0; attempt<30 && !release;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(typeof release,"function");
  conn.disconnect();
  release(success({accessToken:token}));
  await assert.rejects(pending,/changed during authentication/);
  assert.equal(conn.status.connected,false);
  assert.equal(conn.status.configured,false);
});


test("CLI token with expired Salesforce API session cannot be reported as connected", async () => {
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(fakeRunner([])));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}",{status:401});
  try {
    await assert.rejects(conn.selectOrg("unifiedQA"),/session expired/);
    assert.equal(conn.status.connected,false);
    assert.equal(conn.status.configured,true);
  } finally { globalThis.fetch=original; }
});

test("org identity must agree with selected CLI org, preventing cross-org access confusion", async () => {
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(fakeRunner([])));
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({organization_id:ORG_B,user_id:USER}),{status:200});
  try {
    await assert.rejects(conn.selectOrg("unifiedQA"),/different org/);
    assert.equal(conn.status.connected,false);
  } finally { globalThis.fetch=original; }
});


test("CLI version detection is cached during repeated org discovery", async () => {
  const calls:string[]=[];
  const connection=new SalesforceOrgConnection(new SalesforceCliAuthProvider(fakeRunner(calls)));
  const first=await connection.listAuthorizedOrgs();
  const second=await connection.listAuthorizedOrgs();
  assert.equal(first.orgs.length,3);
  assert.equal(second.orgs.length,3);
  assert.equal(calls.filter(cmd=>cmd==="--version").length,1);
});

test("Salesforce CLI real status distinguishes connected and expired authorizations", async () => {
  const calls: string[] = [];
  const cli = new SalesforceCliAuthProvider(fakeRunner(calls));
  const orgs = await cli.listOrgs();
  assert.equal(orgs.find(org => org.alias === "unifiedQA")?.status, "saved");
  assert.equal(orgs.find(org => org.alias === "expiredQA")?.status, "expired");
  assert.ok(calls.includes("org list --json"));
});

test("CLI org listing retains saved orgs when live connection checks fail", async () => {
  const calls: string[] = [];
  const runner = fakeRunner(calls);
  const cli = new SalesforceCliAuthProvider(async (args, timeout) => {
    if (args.join(" ") === "org list --json") {
      calls.push(args.join(" "));
      throw new Error("Network refresh unavailable");
    }
    return runner(args, timeout);
  });
  const orgs = await cli.listOrgs();
  assert.equal(orgs.length, 3);
  assert.ok(calls.includes("org list --json"));
  assert.ok(calls.includes("org list --skip-connection-status --json"));
});

test("failed switch restores the previously connected Salesforce org", async () => {
  const conn = new SalesforceOrgConnection(new SalesforceCliAuthProvider(fakeRunner([])));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.includes("corp.my.salesforce.com")) {
      return new Response("{}", { status: 401 });
    }
    return new Response(JSON.stringify({ organization_id: ORG_A, user_id: USER }), { status: 200 });
  };
  try {
    await conn.selectOrg("unifiedQA");
    assert.equal(conn.status.connected, true);
    const instance = conn.status.instanceUrl;
    await assert.rejects(conn.selectOrg("production"), /session expired/);
    assert.equal(conn.status.connected, true);
    assert.equal(conn.status.username, "admin@example.com");
    assert.equal(conn.status.organizationId, ORG_A);
    assert.equal(conn.status.instanceUrl, instance);
  } finally {
    globalThis.fetch = original;
  }
});
