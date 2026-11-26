import {maskApexSource,splitApexTopLevel} from "./ApexSourceModel.js";
import {canonicalApexType} from "./ApexTypeSystem.js";

export interface ApexClassDeclaration {
  name:string;
  parent?:string;
  interfaces:readonly string[];
  batch:boolean;
  stateful:boolean;
  queueable:boolean;
  schedulable:boolean;
}
/** Explicit declaration facts only. Unknown inheritance/interface dispatch
 * is not evidence of a framework implementation. */
export function parseApexClassDeclaration(name:string,header:string):ApexClassDeclaration|undefined{
  const text=maskApexSource(header).trim();
  const match=/^(?:extends\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*)?(?:implements\s+([\s\S]+))?$/i.exec(text);
  if(!match)return undefined;
  const interfaces=match[2]?splitApexTopLevel(match[2],",").map(canonicalApexType):[];
  if(interfaces.some(t=>!t)||new Set(interfaces).size!==interfaces.length)return undefined;
  const types=interfaces as string[];
  return {name,parent:match[1],interfaces:types,
    batch:types.some(t=>/^database\.batchable<[a-z_]\w*(?:\.[a-z_]\w*)*>$/.test(t)),
    stateful:types.includes("database.stateful"),
    queueable:types.includes("queueable")||types.includes("system.queueable"),
    schedulable:types.includes("schedulable")||types.includes("system.schedulable")};
}
export function supportsApexAllocation(declaration:ApexClassDeclaration|undefined):boolean{
  return !!declaration&&!declaration.parent&&declaration.interfaces.every(t=>
    /^database\.batchable<[a-z_]\w*(?:\.[a-z_]\w*)*>$/.test(t)||t==="database.stateful"||
    /^(?:system\.)?(?:queueable|schedulable)$/.test(t));
}
export function outerApexClass(source:string):ApexClassDeclaration|undefined{
  const hit=/\bclass\s+([A-Za-z_]\w*)\s*([^{;]*)\{/i.exec(maskApexSource(source));
  return hit?parseApexClassDeclaration(hit[1],hit[2]):undefined;
}
