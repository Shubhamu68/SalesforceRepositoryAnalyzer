import {maskApexSource,stripApexComments,splitApexTopLevel,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {apexSymbols} from "./ApexSymbolTable.js";
import {addApexValues,evaluateApexExpression,textValue,type ApexValue} from "./ApexValueEvaluator.js";
import {proveFixedIsoDateTimeValue} from "./ApexSourceValueProofs.js";
const clean=(s:string)=>stripApexComments(s).trim();
const literal=(s:string)=>/^'(?:\\.|[^'\\])*'$/s.test(clean(s))?evaluateApexExpression(clean(s),{values:new Map()}):undefined;
const word=(name:string)=>new RegExp("\\b"+name+"\\b","i");
const MAX_PARTS=64;
/** Evaluate straight-line String templates using correlated source caller
 * vectors. No execution sampling changes or interpretation of resulting text. */
export function evaluateApexCallerStringTemplate(source:string,owner:IndexedApexMethod,expression:string,prefix:readonly SourceNode[],offset:number,seeds:readonly ApexValue[][],methods:readonly IndexedApexMethod[]):ApexValue[]{
  if(!owner.parameters.length||seeds.length>64)return [];
  const symbols=apexSymbols(source,methods);
  if(symbols.lookup(owner,"String",offset)||/\bclass\s+String\b/i.test(maskApexSource(source)))return [];
  const parameters=new Map(owner.parameters.map((p,i)=>[p.toLowerCase(),i]));
  const pieces=splitApexTopLevel(clean(expression),"+");
  if(!pieces.length||pieces.length>MAX_PARTS)return [];
  const used=new Set<number>();
  const terms=pieces.map(piece=>{
    const expr=clean(piece);
    const value=literal(expr);
    if(value)return {value};
    const slot=proveFixedIsoDateTimeValue(source,owner,expr,methods);
    if(slot)return {value:slot};
    const i=parameters.get(expr.toLowerCase());
    if(i!==undefined){used.add(i);return {parameter:i};}
    const join=/^String\s*\.\s*join\s*\(\s*([A-Za-z_]\w*)\s*,\s*('(?:\\.|[^'\\])*')\s*\)$/i.exec(expr);
    const j=join?parameters.get(join[1].toLowerCase()):undefined;
    const separator=join?literal(join[2]):undefined;
    if(j===undefined||separator?.kind!=="text"||separator.values.length!==1)return undefined;
    used.add(j);return {parameter:j,separator:separator.values[0]};
  });
  if(!used.size||terms.some(t=>!t))return [];
  // Only unchanged parameters may be substituted. Reject loops/opaque
  // control flow and any prefix reference to relevant inputs, including
  // calls that might mutate a collection or reassign the parameter.
  if(prefix.some(n=>n.kind!=="statement"||[...used].some(i=>word(owner.parameters[i]).test(maskApexSource(source.slice(n.start,n.end))))))return [];
  const result:ApexValue[]=[];
  for(const seed of seeds){
    if(seed.length!==owner.parameters.length)continue;
    let value:ApexValue=textValue("");
    let valid=true;
    for(const term of terms){
      if(!term){valid=false;break;}
      if(term.value){value=addApexValues(value,term.value);continue;}
      if(term.parameter===undefined){valid=false;break;}
      const input=seed[term.parameter];
      if(term.separator!==undefined){
        if(input?.kind!=="collection"||input.items.length>2000){valid=false;break;}
        value=addApexValues(value,textValue(input.items.join(term.separator)));
      }else{
        if(!input||!["text","number","unknown"].includes(input.kind)||(input.kind==="text"&&input.values.length!==1)){valid=false;break;}
        value=addApexValues(value,input);
      }
    }
    if(!valid)continue;
    result.push(value);
  }
  return result;
}

