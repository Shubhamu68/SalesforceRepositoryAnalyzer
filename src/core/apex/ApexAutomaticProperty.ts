/** Shared storage-only property grammar. Callers pass masked source at
 * class-member boundaries. No executable or restricted accessors. */
const declaration="(?:@\\w+\\s*)?(?:public|private|global)\\s+(String|Boolean|Integer|Long|Decimal|Double|Id)\\s+([A-Za-z_]\\w*)\\s*\\{\\s*get\\s*;\\s*set\\s*;\\s*\\}";
export interface ApexAutomaticScalarProperty {type:string;name:string}
export function readApexAutomaticScalarProperty(header:string,body:string):ApexAutomaticScalarProperty|undefined{
  const match=new RegExp("^\\s*"+declaration+"\\s*$","i").exec(header+"{"+body+"}");
  return match?{type:match[1],name:match[2]}:undefined;
}
export function stripApexAutomaticScalarProperties(body:string,accept:(property:ApexAutomaticScalarProperty)=>void):string{
  return body.replace(new RegExp(declaration,"gi"),(_all,type:string,name:string)=>{
    accept({type,name});return "";
  });
}
