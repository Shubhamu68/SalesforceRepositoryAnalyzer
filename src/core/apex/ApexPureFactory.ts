import {maskApexSource,matchingPair,splitApexTopLevel,type IndexedApexMethod} from "./ApexSourceModel.js";

/** A source proof for a narrow factory, not a general purity annotation.
 * All map mutations target a freshly allocated local, and all entry values
 * are literals or direct source-backed constructors with literal inputs.
 * Test.isRunningTest() is allowed only in a literal ternary, never guessed. */
export function isLiteralMapFactory(method:IndexedApexMethod):boolean{
  if(!method.isStatic||method.parameters.length!==0||!/^Map\s*</i.test(method.returnType??""))return false;
  const statements=method.body;
  if(statements.length<2||statements.length>40||statements.some(n=>n.kind!=="statement"))return false;
  const first=(statements[0].text??"").trim();
  const declaration=/^Map\s*<\s*(Integer|String)\s*,\s*[\w.]+\s*>\s+([A-Za-z_]\w*)\s*=\s*(new\s+Map\s*<[\w\s,.<>]+>\s*\{[\s\S]*\})\s*;$/i.exec(first);
  if(!declaration)return false;
  const name=declaration[2];
  const scalar=(value:string):boolean=>/^(?:'(?:\\.|[^'\\])*'|-?\d+|true|false|null)$/i.test(value.trim())||
    /^Test\.isRunningTest\s*\(\s*\)\s*\?\s*'(?:\\.|[^'\\])*'\s*:\s*'(?:\\.|[^'\\])*'$/i.test(value.trim());
  const entry=(expression:string):boolean=>{
    if(scalar(expression))return true;
    const allocation=/^new\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/i.exec(expression.trim());
    if(!allocation)return false;
    const masked=maskApexSource(expression.trim());
    if(matchingPair(masked,masked.indexOf("("))!==masked.length-1)return false;
    return !allocation[2].trim()||splitApexTopLevel(allocation[2],",").every(scalar);
  };
  const start=declaration[3].indexOf("{");
  const contents=declaration[3].slice(start+1,-1);
  for(const item of splitApexTopLevel(contents,",")){
    if(!item.trim())continue;
    const pair=splitApexTopLevel(item,"=>");
    if(pair.length!==2||!scalar(pair[0])||!entry(pair[1]))return false;
  }
  for(const node of statements.slice(1,-1)){
    const put=new RegExp("^"+name+"\\s*\\.\\s*put\\s*\\(([\\s\\S]*)\\)\\s*;$","i").exec((node.text??"").trim());
    if(!put)return false;
    const args=splitApexTopLevel(put[1],",");
    if(args.length!==2||!scalar(args[0])||!entry(args[1]))return false;
  }
  return new RegExp("^return\\s+"+name+"\\s*;$","i").test((statements.at(-1)?.text??"").trim());
}
