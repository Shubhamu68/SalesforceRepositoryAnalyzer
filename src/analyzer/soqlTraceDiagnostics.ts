import type {ApexDependencyDiagnostic} from "../core/apex/ApexDependencyDiagnostics.js";
import {sourceFileName,sourceIdentifier} from "../core/apex/ApexDependencyDiagnostics.js";

const MAX_EVENTS=100;
export interface SoqlTraceReport {
  file:string;line:number;offset:number;dependency?:string;
  fallback:string;
  priorVariants:number;localCandidates:number;callerCandidates:number;
  backwardCandidates:number;callerEdges:number;metadataRows:number;bounded:boolean;
  compatibleShapes:number;aggregateCandidates:number;added:number;
  events:ApexDependencyDiagnostic[];omittedEvents:number;
}
export function newSoqlTraceReport(filePath:string,line:number,offset:number,argument:string):SoqlTraceReport{
  return {file:sourceFileName(filePath),line,offset,dependency:sourceIdentifier(argument.trim()),
    fallback:"NOT_ATTEMPTED",priorVariants:0,localCandidates:0,callerCandidates:0,backwardCandidates:0,
    callerEdges:0,metadataRows:0,bounded:false,compatibleShapes:0,aggregateCandidates:0,added:0,events:[],omittedEvents:0};
}
/** Keep bounded, deduplicated source diagnostics only. Repeated metadata passes
 * are discarded by the normal analysis engine before the final scan is logged. */
export function collectSoqlTrace(report:SoqlTraceReport){
  const seen=new Set<string>();
  return (event:ApexDependencyDiagnostic)=>{
    const key=JSON.stringify(event);
    if(seen.has(key))return;
    if(report.events.length>=MAX_EVENTS){report.omittedEvents++;return;}
    seen.add(key);report.events.push(event);
  };
}
export function emitSoqlTraceReports(sites:readonly {trace?:SoqlTraceReport}[],write:(line:string)=>void=console.info):void{
  const reports=sites.flatMap(s=>s.trace?[s.trace]:[]);
  write("[SOQL Trace] BEGIN unresolvedSites="+sites.length+" reports="+reports.length);
  for(const report of reports)write("[SOQL Trace] "+JSON.stringify(report));
  write("[SOQL Trace] END");
}
