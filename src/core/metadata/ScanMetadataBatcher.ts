import {setImmediate as nextTurn} from "node:timers/promises";
import type {MetadataResult} from "./ApexMetadataProvider.js";
import {countApex} from "../apex/ApexPerformance.js";

/** One queue per engine/scan. No cross-run metadata cache or speculative reads.
 * Let concurrent classes publish their proven requests in the same turn,
 * then dispatch bounded chunks. A failed/missing result takes the old path. */
export class ScanMetadataBatcher<K,V>{
  private pending:Array<{key:K;resolve:(value:MetadataResult<V>)=>void;reject:(error:unknown)=>void}>=[];
  private scheduled=false;
  constructor(private readonly identity:(key:K)=>string,
    private readonly single:(key:K)=>Promise<MetadataResult<V>>,
    private readonly bulk:((keys:readonly K[])=>Promise<ReadonlyMap<string,MetadataResult<V>>>)|undefined,
    private readonly size:number,
    private readonly valid:(value:unknown)=>boolean){}
  read(key:K):Promise<MetadataResult<V>>{
    if(!this.bulk)return this.single(key);
    return new Promise((resolve,reject)=>{
      this.pending.push({key,resolve,reject});
      if(!this.scheduled){
        this.scheduled=true;
        void nextTurn().then(()=>this.flush());
      }
    });
  }
  private async flush():Promise<void>{
    const pending=this.pending;this.pending=[];this.scheduled=false;
    // Independent bounded chunks still share the connection's HTTP limit.
    await Promise.all(Array.from({length:Math.ceil(pending.length/this.size)},async(_,i)=>{
      const chunk=pending.slice(i*this.size,(i+1)*this.size);
      let results:ReadonlyMap<string,MetadataResult<V>>|undefined;
      if(chunk.length>1){
        countApex("metadata.batch_groups");
        try{results=await this.bulk!(chunk.map(item=>item.key));}
        catch{countApex("metadata.batch_failures");}
      }
      await Promise.all(chunk.map(async item=>{
        try{
          const candidate=results?.get(this.identity(item.key));
          if(candidate?.complete===true&&this.valid(candidate.value)){
            countApex("metadata.batch_resolved");item.resolve(candidate);return;
          }
          if(chunk.length>1)countApex("metadata.batch_exact_fallbacks");
          item.resolve(await this.single(item.key));
        }catch(error){item.reject(error);}
      }));
    }));
  }
}
