import { evaluateApexExpression, textValue, unknown, type ApexValue }
  from "./ApexValueEvaluator.js";
import { maskApexSource, matchingPair, stripApexComments }
  from "./ApexSourceModel.js";
import type { ApexMetadataProvider } from "../metadata/ApexMetadataProvider.js";

/** A syntactically complete, bounded literal SOQL iterator over Custom Metadata. */
interface MetadataLoopQuery {
  expression:string;
  type:string;
  fields:string[];
  predicates:Array<{field:string;right:string}>;
}
const API=/^[A-Za-z_]\w*$/;
const MAX_ROWS=100;
const MAX_REFERENCES=30;

/**
 * Only complete, source-local [SELECT ... FROM Object__mdt WHERE ...]
 * iterables can be interpreted. Invalid predicates never trigger a best-effort
 * org query, because filtering errors would invent executable query variants.
 */
export function findCustomMetadataLoops(source:string):MetadataLoopQuery[] {
  const clean=stripApexComments(source);
  const visible=maskApexSource(clean);
  const result:MetadataLoopQuery[]=[];
  for(let i=0;i<visible.length;i++){
    if(visible[i]!=="[")continue;
    const end=matchingPair(visible,i,"[","]");
    if(end<0)continue;
    const expression=clean.slice(i,end+1).trim();
    const body=expression.slice(1,-1).trim();
    const parsed=/^SELECT\s+([\w\s,]+?)\s+FROM\s+([A-Za-z_]\w*__mdt)\s+WHERE\s+([\s\S]+?)\s*(?:WITH\s+SECURITY_ENFORCED)?$/i.exec(body);
    if(!parsed){i=end;continue;}
    const fields=parsed[1].split(",").map(x=>x.trim());
    if(!fields.length||fields.some(x=>!API.test(x))){i=end;continue;}
    const pieces=parsed[3].split(/\s+AND\s+/i);
    const predicates:Array<{field:string;right:string}>=[];
    let valid=pieces.length>0;
    for(const term of pieces) {
      const m=/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(term.trim());
      if(!m||!API.test(m[1])||/\b(?:OR|LIKE|IN|GROUP|ORDER|LIMIT)\b/i.test(m[2].replace(/'(?:\\.|[^'])*'/g,""))){
        valid=false;break;
      }
      predicates.push({field:m[1],right:m[2].trim()});
    }
    if(valid)result.push({expression,type:parsed[2],fields,predicates});
    i=end;
    if(result.length>MAX_REFERENCES)break;
  }
  return result;
}
function scalar(value:unknown):ApexValue {
  if(typeof value==="string")return textValue(value);
  if(typeof value==="boolean")return textValue(String(value));
  if(typeof value==="number"&&Number.isFinite(value))
    return {kind:"number",value};
  return unknown("Custom Metadata value is null or not a scalar.");
}
function single(value:ApexValue):string|undefined {
  if(value.kind==="text"&&value.values.length===1)return value.values[0];
  if(value.kind==="number")return String(value.value);
  return undefined;
}

/**
 * Preload an org-backed row inventory before symbolic Apex evaluation.
 * Every WHERE bind and selected field must be completely provable.
 * The result is immutable and can be reused by the symbolic execution engine.
 */
export async function buildCustomMetadataRows(
  source:string,metadata:ApexMetadataProvider|undefined,
  resolveConstant:(name:string)=>ApexValue|undefined,
):Promise<Map<string,ApexValue>> {
  const descriptors=findCustomMetadataLoops(source);
  const outputs=new Map<string,ApexValue>();
  if(!descriptors.length)return outputs;
  for(const descriptor of descriptors){
    const fail=(reason:string)=>outputs.set(descriptor.expression,unknown(reason));
    if(!metadata){fail("Custom Metadata requires a connected authoritative org.");continue;}
    if(descriptors.length>MAX_REFERENCES) {
      fail("Too many Custom Metadata query references.");continue;
    }
    const filters:Array<{field:string;value:string}>=[];
    let unsafe:string|undefined;
    for(const predicate of descriptor.predicates){
      const rhs=predicate.right.replace(/^:/,"");
      const evaluated=evaluateApexExpression(rhs,{
        values:new Map(),
        resolveCall:(name,args)=>name==="Apex.constant" &&
          args[0]?.kind==="text"&&args[0].values.length===1
          ?resolveConstant(args[0].values[0]):undefined,
      });
      const value=single(evaluated);
      if(value===undefined){
        unsafe="Custom Metadata WHERE "+predicate.field+
          " depends on an unresolved runtime value or mutable Apex constant.";
        break;
      }
      filters.push({field:predicate.field,value});
    }
    if(unsafe){fail(unsafe);continue;}
    const selected=[...new Set([...descriptor.fields,
      ...descriptor.predicates.map(x=>x.field)])];
    const found=await metadata.getCustomMetadataRecords(descriptor.type,selected);
    if(!found.complete||!found.value){
      fail("Complete Custom Metadata "+descriptor.type+" rows unavailable: "+
        (found.reason??"Live org metadata not verified."));continue;
    }
    const matching:Array<Array<[string,ApexValue]>>=[];
    let invalid=false;
    for(const raw of found.value){
      if(!raw||typeof raw!=="object"){invalid=true;break;}
      const included=filters.every(({field,value})=>{
        const actual=scalar(raw[field]);
        const converted=single(actual);
        return converted!==undefined&&converted.toLowerCase()===value.toLowerCase();
      });
      if(!included)continue;
      const values:Array<[string,ApexValue]>=[];
      for(const field of descriptor.fields){
        if(!Object.prototype.hasOwnProperty.call(raw,field)){
          invalid=true;break;
        }
        const item=scalar(raw[field]);
        if(item.kind==="unknown"){invalid=true;break;}
        if(/(?:^|_)Field__c$/i.test(field)){
          const value=single(item);
          if(!value||!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value)){
            invalid=true;break;
          }
        }
        values.push([field,item]);
      }
      if(invalid)break;
      matching.push(values);
      if(matching.length>MAX_ROWS){invalid=true;break;}
    }
    if(invalid){fail("Custom Metadata rows have incomplete or unsafe fields, or exceed the bounded row limit.");continue;}
    // The metadata query does not specify ORDER BY. Appending the complete
    // field inventory to a SELECT is order-insensitive for OLS/FLS; canonical
    // sorting avoids nondeterministic workbook output for equal row sets.
    matching.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    outputs.set(descriptor.expression,{kind:"records",items:matching});
  }
  return outputs;
}
