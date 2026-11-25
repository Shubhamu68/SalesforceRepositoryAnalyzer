import {maskApexSource,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {canonicalApexType,parseApexDeclaration} from "./ApexTypeSystem.js";
import type {ApexValue} from "./ApexValueEvaluator.js";
import {referenceMember} from "./ApexReferenceState.js";

/** Narrow effect proof for direct instance/collection member mutations.
 * Input instances have already passed source-backed construction. No custom
 * accessor, method dispatch, allocation, escape or external property lookup
 * is allowed by this proof. Unsupported code uses the ordinary unknown path. */
export function proveInstanceArgumentEffects(method:IndexedApexMethod,args:readonly ApexValue[]):boolean{
  if(!method.isStatic||method.visibility!=="private"||!args.some(v=>v.kind==="instance"))return false;
  const inputs=new Map(method.parameters.map((p,i)=>[p.toLowerCase(),args[i]]));
  const locals=new Set(method.parameters.map(p=>p.toLowerCase()));
  // Only scalar locals are supported; reference local aliases cannot expand
  // the proof beyond the supplied argument graph.
  const scalar=/^(?:string|boolean|integer|long|decimal|double|id)$/;
  for(let i=0;i<args.length;i++){
    const value=args[i],declared=canonicalApexType(method.parameterTypes?.[i]);
    if(value.kind==="instance"){
      const actual=canonicalApexType(value.className);
      if(!declared||!(actual===declared||actual?.endsWith("."+declared)))return false;
    }else if(!declared||!scalar.test(declared))return false;
  }
  const expression=(source:string,allowWrite=false):boolean=>{
    let visible=maskApexSource(source);
    if(/\b(?:new|insert|update|upsert|delete|undelete|merge|throw|this|super|try|switch|while|do)\b/i.test(visible)||/[\[\]{}]|\+\+|--|\b(?:null)\b\s*\./.test(visible))return false;
    // Only known String built-ins; no call through an application receiver.
    if(/\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*\(/.test(visible))return false;
    // Validate each qualified read and replace it with a neutral token before
    // checking ordinary identifiers. Unknown field values are permitted, but
    // the path itself must identify a member on the supplied modeled object.
    for(const hit of visible.matchAll(/\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+/g)){
      const path=hit[0].replace(/\s+/g,""),parts=path.split(".");
      const parent=referenceMember(inputs,parts.slice(0,-1).join("."));
      if(parent?.kind!=="instance"||!parent.entries.some(([k])=>k.toLowerCase()===parts.at(-1)!.toLowerCase()))return false;
    }
    visible=visible.replace(/\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+/g," true ");
    for(const token of visible.matchAll(/\b[A-Za-z_]\w*\b/g)){
      if(!locals.has(token[0].toLowerCase())&&!/^(?:true|false|null)$/i.test(token[0]))return false;
    }
    return !/[;]|\+=|(?:^|[^=!<>])=(?!=|>)/.test(visible)||allowWrite;
  };
  const visit=(nodes:readonly SourceNode[],depth=0):boolean=>{
    if(depth>8)return false;
    for(const node of nodes){
      if(node.kind==="block"){if(!visit(node.body??[],depth+1))return false;continue;}
      if(node.kind==="if"){
        if(!expression(node.condition??"")||!visit(node.body??[],depth+1)||!visit(node.otherwise??[],depth+1))return false;
        continue;
      }
      if(node.kind!=="statement")return false;
      const source=(node.text??"").trim().replace(/;\s*$/,"");
      if(/^return\s*$/i.test(source))continue;
      if(/^return\s+/i.test(source)){if(!expression(source.replace(/^return\s+/i,"")))return false;continue;}
      const declaration=parseApexDeclaration(maskApexSource(source));
      if(declaration){
        if(!scalar.test(declaration.type)||locals.has(declaration.name.toLowerCase()))return false;
        const eq=maskApexSource(source).indexOf("=");
        if(eq>=0&&!expression(source.slice(eq+1)))return false;
        locals.add(declaration.name.toLowerCase());continue;
      }
      const assignment=/^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)\s*(\+?=)(?!=|>)\s*([\s\S]+)$/.exec(source);
      if(assignment){
        const path=assignment[1].replace(/\s+/g,"");
        const parent=referenceMember(inputs,path.split(".").slice(0,-1).join("."));
        if(parent?.kind!=="instance"||!expression(path)||!expression(assignment[3]))return false;
        // Only scalar leaf writes. No reference reassignment may invalidate
        // the proof used for subsequent qualified paths.
        const before=referenceMember(inputs,path);
        if(!before||!["text","number","null"].includes(before.kind))return false;
        if([...inputs].some(([name,value])=>value.kind==="instance"&&new RegExp("\\b"+name+"\\b","i").test(maskApexSource(assignment[3]))&&!new RegExp("\\b"+name+"\\s*\\.","i").test(maskApexSource(assignment[3]))))return false;
        continue;
      }
      const mutate=/^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)\s*\.\s*(add|clear)\s*\(([\s\S]*)\)$/i.exec(source);
      if(mutate){
        const value=referenceMember(inputs,mutate[1].replace(/\s+/g,""));
        if(value?.kind!=="collection"||!expression(mutate[3]))return false;
        if(mutate[2].toLowerCase()==="clear"&&mutate[3].trim())return false;
        continue;
      }
      return false;
    }
    return true;
  };
  return visit(method.body);
}
