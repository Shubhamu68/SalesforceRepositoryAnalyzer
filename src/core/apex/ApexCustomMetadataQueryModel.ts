import {maskApexSource, stripApexComments} from "./ApexSourceModel.js";

/** Shared syntax for a bounded, read-only Custom Metadata SELECT. No Apex
 * execution or query string interpolation is performed by this parser. */
export interface MetadataLoopQuery {
  expression:string;
  type:string;
  fields:string[];
  predicates:Array<{field:string;right:string;bind:boolean}>;
}
const API=/^[A-Za-z_]\w*$/;

export function parseCustomMetadataQuery(source:string):MetadataLoopQuery|undefined {
  const expression=stripApexComments(source).trim();
  if(!/^\[\s*SELECT\b[\s\S]*\]$/i.test(expression))return undefined;
  const body=expression.slice(1,-1).trim()
    .replace(/\s+WITH\s+(?:SECURITY_ENFORCED|USER_MODE|SYSTEM_MODE)\s*$/i,"");
  const parsed=/^SELECT\s+([\w\s,]+?)\s+FROM\s+([A-Za-z_]\w*__mdt)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(body);
  if(!parsed)return undefined;
  const fields=parsed[1].split(",").map(x=>x.trim());
  if(!fields.length||fields.length>100||fields.some(x=>!API.test(x)))return undefined;
  const predicates:MetadataLoopQuery["predicates"]=[];
  if(parsed[3]){
    const where=parsed[3],masked=maskApexSource(where);
    let start=0;
    const terms:string[]=[];
    for(const hit of masked.matchAll(/\bAND\b/gi)){
      // Only standalone, unquoted AND separators. A value or field named
      // AND cannot silently be treated as a supported equality clause.
      terms.push(where.slice(start,hit.index!));start=hit.index!+hit[0].length;
    }
    terms.push(where.slice(start));
    if(terms.length>20)return undefined;
    for(const term of terms){
      const m=/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(term.trim());
      if(!m)return undefined;
      const rhs=m[2].trim();
      const bind=rhs.startsWith(":");
      const right=bind?rhs.slice(1).trim():rhs;
      // Restricted to scalar literal and simple Apex variable/member binds.
      // Unsupported filters (OR, IN, LIMIT, functions, etc.) fail closed.
      if(bind?!/^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*$/.test(right):
        !/^(?:'(?:\\.|[^'\\])*'|true|false|-?\d+(?:\.\d+)?)$/i.test(right))
        return undefined;
      predicates.push({field:m[1],right:bind?right.replace(/\s*\.\s*/g,"."):right,bind});
    }
  }
  return {expression,type:parsed[2],fields,predicates};
}
