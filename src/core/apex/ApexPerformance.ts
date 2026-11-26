import {AsyncLocalStorage} from "node:async_hooks";
import {performance} from "node:perf_hooks";

export interface ApexPerformanceSink {
  count(name:string,count:number):void;
  duration(name:string,ms:number):void;
}
const scope=new AsyncLocalStorage<ApexPerformanceSink>();
/** Generic consumer-owned instrumentation, no source, metadata or user data. */
export function withApexPerformance<T>(sink:ApexPerformanceSink,work:()=>T):T{
  return scope.run(sink,work);
}
export function countApex(name:string,count=1):void{
  scope.getStore()?.count(name,count);
}
export function timeApex<T>(name:string,work:()=>T):T{
  const sink=scope.getStore();
  if(!sink)return work();
  const started=performance.now();
  try{return work();}finally{sink.duration(name,performance.now()-started);}
}
