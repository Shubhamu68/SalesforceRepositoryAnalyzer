import {extractSoqlExpressionFields,type SoqlExpressionField} from "./soqlExpressionInventory.js";
import {parseNestedSoql} from "./nestedSoqlScopes.js";
import {classifySoqlMode,maskSoqlStringsAndComments,type DeclaredSoqlMode} from "./soqlExecutionMode.js";

export interface SoqlPermissionShape {
  object:string;
  mode:DeclaredSoqlMode;
  fields:SoqlExpressionField[];
  /** COUNT() requires object access, with no SELECT field. */
  countOnly?:boolean;
}
const fieldPath=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
/** FORMAT affects presentation, not the underlying field permission. This
 * narrow parser projection is intentionally not a generic function bypass. */
export function permissionSelectFieldPath(expression:string):string|undefined{
  const trimmed=expression.trim();
  if(fieldPath.test(trimmed))return trimmed;
  return /^FORMAT\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)$/i.exec(trimmed)?.[1];
}

/** A deliberately narrow aggregate projection. Aliases are syntactic
 * names, not Salesforce fields. Group/HAVING and nested scope rules are
 * unchanged; this accepts only a single field argument per function. */
export function permissionAggregateSelectFieldPath(expression:string):string|undefined{
  return /^(?:SUM|AVG|MIN|MAX|COUNT|COUNT_DISTINCT)\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)(?:\s+[A-Za-z_]\w*)?$/i.exec(expression.trim())?.[1];
}
/** Simple root scopes only; scalar aggregate fields are permitted, but
 * grouped expressions and nested scopes are not flattened. */
export function simplePermissionShape(text:string,line=1,onReject?:(code:string)=>void):SoqlPermissionShape|undefined{
  const reject=(code:string):undefined=>{onReject?.(code);return undefined;};
  const root=parseNestedSoql(text,line), inventory=extractSoqlExpressionFields(text);
  if(!root)return reject("ROOT_SCOPE_INVALID");
  if(root.subqueries.length)return reject("NESTED_SCOPE_UNSUPPORTED");
  if(!inventory.parsed)return reject("SOQL_PARSE_FAILED");
  if(inventory.limitations.length)return reject("FIELD_INVENTORY_LIMITATION");
  const countOnly=/^\s*SELECT\s+COUNT\s*\(\s*\)\s+FROM\b/i.test(text);
  if(!inventory.fields.length&&!countOnly)return reject("FIELD_INVENTORY_EMPTY");
  if(inventory.fields.some(f=>(f.functionName&&!(f.context==="SELECT"&&["FORMAT","SUM","AVG","MIN","MAX","COUNT","COUNT_DISTINCT"].includes(f.functionName.toUpperCase())))||!fieldPath.test(f.fieldPath)||
      !["SELECT","WHERE","ORDER_BY"].includes(f.context)))return reject("FIELD_CONTEXT_UNSUPPORTED");
  const visible=maskSoqlStringsAndComments(text);
  // Restrict to ordinary bare SELECT paths and a single unaliased root.
  const match=/^\s*SELECT\s+([\w\s.,()]+?)\s+FROM\s+([A-Za-z_]\w*)\b/i.exec(visible);
  if(!match||match[2].toLowerCase()!==root.fromName.toLowerCase()||
    (!countOnly&&match[1].split(",").some(f=>!permissionSelectFieldPath(f)&&!permissionAggregateSelectFieldPath(f))))return reject("SELECT_ROOT_SHAPE_UNSUPPORTED");
  const tail=visible.slice(match[0].length).trim();
  if(tail&&!/^(?:WHERE\b|WITH\b|ORDER\s+BY\b|LIMIT\b|OFFSET\b|FOR\b)/i.test(tail))return reject("ROOT_TAIL_UNSUPPORTED");
  if(/\b(?:GROUP\s+BY|HAVING|TYPEOF)\b/i.test(visible))return reject("GROUPED_SHAPE_UNSUPPORTED");
  return {object:root.fromName,mode:classifySoqlMode(text),fields:inventory.fields,...(countOnly?{countOnly:true}:{})};
}

/** One parser-only representative per root object and declared security mode.
 * Preserve clause usage (SECURITY_ENFORCED treats SELECT differently from
 * WHERE); never promote predicates to selected fields. No runtime query. */
export function aggregatePermissionShapes(shapes:readonly SoqlPermissionShape[],onReject?:(code:string)=>void):string[]{
  const groups=new Map<string,{object:string;mode:DeclaredSoqlMode;fields:Map<string,SoqlExpressionField>;countOnly?:boolean}>();
  for(const shape of shapes){
    const key=shape.object.toLowerCase()+"|"+shape.mode;
    const group=groups.get(key)??{object:shape.object,mode:shape.mode,fields:new Map<string,SoqlExpressionField>(),countOnly:false};
    if(shape.countOnly)group.countOnly=true;
    for(const field of shape.fields){
      const k=field.context+"|"+field.fieldPath.toLowerCase();
      if(!group.fields.has(k))group.fields.set(k,field);
    }
    groups.set(key,group);
  }
  const result:string[]=[];
  for(const group of groups.values()){
    const fields=[...group.fields.values()];
    const select=fields.filter(f=>f.context==="SELECT").map(f=>f.fieldPath);
    const where=fields.filter(f=>f.context==="WHERE").map(f=>f.fieldPath+" != null");
    const order=fields.filter(f=>f.context==="ORDER_BY").map(f=>f.fieldPath);
    if(!select.length&&!group.countOnly){onReject?.("AGGREGATE_NO_SELECT");continue;}
    const text="SELECT "+(select.length?select.join(", "):"COUNT()")+" FROM "+group.object+
      (where.length?" WHERE "+where.join(" AND "):"")+
      (group.mode==="UNSPECIFIED"?"":" WITH "+group.mode)+
      (order.length?" ORDER BY "+order.join(", "):"");
    const check=simplePermissionShape(text,1,onReject);
    if(!check){onReject?.("AGGREGATE_REPARSE_FAILED");continue;}
    const expected=new Set(fields.map(f=>f.context+"|"+f.fieldPath.toLowerCase()));
    const observed=new Set(check.fields.map(f=>f.context+"|"+f.fieldPath.toLowerCase()));
    if(check.object.toLowerCase()===group.object.toLowerCase()&&check.mode===group.mode&&
      expected.size===observed.size&&[...expected].every(k=>observed.has(k)))result.push(text);
    else onReject?.("AGGREGATE_INVENTORY_MISMATCH");
  }
  return result;
}
