import {stripApexComments,type SourceNode} from "./ApexSourceModel.js";
const identifier=/^[a-z_]\w*$/;
export const reservedApexContractNames=new Set(["string","schema","json","list","set","map","integer","boolean","object","null","true","false","return","continue","for","if","new","this","super"]);
export function apexContractTokens(source:string):string[]|undefined{
  const input=stripApexComments(source),result:string[]=[];let end=0;
  for(const hit of input.matchAll(/'(?:\\.|[^'\\])*'|\$[A-Za-z_]\w*|[A-Za-z_]\w*|\d+|==|!=|\+\+|--|<=|>=|&&|\|\||[{}()[\].,:;=<>?+!*/-]/g)){
    if(input.slice(end,hit.index).trim())return undefined;
    result.push(hit[0].startsWith("'")?hit[0]:hit[0].toLowerCase());
    end=hit.index!+hit[0].length;
  }
  return input.slice(end).trim()?undefined:result;
}
/** Whole-body token contracts, alpha-renamed and fail-closed. Refuse
 * collisions rather than attempting arbitrary lexical substitution. */
export function matchApexTokenContract(source:string,template:string,initial:Record<string,string>={}):Map<string,string>|undefined{
  const actual=apexContractTokens(source),expected=apexContractTokens(template);
  if(!actual||!expected||actual.length!==expected.length)return undefined;
  const bindings=new Map(Object.entries(initial).map(([k,v])=>[k,v.toLowerCase()]));
  if(new Set(bindings.values()).size!==bindings.size||[...bindings.values()].some(v=>!identifier.test(v)||reservedApexContractNames.has(v)))return undefined;
  for(let i=0;i<expected.length;i++){
    const want=expected[i],got=actual[i];
    if(!want.startsWith("$")){if(want!==got)return undefined;continue;}
    const prior=bindings.get(want);
    if(prior!==undefined){if(prior!==got)return undefined;continue;}
    if(want==="$number"){if(!/^(?:0|[1-9]\d{0,3})$/.test(got))return undefined;}
    else if(!identifier.test(got)||reservedApexContractNames.has(got))return undefined;
    if([...bindings.values()].includes(got))return undefined;
    bindings.set(want,got);
  }
  return bindings;
}
export function apexPrefixBefore(nodes:readonly SourceNode[],at:number):SourceNode[]|undefined{
  const result:SourceNode[]=[];
  for(const n of nodes){
    if(n.end<=at){result.push(n);continue;}
    if(n.start>=at)return result;
    if(n.kind==="statement")return result;
    if(n.kind!=="block"&&n.kind!=="if")return undefined;
    for(const branch of [n.body??[],n.otherwise??[]]){
      if(branch.some(x=>x.start<=at&&at<x.end)){
        const inner=apexPrefixBefore(branch,at);return inner?[...result,...inner]:undefined;
      }
    }
    return undefined;
  }
  return result;
}
