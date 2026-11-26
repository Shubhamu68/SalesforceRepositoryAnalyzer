import { AsyncLocalStorage } from "node:async_hooks";
import type { OrgObjectAccessEvidence } from "../salesforce/SalesforcePersonaAccessVerifier.js";
import type { OrgCheckedUser } from "../models/StackTraceImpact.js";

/** Request-local provenance, including cached evidence actually consumed.
 * No additional Salesforce lookup, no process-global last-selected user,
 * and no personal data in performance logs. */
const context=new AsyncLocalStorage<Map<string,OrgCheckedUser>>();
export async function captureVerificationUsers<T>(work:()=>Promise<T>):Promise<{result:T;users:OrgCheckedUser[]}>{
  const users=new Map<string,OrgCheckedUser>();
  const result=await context.run(users,work);
  return {result,users:[...users.values()].sort((a,b)=>a.id.localeCompare(b.id))};
}
export function noteVerificationEvidence(evidence:OrgObjectAccessEvidence|undefined):void{
  const users=context.getStore();
  if(!users||!evidence||evidence.checkedUsers<=0)return;
  for(const user of evidence.checkedUserDetails??[])users.set(user.id,{...user});
}
export function verificationUserLabel(users:readonly OrgCheckedUser[]):string{
  if(!users.length)return "No Salesforce user verified (repository-only or live verification unavailable/not required)";
  const names=users.map(user=>user.name+" ("+user.username+")");
  return (names.length>1?"Multiple users used: ":"")+names.join("; ");
}
