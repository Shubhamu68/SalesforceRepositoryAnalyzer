import {setTimeout as delay} from "node:timers/promises";
import {recordSoqlCount,timeSoqlPhase} from "../services/SoqlPerformanceMetrics.js";

/** Shared, per-connection read-only transport boundary. Queue time is not
 * charged against the individual HTTP timeout. Retries never hold a slot
 * during backoff, and error messages contain no URLs, tokens or query text. */
export class SalesforceReadTransportError extends Error {
  constructor(message:string){super(message);this.name="SalesforceReadTransportError";}
}
interface TransportFailure {code:string;timeout:boolean;retryable:boolean;}
function classify(error:unknown):TransportFailure{
  const e=error as {name?:unknown;code?:unknown;cause?:{code?:unknown}}|null;
  const code=e?.cause?.code??e?.code;
  const known=new Set(["ECONNRESET","ECONNREFUSED","ETIMEDOUT","EAI_AGAIN","ENETUNREACH",
    "EHOSTUNREACH","ENOTFOUND","EPIPE","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT","UND_ERR_SOCKET","UND_ERR_ABORTED"]);
  const safeCode=typeof code==="string"&&known.has(code)?code:undefined;
  const timeout=e?.name==="TimeoutError"||safeCode==="ETIMEDOUT"||
    Boolean(safeCode?.endsWith("_TIMEOUT"));
  const retryable=timeout||e?.name==="AbortError"||
    (safeCode!==undefined?safeCode!=="ENOTFOUND":code===undefined&&e?.name==="TypeError");
  return {code:safeCode??(timeout?"TIMEOUT":e?.name==="AbortError"?"ABORTED":
    e?.name==="TypeError"?"FETCH_FAILED":"TRANSPORT_ERROR"),timeout,retryable};
}

export interface SalesforceReadOptions {
  concurrency?:number;
  timeoutMs?:number;
  maxRetries?:number;
  backoffMs?:number;
}
export interface SalesforceReadResult<T> {
  response:Response;payload:T;attempts:number;elapsedMs:number;
}
export class SalesforceReadRequestGateway {
  private active=0;
  private readonly queue:Array<()=>void>=[];
  private readonly concurrency:number;
  private readonly timeoutMs:number;
  private readonly maxRetries:number;
  private readonly backoffMs:number;
  constructor(options:SalesforceReadOptions={}){
    this.concurrency=options.concurrency??4;
    this.timeoutMs=options.timeoutMs??20000;
    this.maxRetries=options.maxRetries??2;
    this.backoffMs=options.backoffMs??250;
    if(!Number.isInteger(this.concurrency)||this.concurrency<1||
      !Number.isInteger(this.maxRetries)||this.maxRetries<0||
      !Number.isFinite(this.timeoutMs)||this.timeoutMs<=0||
      !Number.isFinite(this.backoffMs)||this.backoffMs<0)
      throw new Error("Invalid Salesforce read request gateway configuration.");
  }
  private async slot<T>(work:()=>Promise<T>):Promise<T>{
    if(this.active>=this.concurrency){
      recordSoqlCount("org.http.queue_waits");
      await timeSoqlPhase("org.http.queue_cumulative_ms",()=>new Promise<void>(resolve=>this.queue.push(resolve)));
    }else this.active++;
    recordSoqlCount("org.http.attempts");
    try{return await timeSoqlPhase("org.http.work_cumulative_ms",work);}
    finally{
      const next=this.queue.shift();
      // Transfer this slot directly to the oldest waiter.
      if(next)next();else this.active--;
    }
  }
  /** Scope assertions happen outside the retryable transport try/catch.
   * A queued request must never run against a newly selected org. */
  async read<T>(label:string,assertScope:()=>void,
    request:(signal:AbortSignal)=>Promise<{response:Response;payload:T}>):
    Promise<SalesforceReadResult<T>>{
    const started=Date.now();
    for(let attempt=0;;attempt++){
      const result=await this.slot(async()=>{
        assertScope();
        const attemptStart=Date.now();
        try{
          const value=await request(AbortSignal.timeout(this.timeoutMs));
          return {value,elapsed:Date.now()-attemptStart} as const;
        }catch(error){
          return {failure:classify(error),elapsed:Date.now()-attemptStart} as const;
        }
      });
      assertScope();
      let backoff=this.backoffMs*2**attempt;
      if("value" in result&&result.value!==undefined){
        const status=result.value.response.status;
        const completed=()=>({...result.value!,attempts:attempt+1,elapsedMs:Date.now()-started});
        if(![408,429,502,503,504].includes(status)||attempt>=this.maxRetries)
          return completed();
        // Honor a short Retry-After hint; don't tie up a user scan for long
        // server-imposed delays or retry before the server allows it.
        const hint=result.value.response.headers?.get?.("Retry-After");
        if(hint){
          const wait=/^\d+$/.test(hint)?Number(hint)*1000:Date.parse(hint)-Date.now();
          if(Number.isFinite(wait)){
            if(wait>5000)return completed();
            backoff=Math.max(backoff,wait);
          }
        }
      }else if("failure" in result&&result.failure!==undefined){
        const failure=result.failure;
        if(!failure.retryable||attempt>=this.maxRetries){
          const detail=failure.timeout?"timed out (per-attempt timeout "+this.timeoutMs+" ms)":"transport request failed";
          throw new SalesforceReadTransportError(label+": "+detail+" ["+failure.code+
            "]; "+(attempt+1)+" attempt(s), last request "+result.elapsed+" ms, total "+
            (Date.now()-started)+" ms.");
        }
      }
      await delay(backoff);
    }
  }
}
