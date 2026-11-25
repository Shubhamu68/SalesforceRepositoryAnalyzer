import {maskApexSource,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {parseApexDeclaration} from "./ApexTypeSystem.js";
import type {ApexValue} from "./ApexValueEvaluator.js";
type Instance=Extract<ApexValue,{kind:"instance"}>;

/** Initial start() receiver is a submission snapshot, not a static singleton.
 * This proof covers local assignments, conditional exits and reads of modeled
 * fields/maps. No member writes, opaque control flow or arbitrary callbacks. */
export function supportsReceiverPrefix(method:IndexedApexMethod,offset:number,receiver:Instance):boolean{
  const fields=new Map(receiver.entries.map(([k,v])=>[k.toLowerCase(),v]));
  const locals=new Set(method.parameters.map(p=>p.toLowerCase()));
  const expression=(source:string):boolean=>{
    const masked=maskApexSource(source);
    if(/\b(?:new|throw|insert|update|delete|upsert|merge|super)\b/i.test(masked)||/\+\+|--|\+=|(?:^|[^=!<>])=(?!=|>)/.test(masked))return false;
    for(const hit of masked.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)){
      const path=hit[1].toLowerCase().replace(/^this\./,"");
      if(/^database\.(?:query|getquerylocator|countquery)$/i.test(path))continue;
      const [field,op,...rest]=path.split(".");
      if(rest.length||locals.has(field)||fields.get(field)?.kind!=="map"||!["get","containskey"].includes(op))return false;
    }
    return true;
  };
  const visit=(nodes:readonly SourceNode[],depth:number):boolean=>{
    if(depth>8)return false;
    for(const node of nodes){
      if(node.start>offset)break;
      if(node.kind==="block"){if(!visit(node.body??[],depth+1))return false;continue;}
      if(node.kind==="if"){
        if(node.condition==="__apex_exception_path_unknown__"||!expression(node.condition??""))return false;
        // Scope-local declarations inside conditionals cannot be used as
        // evidence outside their lexical lifetime.
        if(!visit(node.body??[],depth+1)||!visit(node.otherwise??[],depth+1))return false;
        continue;
      }
      if(node.kind!=="statement")return false;
      if(node.start<=offset&&offset<node.end){
        // A selected invocation must be the first evaluated call in this
        // statement; earlier effects in an argument list cannot be ignored.
        return /^\s*(?:return\s*)?$/.test(maskApexSource((node.text??"").slice(0,offset-node.start)));
      }
      const source=(node.text??"").trim().replace(/;\s*$/,"");
      if(/^return\b/i.test(source)){if(!expression(source.slice(6)))return false;continue;}
      const declaration=parseApexDeclaration(maskApexSource(source));
      if(declaration){
        if(depth!==0||locals.has(declaration.name.toLowerCase()))return false;
        const eq=maskApexSource(source).indexOf("=");
        if(eq>=0&&!expression(source.slice(eq+1)))return false;
        locals.add(declaration.name.toLowerCase());continue;
      }
      const assignment=/^([A-Za-z_]\w*)\s*=(?!=|>)\s*([\s\S]+)$/.exec(source);
      if(!assignment||!locals.has(assignment[1].toLowerCase())||!expression(assignment[2]))return false;
    }
    return true;
  };
  return visit(method.body,0);
}

/** A finite map-domain sample is conditional on a successful lookup, never
 * a proof of all runtime keys or an assertion that a particular job ran. */
export function receiverMapSamples(method:IndexedApexMethod,receiver:Instance,limit=32):{receivers:Instance[];sampled:boolean;bounded:boolean}{
  const fields=new Map(receiver.entries.map(([name,value])=>[name.toLowerCase(),value]));
  const text=method.body.map(n=>n.kind==="statement"?n.text??"":"").join("\n");
  const masked=maskApexSource(text);
  const matches=[...masked.matchAll(/\b(?:this\.)?([A-Za-z_]\w*)\.get\s*\(\s*(?:this\.)?([A-Za-z_]\w*)\s*\)/gi)]
    .filter(m=>fields.get(m[1].toLowerCase())?.kind==="map");
  const pairs=new Map(matches.map(m=>[m[1].toLowerCase()+"|"+m[2].toLowerCase(),m]));
  if(pairs.size!==1)return {receivers:[receiver],sampled:false,bounded:false};
  const match=[...pairs.values()][0],map=fields.get(match[1].toLowerCase()),key=fields.get(match[2].toLowerCase());
  if(map?.kind!=="map"||map.keyType!=="integer"||key?.kind!=="unknown"||key.symbol?.type!=="integer")
    return {receivers:[receiver],sampled:false,bounded:false};
  const keys=map.entries.map(([k])=>Number(k)).filter(k=>Number.isInteger(k)&&k>=-2147483648&&k<=2147483647);
  // Any ambiguous lexical shadow or write to the selector invalidates the
  // domain refinement. The receiver-prefix proof separately rejects effects.
  if(method.parameters.some(p=>p.toLowerCase()===match[2].toLowerCase()||p.toLowerCase()===match[1].toLowerCase()))return {receivers:[receiver],sampled:false,bounded:false};
  const shadowed=(nodes:readonly SourceNode[]):boolean=>nodes.some(n=>{
    const declaration=parseApexDeclaration(maskApexSource(n.text??""));
    return !!declaration&&[match[1].toLowerCase(),match[2].toLowerCase()].includes(declaration.name.toLowerCase())||
      !!n.loopVariable&&[match[1].toLowerCase(),match[2].toLowerCase()].includes(n.loopVariable.toLowerCase())||
      shadowed(n.body??[])||shadowed(n.otherwise??[]);
  });
  if(shadowed(method.body))return {receivers:[receiver],sampled:false,bounded:false};
  const samples=keys.slice(0,limit).map(k=>({...receiver,entries:receiver.entries.map(([name,value]):[string,ApexValue]=>[name,name.toLowerCase()===match[2].toLowerCase()?{kind:"number",value:k}:value])}));
  return {receivers:[receiver,...samples],sampled:samples.length>0,bounded:keys.length>limit};
}
