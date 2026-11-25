/** Shared source interpretation of explicit Database AccessLevel tokens and
 * the existing API-version default. Feature-specific enforcement (including
 * SOQL SECURITY_ENFORCED and DML operation/record semantics) stays outside. */
export type ApexDatabaseAccessMode="USER_MODE"|"SYSTEM_MODE";
export function parseApexAccessLevel(expression?:string):ApexDatabaseAccessMode|undefined|null{
  if(!expression)return undefined;
  const mode=/^AccessLevel\.(USER_MODE|SYSTEM_MODE)$/i.exec(expression.trim());
  return mode?mode[1].toUpperCase() as ApexDatabaseAccessMode:null;
}
export function defaultApexDatabaseAccessMode(apiVersion?:number):ApexDatabaseAccessMode|undefined{
  if(apiVersion===undefined||!Number.isFinite(apiVersion)||apiVersion<=0)return undefined;
  return apiVersion>=67?"USER_MODE":"SYSTEM_MODE";
}
