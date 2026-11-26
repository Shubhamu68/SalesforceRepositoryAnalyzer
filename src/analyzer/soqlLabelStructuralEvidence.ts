import {indexApexMethods,maskApexSource,stripApexComments} from "../core/apex/ApexSourceModel.js";
import {proveApexLabelCollectionInputs} from "../core/apex/ApexLabelCollectionEvidence.js";
import type {ApexCallSite} from "../core/apex/ApexInvocationModel.js";
import type {ApexCallResolver} from "../core/apex/ApexTypeSystem.js";
import {directTemplate,proveCallerPermissionShapes} from "./soqlCallerStructuralEvidence.js";

const clean=(s:string)=>stripApexComments(s).trim();
const word=(name:string)=>new RegExp("\\b"+name+"\\b","gi");

/** Proven read-only label-backed collection inventory. No simulated batch
 * transaction or assumption that static state survives between transactions.
 * Require every cache reference and getter alias to remain in a narrow
 * read-only source pattern; unknown callers/mutations are not ignored. */
export function proveLabelBackedPermissionShapes(source:string,site:ApexCallSite,resolveExternal?:ApexCallResolver,methods=indexApexMethods(source)):string[]{
  if(!resolveExternal)return [];
  const template=directTemplate(source,site,methods);
  if(!template)return [];
  const target=template.owner;
  if(target.visibility!=="private"||target.parameters.length!==1||
    target.parameterTypes?.[0]?.replace(/\s/g,"").toLowerCase()!=="list<string>"||
    target.body.length>2||target.body.some(n=>n.kind!=="statement")||
    !/^return\s/i.test(clean(target.body.at(-1)?.text??"")))return [];
  const parameter=target.parameters[0];
  // The sole incoming alias must be consumed only in the SELECT builder,
  // not returned, mutated or passed into a second helper.
  const joins=[...template.expression.matchAll(new RegExp("\\bString\\s*\\.\\s*join\\s*\\(\\s*"+parameter+"\\s*,\\s*'(?:\\\\.|[^'\\\\])*'\\s*\\)","gi"))];
  if(joins.length!==1||[...maskApexSource(source.slice(target.start,target.end)).matchAll(word(parameter))].length!==1)return [];
  const seeds=proveApexLabelCollectionInputs(source,target,methods,resolveExternal,()=>true)
    .filter(seed=>seed[0]?.kind==="collection"&&seed[0].items.every(f=>/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(f)));
  return proveCallerPermissionShapes(source,site,seeds,methods);
}
