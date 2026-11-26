import {recordSoqlCount} from "../services/SoqlPerformanceMetrics.js";

/** Shared single-flight read cache. Pending work is independent of TTL/LRU:
 * queued or slow checks cannot be duplicated when their freshness expires.
 * Completed results age from the original request (not cache hits), exactly
 * as before. Expired pending results are delivered only to current waiters,
 * never installed as a fresh cache entry. No cross-key/user reuse. */
export class VerificationReadCache<T>{
  private readonly pending=new Map<string,Promise<T>>();
  private readonly completed=new Map<string,{until:number;value:T}>();
  constructor(private readonly ttl:number,private readonly maxEntries:number,
    private readonly metric:string,private readonly clock:()=>number=Date.now){}
  read(key:string,load:()=>Promise<T>):Promise<T>{
    const running=this.pending.get(key);
    if(running){
      recordSoqlCount(this.metric+".cache_hits");
      recordSoqlCount(this.metric+".inflight_hits");
      return running;
    }
    const now=this.clock(),hit=this.completed.get(key);
    if(hit&&hit.until>now){
      recordSoqlCount(this.metric+".cache_hits");
      // LRU position only, no sliding freshness.
      this.completed.delete(key);this.completed.set(key,hit);
      return Promise.resolve(hit.value);
    }
    if(hit)this.completed.delete(key);
    recordSoqlCount(this.metric+".cache_misses");
    const until=now+this.ttl;
    const promise=Promise.resolve().then(load).then(value=>{
      if(until>this.clock()){
        if(this.completed.size>=this.maxEntries){
          for(const [old,entry] of this.completed)if(entry.until<=this.clock())this.completed.delete(old);
          if(this.completed.size>=this.maxEntries)this.completed.delete(this.completed.keys().next().value!);
        }
        this.completed.set(key,{until,value});
      }
      return value;
    }).finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key);});
    this.pending.set(key,promise);
    return promise;
  }
}
