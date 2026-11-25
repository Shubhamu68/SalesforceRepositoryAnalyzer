import type {ApexTextFragment,ApexValue} from "./ApexValueEvaluator.js";
export interface ApexPartialStructure {
  readonly text:string;
  readonly holes:number;
}
/** Never mutate the Apex value or turn it into a complete text value.
 * A consumer supplies a grammar-specific proof of each hole. */
export function proveApexPartialStructure(value:ApexValue,prove:(prefix:string,hole:Extract<ApexTextFragment,{kind:"hole"}>,suffix:string)=>string|undefined):ApexPartialStructure|undefined{
  if(value.kind!=="unknown"||!value.fragments?.length||value.fragments.length>32)return undefined;
  let text="",holes=0;
  for(const [i,fragment] of value.fragments.entries()){
    if(fragment.kind==="literal")text+=fragment.text;
    else{
      const next=value.fragments[i+1];
      if(next?.kind==="hole")return undefined;
      const replacement=prove(text,fragment,next?.kind==="literal"?next.text:"");
      if(replacement===undefined)return undefined;
      text+=replacement;holes++;
    }
    if(text.length>16000)return undefined;
  }
  return holes?{text,holes}:undefined;
}
