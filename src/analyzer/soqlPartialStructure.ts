import type {ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {proveApexPartialStructure,type ApexPartialStructure} from "../core/apex/ApexPartialStructure.js";

/** Only typed Integer/Long holes in complete numeric value positions.
 * Never assume that runtime String values, field lists, object names, sort
 * expressions, quoted fragments or arbitrary predicates are safe. */
export function provePartialSoql(value:ApexValue):ApexPartialStructure|undefined{
  return proveApexPartialStructure(value,(prefix,hole,suffix)=>{
    const type=hole.symbol?.type?.toLowerCase();
    if(type!=="id"&&type!=="integer"&&type!=="long")return undefined;
    // Require a complete token boundary after the numeric value; a hole
    // within an identifier, a quoted value or punctuation is not a proof.
    const boundary=/^(?:\s*$|\s+(?:AND\b|OR\b|GROUP\s+BY\b|ORDER\s+BY\b|LIMIT\b|OFFSET\b|WITH\b|HAVING\b|FOR\b)|\s*\))/i;
    if(type==="id"?suffix[0]!=="\x27"||!boundary.test(suffix.slice(1)):!boundary.test(suffix))return undefined;
    let visible="",quoted=false;
    for(let i=0;i<prefix.length;i++){
      const ch=prefix[i];
      if(quoted&&ch==="\\"){i++;visible+="  ";continue;}
      if(ch==="'"){quoted=!quoted;visible+=" ";continue;}
      if(!quoted&&((ch==="/"&&["/","*"].includes(prefix[i+1]))||(ch==="-"&&prefix[i+1]==="-")))return undefined;
      visible+=quoted?" ":ch;
    }
    if(!/^SELECT\b/i.test(visible.trim()))return undefined;
    if(type==="id"){
      // Hole must occupy the entire literal. Id is an Apex source type,
      // not a String that happens to resemble a Salesforce Id.
      if(!quoted||!prefix.endsWith("\x27")||!/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|=)\s*$/i.test(visible))return undefined;
      return "000000000000000";
    }
    if(quoted)return undefined;
    // Require that a literal space separates a numeric slot from a LIMIT
    // or OFFSET keyword. For simple predicates, the parser must separately
    // establish the field and complete expression.
    if(/\bLIMIT\s+$/i.test(visible))return "1";
    if(/\bOFFSET\s+$/i.test(visible))return "0";
    if(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|<=|>=|=|<|>)\s*$/i.test(visible))return "0";
    return undefined;
  });
}
