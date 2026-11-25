import {maskApexSource,matchingPair,type IndexedApexMethod} from "./ApexSourceModel.js";

export interface ObjectMapReadModel {valueType:string;fields:ReadonlySet<string>}

/** Only a nested, direct scalar-field class, not custom property accessors.
 * This is a repository-visible alias proof, not runtime immutability. */
export function objectMapReadModel(owner:string,initializer:string,source:string):ObjectMapReadModel|undefined{
  const map=/^new\s+Map\s*<\s*Integer\s*,\s*([A-Za-z_]\w*)\s*>\s*\{/i.exec(initializer.trim());
  if(!map)return undefined;
  const masked=maskApexSource(source);
  const outer=/\bclass\s+([A-Za-z_]\w*)\s*[^{;]*\{/i.exec(masked);
  if(!outer||outer[1].toLowerCase()!==owner.toLowerCase())return undefined;
  const start=outer.index+outer[0].length-1,end=matchingPair(masked,start,"{","}");
  const hits=[...masked.matchAll(new RegExp("\\bclass\\s+"+map[1]+"\\s*\\{","gi"))].filter(h=>{
    if(h.index!<=start||h.index!>=end)return false;
    let depth=1;for(let i=start+1;i<h.index!;i++){if(masked[i]==="{")depth++;else if(masked[i]==="}")depth--;}
    return depth===1;
  });
  if(hits.length!==1)return undefined;
  const open=hits[0].index!+hits[0][0].length-1,close=matchingPair(masked,open,"{","}");
  if(close<0)return undefined;
  const fields=new Set<string>();
  const body=masked.slice(open+1,close);
  let depth=0,begin=0;
  for(let i=0;i<body.length;i++){
    if(body[i]==="{")depth++;
    else if(body[i]==="}"){depth--;if(!depth)begin=i+1;}
    else if(body[i]===";"&&!depth){
      const field=/^\s*(?:public|global)\s+(?:String|Id|Integer|Long|Decimal|Double|Boolean|Date|DateTime)\s+([A-Za-z_]\w*)\s*(?:=\s*[^;{}]+)?\s*;$/i.exec(body.slice(begin,i+1));
      if(!field)return undefined;
      fields.add(field[1].toLowerCase());begin=i+1;
    }
  }
  if(!fields.size||fields.size>100)return undefined;
  return {valueType:owner+"."+map[1],fields};
}

function scalarMemberRead(text:string,offset:number,fields:ReadonlySet<string>):boolean{
  const member=/^\s*\.\s*([A-Za-z_]\w*)\b/.exec(text.slice(offset));
  if(!member||!fields.has(member[1].toLowerCase()))return false;
  const rest=text.slice(offset+member[0].length);
  return !/^\s*(?:\.(?!\d)|\(|\[|=(?!=|>)|[+\-*/%&|^]=|\+\+|--)/.test(rest);
}
function mapUse(masked:string,start:number,end:number,methods:readonly IndexedApexMethod[],model:ObjectMapReadModel):boolean{
  if(/(?:\+\+|--)\s*$/.test(masked.slice(Math.max(0,start-20),start)))return false;
  const op=/^\s*\.\s*(get|containsKey|size|isEmpty)\s*\(/i.exec(masked.slice(end));
  if(!op)return false;
  const open=end+op[0].length-1,close=matchingPair(masked,open);
  if(close<0)return false;
  const key=masked.slice(open+1,close).trim();
  if(/^(?:size|isempty)$/i.test(op[1]))return !key;
  if(!/^(?:-?\d+|(?:this\s*\.\s*)?[A-Za-z_]\w*)$/i.test(key))return false;
  if(/^containskey$/i.test(op[1]))return true;
  if(scalarMemberRead(masked,close+1,model.fields))return true;
  if(!/^\s*;/.test(masked.slice(close+1)))return false;
  const method=methods.filter(m=>m.start<=start&&start<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!method)return false;
  const type=model.valueType.replace(/\./g,"\\s*\\.\\s*");
  const local=new RegExp("\\b"+type+"\\s+([A-Za-z_]\\w*)\\s*=\\s*$","i").exec(masked.slice(method.start,start));
  if(!local)return false;
  const name=local[1],declarationAt=method.start+local.index+local[0].toLowerCase().lastIndexOf(name.toLowerCase());
  const body=masked.slice(method.start,method.end);
  if(method.parameters.some(p=>p.toLowerCase()===name.toLowerCase()))return false;
  for(const hit of body.matchAll(new RegExp("\\b"+name+"\\b","gi"))){
    const at=method.start+hit.index!;
    if(at===declarationAt)continue;
    if(/\.\s*$/.test(masked.slice(Math.max(method.start,at-20),at))||/(?:\+\+|--)\s*$/.test(masked.slice(Math.max(method.start,at-20),at)))return false;
    if(!scalarMemberRead(masked,at+name.length,model.fields))return false;
  }
  return true;
}

/** The map is assigned directly to a private instance field, and neither
 * that reference nor its custom values may escape or be mutated. */
export function provePrivateObjectMapAlias(masked:string,referenceStart:number,referenceEnd:number,methods:readonly IndexedApexMethod[],model:ObjectMapReadModel):boolean{
  const type=model.valueType.replace(/\./g,"\\s*\\.\\s*");
  const prefix=masked.slice(0,referenceStart);
  const match=new RegExp("\\bprivate\\s+Map\\s*<\\s*Integer\\s*,\\s*"+type+"\\s*>\\s+([A-Za-z_]\\w*)\\s*=\\s*$","i").exec(prefix);
  if(!match||!/^\s*;/.test(masked.slice(referenceEnd)))return false;
  if(methods.some(m=>m.start<=referenceStart&&referenceStart<m.end))return false;
  const name=match[1],declarationAt=match.index+match[0].toLowerCase().lastIndexOf(name.toLowerCase());
  for(const hit of masked.matchAll(new RegExp("\\b"+name+"\\b","gi"))){
    const at=hit.index!;
    if(at===declarationAt)continue;
    const qualifier=/\b([A-Za-z_]\w*)\s*\.\s*$/.exec(masked.slice(Math.max(0,at-40),at));
    if(qualifier&&qualifier[1].toLowerCase()!=="this")return false;
    const begin=qualifier?at-(qualifier[0].length):at;
    if(!mapUse(masked,begin,at+name.length,methods,model))return false;
  }
  return true;
}
export function proveDirectObjectMapRead(masked:string,start:number,end:number,methods:readonly IndexedApexMethod[],model:ObjectMapReadModel):boolean{
  return mapUse(masked,start,end,methods,model);
}
