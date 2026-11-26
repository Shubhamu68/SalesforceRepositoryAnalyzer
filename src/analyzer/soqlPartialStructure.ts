import type {ApexValue} from "../core/apex/ApexValueEvaluator.js";
import {proveApexPartialStructure,type ApexPartialStructure} from "../core/apex/ApexPartialStructure.js";

/** Typed scalar value slots, never structural slots.
 * Never assume that runtime String values, field lists, object names, sort
 * expressions, quoted fragments or arbitrary predicates are safe. */
export function provePartialSoql(value:ApexValue,allowIntendedMemberValues=false):ApexPartialStructure|undefined{
  return proveApexPartialStructure(value,(prefix,hole,suffix)=>{
    const type=hole.symbol?.type?.toLowerCase();
    // Source-declared String data members can supply intended predicate
    // values, but raw text is not injection-safe. Opt-in consumers must
    // retain an advisory with unknown effective enforcement.
    if(!type||!["id","integer","long","decimal","double","boolean","date","datetime","soql-id-list"].includes(type)&&!(allowIntendedMemberValues&&type==="soql-member-string"))return undefined;
    const quotedValue=type==="id"||type==="soql-id-list"||type==="soql-member-string";
    // Require a complete token boundary after the numeric value; a hole
    // within an identifier, a quoted value or punctuation is not a proof.
    const boundary=/^(?:\s*$|\s+(?:AND\b|OR\b|GROUP\s+BY\b|ORDER\s+BY\b|LIMIT\b|OFFSET\b|WITH\b|HAVING\b|FOR\b)|\s*\))/i;
    if(quotedValue?suffix[0]!=="\x27"||!boundary.test(suffix.slice(1)):!boundary.test(suffix))return undefined;
    let visible="",quoted=false,openingQuote=-1;
    for(let i=0;i<prefix.length;i++){
      const ch=prefix[i];
      if(quoted&&ch==="\\"){i++;visible+="  ";continue;}
      if(ch==="'"){quoted=!quoted;if(quoted)openingQuote=i;visible+=" ";continue;}
      if(!quoted&&((ch==="/"&&["/","*"].includes(prefix[i+1]))||(ch==="-"&&prefix[i+1]==="-")))return undefined;
      visible+=quoted?" ":ch;
    }
    if(!/^SELECT\b/i.test(visible.trim()))return undefined;
    if(type==="soql-id-list"){
      // A typed List/Set<Id> joined with the exact quote/comma delimiter
      // fills only the entire quoted IN list; never an identifier.
      return quoted&&openingQuote===prefix.length-1&&/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+(?:NOT\s+)?IN\s*\(\s*$/i.test(visible)&&/^\x27\s*\)/.test(suffix)?"000000000000000":undefined;
    }
    if(type==="id"||type==="soql-member-string"){
      // Hole must occupy the entire literal. Id is an Apex source type,
      // not a String that happens to resemble a Salesforce Id.
      if(!quoted||openingQuote!==prefix.length-1||!/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|=)\s*$/i.test(visible))return undefined;
      return type==="id"?"000000000000000":"analyzerValue";
    }
    if(quoted)return undefined;
    // Require that a literal space separates a numeric slot from a LIMIT
    // or OFFSET keyword. For simple predicates, the parser must separately
    // establish the field and complete expression.
    const integer=type==="integer"||type==="long";
    if(integer&&/\bLIMIT\s+$/i.test(visible))return "1";
    if(integer&&/\bOFFSET\s+$/i.test(visible))return "0";
    if(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:!=|<=|>=|=|<|>)\s*$/i.test(visible))
      return type==="date"?"2000-01-01":type==="datetime"?"2000-01-01T00:00:00Z":type==="boolean"?"true":"0";
    return undefined;
  });
}
