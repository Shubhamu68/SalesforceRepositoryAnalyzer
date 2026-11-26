import {test} from "node:test";
import assert from "node:assert/strict";
import {VerificationReadCache} from "../src/salesforce/VerificationReadCache.js";

test("pending verification survives TTL and capacity pressure without refreshing expired evidence",async()=>{
 let now=0,loads=0,release!:(n:number)=>void;
 const cache=new VerificationReadCache<number>(60,1,"test",()=>now);
 const first=cache.read("A",()=>{loads++;return new Promise<number>(resolve=>{release=resolve;});});
 await Promise.resolve();
 now=61;
 await cache.read("B",async()=>2);
 const joined=cache.read("A",async()=>{loads++;return 3;});
 assert.equal(joined,first);
 release(1);
 assert.deepEqual(await Promise.all([first,joined]),[1,1]);assert.equal(loads,1);
 assert.equal(await cache.read("A",async()=>{loads++;return 4;}),4);
 assert.equal(loads,2);
});
test("cache hits do not slide TTL, and failed pending reads are retried",async()=>{
 let now=0,loads=0;
 const cache=new VerificationReadCache<number>(60,2,"test",()=>now);
 const load=async()=>++loads;
 assert.equal(await cache.read("A",load),1);
 now=59;assert.equal(await cache.read("A",load),1);
 now=60;assert.equal(await cache.read("A",load),2);
 await assert.rejects(cache.read("B",async()=>{throw Error("failed");}),/failed/);
 assert.equal(await cache.read("B",load),3);
 assert.equal(await cache.read("C",load),4);
 assert.equal(await cache.read("B",load),3);
});
test("pending-only cache shares identical reads but never reuses completed results",async()=>{
 const cache=new VerificationReadCache<number>(0,1,"test");
 let n=0;
 const load=async()=>++n;
 assert.deepEqual(await Promise.all([cache.read("A",load),cache.read("A",load),cache.read("B",load)]),[1,1,2]);
 assert.equal(await cache.read("A",load),3);
});
