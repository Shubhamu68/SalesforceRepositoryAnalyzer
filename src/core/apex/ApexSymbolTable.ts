import {maskApexSource,matchingPair,stripApexComments,splitApexTopLevel,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {canonicalApexType,parseApexDeclaration,selectApexOverload,type ApexArgumentTypes} from "./ApexTypeSystem.js";

interface Binding {name:string;type:string|undefined;start:number;end:number;depth:number}
interface ClassScope {name:string;start:number;end:number;fields:Map<string,string|undefined>}
export class ApexSymbolTable{
  private readonly scopes:ClassScope[]=[];
  private readonly locals=new Map<IndexedApexMethod,Binding[]>();
  constructor(private readonly source:string,private readonly methods:readonly IndexedApexMethod[]){
    const masked=maskApexSource(source);
    for(const hit of masked.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*[^{;]*\{/gi)){
      const open=hit.index!+hit[0].length-1,end=matchingPair(masked,open,"{","}");
      if(end<0)continue;
      const parent=this.scopes.filter(c=>c.start<open&&open<c.end).at(-1);
      const scope:ClassScope={name:parent?parent.name+"."+hit[1]:hit[1],start:open,end,fields:new Map()};
      this.scopes.push(scope);
      let depth=1,start=open+1;
      for(let i=open+1;i<end;i++){
        const c=masked[i];
        if(c==="{"){
          if(depth===1){
            // A method or property header is not a simple field declaration.
            // Collection initializer braces are conservatively omitted.
          }
          depth++;
        }else if(c==="}"){
          depth--;if(depth===1)start=i+1;
        }else if(c===";"&&depth===1){
          const declaration=parseApexDeclaration(masked.slice(start,i+1).trim().replace(/^(?:(?:public|private|protected|global|static|final|transient|testvisible)\s+)*/i,""));
          if(declaration){const key=declaration.name.toLowerCase();scope.fields.set(key,scope.fields.has(key)?undefined:declaration.type);}
          start=i+1;
        }
      }
    }
  }
  ownerAt(offset:number):string|undefined{return this.scopes.filter(c=>c.start<offset&&offset<c.end).at(-1)?.name;}
  sameOwner(a:IndexedApexMethod,b:IndexedApexMethod):boolean{const owner=this.ownerAt(a.start);return owner!==undefined&&owner===this.ownerAt(b.start);}
  private bindings(method:IndexedApexMethod):Binding[]{
    const old=this.locals.get(method);if(old)return old;
    const result:Binding[]=[];
    method.parameters.forEach((name,i)=>{const type=canonicalApexType(method.parameterTypes?.[i]);result.push({name:name.toLowerCase(),type,start:method.start,end:method.end,depth:0});});
    const visit=(nodes:readonly SourceNode[],end:number,depth:number)=>{
      for(const node of nodes){
        if(node.kind==="statement"){
          const decl=parseApexDeclaration(maskApexSource(node.text??""));
          if(decl)result.push({name:decl.name.toLowerCase(),type:decl.type,start:node.end,end,depth});
        }
        if(node.kind==="for"&&node.loopVariable){
          result.push({name:node.loopVariable.toLowerCase(),type:canonicalApexType(node.loopVariableType),start:node.body?.[0]?.start??node.start,end:node.end,depth:depth+1});
        }
        for(const children of [node.body,node.otherwise]){
          if(children?.length)visit(children,children.at(-1)!.end,depth+1);
        }
      }
    };visit(method.body,method.end,1);this.locals.set(method,result);return result;
  }
  /** A visible local or parameter shadows a class member even when its
   * type or reaching value cannot be established. */
  hasLocalBinding(method:IndexedApexMethod|undefined,name:string,offset:number):boolean{
    const key=name.toLowerCase();
    return !!method&&this.bindings(method).some(b=>b.name===key&&b.start<=offset&&offset<b.end);
  }
  lookup(method:IndexedApexMethod|undefined,name:string,offset:number):string|undefined{
    if(!method)return undefined;
    const key=name.toLowerCase();
    const visible=this.bindings(method).filter(b=>b.name===key&&b.start<=offset&&offset<b.end).sort((a,b)=>b.depth-a.depth);
    if(visible.length)return visible.length>1&&visible[0].depth===visible[1].depth?undefined:visible[0].type;
    const scope=this.scopes.filter(c=>c.start<method.start&&method.start<c.end).at(-1);
    return scope?.fields.get(key.replace(/^this\./,""));
  }
  argumentTypes(method:IndexedApexMethod|undefined,expressions:readonly string[],offset:number):ApexArgumentTypes{
    return expressions.map(expr=>this.expressionType(method,expr,offset));
  }
  expressionType(method:IndexedApexMethod|undefined,expression:string,offset:number,depth=0):string|undefined{
    if(depth>12)return undefined;
    const expr=stripApexComments(expression).trim();
    if(/^'(?:\\.|[^'\\])*'$/s.test(expr))return "string";
    if(/^(true|false)$/i.test(expr))return "boolean";
    if(/^null$/i.test(expr))return "null";
    if(/^[-+]?\d+[lL]$/.test(expr))return "long";
    if(/^[-+]?\d+$/.test(expr)){const n=Number(expr);return Number.isSafeInteger(n)&&n>=-2147483648&&n<=2147483647?"integer":undefined;}
    if(/^[-+]?\d+\.\d+$/.test(expr))return "decimal";
    if(/^[A-Za-z_]\w*$/.test(expr)||/^this\.[A-Za-z_]\w*$/i.test(expr))return this.lookup(method,expr,offset);
    const allocation=/^new\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*<[\w\s,.<>\[\]]+>)?(?:\s*\[\s*\])*)\s*[(\{]/i.exec(expr);
    if(allocation){
      const open=allocation[0].length-1;
      const delimiter=expr[open];
      const close=matchingPair(maskApexSource(expr),open,delimiter,delimiter==="(" ? ")" : "}");
      if(close===expr.length-1)return canonicalApexType(allocation[1]);
    }
    if(expr.startsWith("(")){
      const close=matchingPair(maskApexSource(expr),0);
      if(close===expr.length-1)return this.expressionType(method,expr.slice(1,-1),offset,depth+1);
      if(close>0&&close<expr.length-1){
        const cast=canonicalApexType(expr.slice(1,close));
        // A parenthesized variable followed by an arithmetic operator is
        // not a cast. Require a recognized type or a type token not bound
        // as a variable at this source offset.
        if(cast&&!this.lookup(method,expr.slice(1,close).trim(),offset)&&/^\s*(?:[A-Za-z_'(]|\d)/.test(expr.slice(close+1)))return cast;
      }
    }
    const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/.exec(expr);
    if(call&&matchingPair(maskApexSource(expr),expr.indexOf("("))===expr.length-1){
      const name=call[1].toLowerCase();
      const builtins:Record<string,string>={"string.valueof":"string","string.join":"string","string.escapesinglequotes":"string","string.isblank":"boolean","string.isnotblank":"boolean","integer.valueof":"integer","long.valueof":"long","decimal.valueof":"decimal"};
      if(builtins[name])return builtins[name];
      if(method&&!name.includes(".")){
        const pieces=call[2].trim()?splitApexTopLevel(call[2],","):[];
        const candidate=selectApexOverload(this.methods.filter(m=>m.name.toLowerCase()===name&&this.sameOwner(method,m)),pieces.length,pieces.map(p=>this.expressionType(method,p,offset,depth+1)));
        return canonicalApexType(candidate?.returnType);
      }
    }
    return undefined;
  }
}
const cache=new WeakMap<readonly IndexedApexMethod[],ApexSymbolTable>();
export function apexSymbols(source:string,methods:readonly IndexedApexMethod[]):ApexSymbolTable{
  if(!Object.isFrozen(methods))return new ApexSymbolTable(source,methods);
  let table=cache.get(methods);if(!table){table=new ApexSymbolTable(source,methods);cache.set(methods,table);}return table;
}
