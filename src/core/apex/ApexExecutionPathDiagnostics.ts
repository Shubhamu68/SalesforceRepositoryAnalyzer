import {indexApexMethods, maskApexSource} from "./ApexSourceModel.js";

/**
 * Explain a recognized Database call that the bounded control-flow engine did
 * not reach. This function only creates diagnostics; it never resolves SOQL.
 */
export function explainUncapturedApexQuery(
  source:string,offset:number,argument:string,
):string {
  const owner=indexApexMethods(source)
    .filter(method=>method.start<=offset && offset<method.end)
    .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!owner)return "Database invocation is not inside a fully indexed Apex method; "+
    "unsupported method declaration or source structure.";
  const preceding=source.slice(owner.start,offset);
  const visible=maskApexSource(preceding);
  const symbols=new Set<string>();
  const exprVisible=maskApexSource(argument);
  for(const match of exprVisible.matchAll(/\b[A-Za-z_]\w*\b/g)){
    const index=match.index??0;
    if(index>0 && exprVisible[index-1]===".")continue;
    if(/^(?:Database|String|AccessLevel|SELECT|FROM|WITH|USER_MODE|SYSTEM_MODE)$/i.test(match[0]))continue;
    symbols.add(match[0]);
  }
  const loops=[...visible.matchAll(/\b(?:for|while|do)\s*(?:\(|\{)/g)];
  const candidates:string[]=[];
  for(const symbol of symbols){
    const escaped=symbol.replace(/[.*+?^$()|[\]{}\\]/g,"\\$&");
    const written=new RegExp("\\b"+escaped+
      "\\s*(?:(?:\\+?=(?!=))|\\.(?:add|addAll|clear|put|remove)\\s*\\()","g");
    for(const loop of loops){
      if(written.test(visible.slice((loop.index??0)+loop[0].length))){
        candidates.push(symbol);
        break;
      }
      written.lastIndex=0;
    }
  }
  if(candidates.length)
    return "Database invocation in method "+owner.name+
      " was not reached by bounded symbolic execution; preceding loop(s) "+
      "may change query dependencies ("+[...new Set(candidates)].slice(0,8).join(", ")+
      "). Runtime iteration and path conditions require verification.";
  if(loops.length)
    return "Database invocation in method "+owner.name+
      " was not reached by bounded symbolic execution; preceding loop/control flow "+
      "may affect query construction. No complete execution path was established.";
  return "Database invocation in method "+owner.name+
    " was not reached by bounded symbolic execution; query expression/path "+
    "is unsupported or unreachable under the current source model.";
}
