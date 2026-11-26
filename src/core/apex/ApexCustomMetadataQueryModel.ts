import {maskApexSource, stripApexComments,type IndexedApexMethod} from "./ApexSourceModel.js";
import {canonicalApexType,parseApexDeclaration} from "./ApexTypeSystem.js";

/** Shared syntax for a bounded, read-only Custom Metadata SELECT. No Apex
 * execution or query string interpolation is performed by this parser. */
export interface MetadataLoopQuery {
  expression:string;
  type:string;
  fields:string[];
  /** Only singleton LIMIT 1, with unique matching row proof. */
  singletonLimit?:true;
  predicates:Array<{field:string;right:string;bind:boolean}>;
}
const API=/^[A-Za-z_]\w*$/;

export function parseCustomMetadataQuery(source:string):MetadataLoopQuery|undefined {
  const expression=stripApexComments(source).trim();
  if(!/^\[\s*SELECT\b[\s\S]*\]$/i.test(expression))return undefined;
  let body=expression.slice(1,-1).trim()
    .replace(/\s+WITH\s+(?:SECURITY_ENFORCED|USER_MODE|SYSTEM_MODE)\s*$/i,"");
  const limit=/\s+LIMIT\s+1\s*$/i.exec(maskApexSource(body));
  if(limit)body=body.slice(0,limit.index).trim();
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
  return {expression,type:parsed[2],fields,predicates,...(limit?{singletonLimit:true as const}:{})};
}

/** Recognize a source-proven, side-effect-free metadata selector helper.
 * Its body must consist solely of an optional blank guard, a typed singleton
 * SELECT and an empty-list guard/first-row return. No arbitrary Apex runs. */
export function metadataSelectorHelper(method:IndexedApexMethod):MetadataLoopQuery|undefined{
  if(method.visibility!=="private"||!method.isStatic||method.parameters.length!==1||
    canonicalApexType(method.parameterTypes?.[0])!=="string")return undefined;
  const parameter=method.parameters[0].toLowerCase();
  if(!API.test(parameter))return undefined;
  const normalized=(s:string)=>stripApexComments(s).replace(/\s+/g,"").toLowerCase();
  const nodes=[...method.body];
  const first=nodes[0];
  if(first?.kind==="if"){
    if(normalized(first.condition??"")!=="string.isblank("+parameter+")"||
      first.otherwise?.length||first.body?.length!==1||
      first.body[0].kind!=="statement"||normalized(first.body[0].text??"")!=="returnnull;")return undefined;
    nodes.shift();
  }
  if(nodes.length!==2&&nodes.length!==3)return undefined;
  const declaration=nodes[0];
  if(declaration.kind!=="statement")return undefined;
  const source=stripApexComments(declaration.text??"").trim();
  const local=parseApexDeclaration(source);
  const initializer=/^[\s\S]*?=\s*(\[\s*SELECT\b[\s\S]*\])\s*;$/i.exec(source);
  if(!local||!initializer)return undefined;
  const query=parseCustomMetadataQuery(initializer[1]);
  if(!query?.singletonLimit||local.type!=="list<"+query.type.toLowerCase()+">"||
    canonicalApexType(method.returnType)!==query.type.toLowerCase())return undefined;
  const selector=query.predicates.filter(p=>p.bind);
  if(selector.length!==1||selector[0].field.toLowerCase()!=="developername"||
    selector[0].right.toLowerCase()!==parameter||
    query.predicates.some(p=>!p.bind&&p.field.toLowerCase()==="developername"))return undefined;
  const variable=local.name.toLowerCase(),last=nodes.at(-1)!;
  if(last.kind!=="statement")return undefined;
  if(nodes.length===2){
    if(normalized(last.text??"")!=="return"+variable+".isempty()?null:"+variable+"[0];")return undefined;
  }else{
    const guard=nodes[1];
    if(guard.kind!=="if"||guard.otherwise?.length||guard.body?.length!==1||guard.body[0].kind!=="statement")return undefined;
    const condition=normalized(guard.condition??""),body=normalized(guard.body[0].text??""),tail=normalized(last.text??"");
    if(!((condition===variable+".isempty()"&&body==="returnnull;"&&tail==="return"+variable+"[0];")||
      (condition==="!"+variable+".isempty()"&&body==="return"+variable+"[0];"&&tail==="returnnull;")))return undefined;
  }
  return query;
}
