import {maskApexSource,stripApexComments,type SourceNode} from "./ApexSourceModel.js";
import {parseApexDeclaration} from "./ApexTypeSystem.js";
/** Bounded indexed List<String> projection. Prove the exact zero-based,
 * unit-step header and first local projection, and reject writes/escapes
 * of the list or index. Shared by lexical and collection replay proofs. */
export interface IndexedStringProjection {list:string;index:string;item:string}
export function proveIndexedStringProjection(node:SourceNode):IndexedStringProjection|undefined{
  if(node.kind!=="for"||node.loopVariable||!node.text||!node.body?.length)return undefined;
  const match=/^\s*Integer\s+([A-Za-z_]\w*)\s*=\s*0\s*;\s*([A-Za-z_]\w*)\s*<\s*([A-Za-z_]\w*)\s*\.\s*size\s*\(\s*\)\s*;\s*([A-Za-z_]\w*)\s*\+\+\s*$/i.exec(maskApexSource(node.text));
  if(!match||match[1].toLowerCase()!==match[2].toLowerCase()||match[1].toLowerCase()!==match[4].toLowerCase()||match[1].toLowerCase()===match[3].toLowerCase())return undefined;
  const index=match[1],list=match[3],first=node.body[0];
  if(first.kind!=="statement")return undefined;
  const projection=/^\s*String\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*)\s*\]\s*;\s*$/i.exec(stripApexComments(first.text??""));
  if(!projection||projection[2].toLowerCase()!==list.toLowerCase()||projection[3].toLowerCase()!==index.toLowerCase()||
    [list,index].some(n=>n.toLowerCase()===projection[1].toLowerCase()))return undefined;
  const item=projection[1],listUse=new RegExp("\\b"+list+"\\b","i");
  const writes=(name:string)=>new RegExp("\\b"+name+"\\s*(?:=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--)|(?:\\+\\+|--)\\s*"+name+"\\b","i");
  const check=(nodes:readonly SourceNode[]):boolean=>nodes.every(n=>{
    if(n.kind==="opaque"||n.kind==="for"||n.condition==="__apex_exception_path_unknown__")return false;
    const visible=maskApexSource((n.text??"")+" "+(n.condition??""));
    const decl=n.kind==="statement"?parseApexDeclaration(visible):undefined;
    if(listUse.test(visible)||writes(index).test(visible)||writes(item).test(visible)||
      decl&&[index,item].some(name=>name.toLowerCase()===decl.name.toLowerCase())||/\b(?:return|throw|break|continue)\b/i.test(visible))return false;
    // Reject hidden secondary declarations as well as explicit assignments.
    if(n.kind==="statement"&&decl&&new RegExp(",\\s*(?:"+index+"|"+item+")\\s*(?:=|;|,)","i").test(visible))return false;
    return check(n.body??[])&&check(n.otherwise??[]);
  });
  return check(node.body.slice(1))?{list,index,item}:undefined;
}
