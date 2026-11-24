/** Report the actual reconstructed structure, not an invented repair.
 * Mask quoted literal contents (including escaped quotes) before reporting
 * bounded excerpts. Preserve whitespace/positions and punctuation. */
export function describeMalformedSoql(query:string,reason:string):string{
  let inQuote=false,escaped=false;
  const masked=query.split("").map(ch=>{
    if(inQuote){
      if(escaped){escaped=false;return "*";}
      if(ch==="\\"){escaped=true;return "*";}
      if(ch==="'"){inQuote=false;return ch;}
      return "*";
    }
    if(ch==="'")inQuote=true;
    return ch;
  }).join("").replace(/[\r\n\t]/g," ");
  const position=/\bposition\s+(\d+)\b/i.exec(reason);
  const offset=position?Number(position[1]):undefined;
  const head=masked.slice(0,320);
  const excerpt=offset!==undefined&&Number.isSafeInteger(offset)&&offset>=0&&offset<masked.length&&offset>=head.length
    ?" Near reported position "+offset+": "+masked.slice(Math.max(0,offset-90),offset+90):"";
  return " Reconstructed query structure (quoted literals masked, "+query.length+
    " characters): "+head+(masked.length>head.length?" ...":"")+excerpt;
}
