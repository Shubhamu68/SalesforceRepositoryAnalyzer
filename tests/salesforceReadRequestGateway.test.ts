import assert from "node:assert/strict";
import {test} from "node:test";
import {SalesforceReadRequestGateway,SalesforceReadTransportError} from "../src/salesforce/SalesforceReadRequestGateway.js";

const ok=()=>({response:new Response("{}",{status:200}),payload:"ok"});
const scope=()=>{};

test("shared read gateway limits concurrent reads including body processing",async()=>{
  const gateway=new SalesforceReadRequestGateway({concurrency:2,backoffMs:0});
  let active=0,peak=0;
  const result=await Promise.all(Array.from({length:9},()=>gateway.read("read",scope,async()=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));
    active--;return ok();
  })));
  assert.equal(peak,2);
  assert.equal(result.length,9);
});
test("transient fetch failures retry up to two times, then succeed",async()=>{
  const gateway=new SalesforceReadRequestGateway({backoffMs:0});
  let attempts=0;
  const result=await gateway.read("CMDT Example__mdt",scope,async()=>{
    if(++attempts<3)throw new TypeError("secret URL must never appear",{cause:{code:"ECONNRESET"}});
    return ok();
  });
  assert.equal(attempts,3);assert.equal(result.payload,"ok");
});
test("exhausted retries retain safe code, duration and request context",async()=>{
  const gateway=new SalesforceReadRequestGateway({backoffMs:0});
  let attempts=0;
  await assert.rejects(()=>gateway.read("Salesforce data query (Example__mdt)",scope,async()=>{
    attempts++;throw new TypeError("private token",{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}});
  }),error=>{
    assert.ok(error instanceof SalesforceReadTransportError);
    assert.match(error.message,/Example__mdt.*timed out.*UND_ERR_CONNECT_TIMEOUT.*3 attempt.*ms/);
    assert.doesNotMatch(error.message,/private token/);return true;
  });
  assert.equal(attempts,3);
});
test("invalid query and permission denial are not retried",async()=>{
  const gateway=new SalesforceReadRequestGateway({backoffMs:0});
  for(const status of [400,401,403,404]){
    let attempts=0;
    const result=await gateway.read("read",scope,async()=>{
      attempts++;return {response:new Response("{}",{status}),payload:{}};
    });
    assert.equal(attempts,1);assert.equal(result.response.status,status);
  }
});
test("transient HTTP 503 retries within the same bounded policy",async()=>{
  const gateway=new SalesforceReadRequestGateway({backoffMs:0});
  let attempts=0;
  const result=await gateway.read("read",scope,async()=>{
    if(++attempts<3)return {response:new Response("{}",{status:503}),payload:"unavailable"};
    return ok();
  });
  assert.equal(result.payload,"ok");assert.equal(attempts,3);
});
test("queued and retrying requests reject changed org scope before further HTTP work",async()=>{
  const gateway=new SalesforceReadRequestGateway({concurrency:1,backoffMs:0});
  let epoch=1,reads=0,release!:()=>void;
  const assertScope=()=>{if(epoch!==1)throw new Error("org switched");};
  const first=gateway.read("first",assertScope,async()=>{
    await new Promise<void>(resolve=>{release=resolve;});
    return ok();
  });
  const second=gateway.read("second",assertScope,async()=>{reads++;return ok();});
  epoch=2;release();
  await Promise.all([assert.rejects(first,/org switched/),assert.rejects(second,/org switched/)]);
  assert.equal(reads,0);
});
