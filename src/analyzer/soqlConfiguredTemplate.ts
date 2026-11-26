import {maskSoqlStringsAndComments} from "./soqlExecutionMode.js";
import {simplePermissionShape} from "./soqlPermissionAggregation.js";

/** Mirror only the permission-relevant effect of literal placeholder
 * substitution. Names and runtime values are not interpreted as fields.
 * Refuse placeholders in query structure or inside quotes/comments. */
export function normalizeConfiguredSoqlTemplate(template:string):string|undefined{
  if(!template.trim()||template.length>16000)return undefined;
  const visible=maskSoqlStringsAndComments(template);
  // Runtime creates only its own binds. Do not certify preexisting bind
  // syntax, multiple statements or comments/quoted placeholders.
  if(/[:;]/.test(visible))return undefined;
  const hits=[...template.matchAll(/\{([^}]+)\}/g)];
  if(!hits.length||hits.length>100)return undefined;
  const names=new Map<string,string>();
  for(const hit of hits){
    const at=hit.index!,end=at+hit[0].length;
    if(!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(hit[1])||
       visible.slice(at,end)!==hit[0])return undefined;
    const before=visible.slice(0,at),after=visible.slice(end);
    if(!/\bWHERE\b/i.test(before)||
       !/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|<=|>=|=|<|>|(?:NOT\s+)?LIKE)\s*$/i.test(before)||
       !/^\s*(?:$|\)|AND\b|OR\b|WITH\b|ORDER\s+BY\b|LIMIT\b|OFFSET\b|FOR\b)/i.test(after))return undefined;
    if(!names.has(hit[0]))names.set(hit[0],"fb"+names.size);
  }
  const normalized=template.replace(/\{([^}]+)\}/g,token=>":"+names.get(token));
  if(/[{}]/.test(normalized)||!simplePermissionShape(normalized))return undefined;
  return normalized;
}
