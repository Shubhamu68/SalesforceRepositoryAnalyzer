import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { createSalesforceRouter } from "../src/api/salesforceRoutes.js";
import type { SalesforceOrgConnection } from "../src/salesforce/SalesforceOrgConnection.js";

test("CLI org selection and browser login REST routes never expose tokens", async () => {
  let selected="";
  let changed=0;
  const conn={
    get status() {
      return { configured: Boolean(selected), connecting:false, connected:Boolean(selected),
        authMode:"salesforce_cli", environment:selected==="prod"?"production":"sandbox",
        loginHost:"test.salesforce.com", username:selected || undefined };
    },
    listAuthorizedOrgs: async () => ({
      cliVersion:"@salesforce/cli/2.157.8",
      orgs:[{alias:"qa",username:"qa@example.com",environment:"sandbox",status:"saved"}],
    }),
    selectOrg: async (target:string) => { selected=target; },
    loginWeb: async (environment:string) => { selected=environment==="production"?"prod":"qa"; },
    disconnect: () => { selected=""; },
    connect: async () => {},
    query: async () => ({done:true,api:"data",totalSize:0,displayedCount:0,truncated:false,records:[]}),
  } as unknown as SalesforceOrgConnection;
  const app=express();
  app.use(express.json({limit:"100kb"}));
  app.use("/api/salesforce",createSalesforceRouter(conn,()=>{changed++;}));
  const server=app.listen(0,"127.0.0.1");
  try {
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    const status=await (await fetch(url+"/api/salesforce/status")).json();
    assert.equal(status.connected,false);
    assert.equal(status.authMode,"salesforce_cli");
    const orgs=await (await fetch(url+"/api/salesforce/orgs")).json();
    assert.equal(orgs.orgs[0].alias,"qa");
    assert.doesNotMatch(JSON.stringify(orgs),/accessToken|refreshToken|clientSecret/);

    const crossSite=await fetch(url+"/api/salesforce/select",{
      method:"POST",headers:{"Content-Type":"application/json","Origin":"https://malicious.example"},
      body:JSON.stringify({target:"qa"}),
    });
    assert.equal(crossSite.status,403);
    const noJson=await fetch(url+"/api/salesforce/select",{method:"POST",body:"qa"});
    assert.equal(noJson.status,415);
    const injected=await fetch(url+"/api/salesforce/select",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({target:"qa;calc.exe"}),
    });
    assert.equal(injected.status,400);

    const selected=await fetch(url+"/api/salesforce/select",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({target:"qa@example.com"}),
    });
    assert.equal(selected.status,200);
    assert.equal((await selected.json()).connected,true);
    assert.equal(changed,2);
    const disconnected=await fetch(url+"/api/salesforce/disconnect",{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{}",
    });
    assert.equal((await disconnected.json()).connected,false);
    assert.equal(changed,3);
    const browser=await fetch(url+"/api/salesforce/login-web",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({environment:"production"}),
    });
    const payload=await browser.json();
    assert.equal(payload.connected,true);
    assert.equal(payload.environment,"production");
    assert.equal(changed,5);
    assert.doesNotMatch(JSON.stringify(payload),/accessToken|refreshToken|clientSecret/);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
