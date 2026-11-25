import {maskApexSource,matchingPair,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {evaluateApexExpression,unknown,type ApexValue} from "./ApexValueEvaluator.js";

interface ScalarMember {name:string;key:string;initial:ApexValue}
const safeCall=/^(?:String\.(?:join|valueOf|isBlank|isNotBlank|isEmpty|escapeSingleQuotes)|Math\.(?:min|max)|System\.debug)$/i;
const safeMember=/^(?:add|addAll|clear|put|putAll|remove|contains|containsKey|isEmpty|size|get|keySet|trim|length|substring|endsWith|startsWith|toLowerCase|toUpperCase|getFieldPath)$/i;

/** Syntax-only class model. Mutable declarations are never installed in the
 * repository constant cache. The normal incoming member state remains unknown. */
export class ApexMemberEffectModel{
  readonly fields=new Map<string,ScalarMember>();
  private readonly localNames=new Map<IndexedApexMethod,Set<string>>();
  private readonly safe=new Map<IndexedApexMethod,boolean>();
  private readonly masked:string;
  readonly owner:string|undefined;
  private freshEligible=false;
  constructor(private readonly source:string,private readonly methods:readonly IndexedApexMethod[]){
    this.masked=maskApexSource(source);
    const cls=/\bclass\s+([A-Za-z_]\w*)\b/i.exec(this.masked);
    this.owner=cls?.[1];
    if(!cls)return;
    const open=this.masked.indexOf("{",cls.index+cls[0].length);
    const close=matchingPair(this.masked,open,"{","}");
    if(open<0||close<0)return;
    let depth=0;const top=new Int16Array(close-open);
    for(let i=open;i<close;i++){top[i-open]=depth;if(this.masked[i]==="{")depth++;else if(this.masked[i]==="}")depth--;}
    const declarations=/\b((?:(?:private|public|protected|global|static|final|transient)\s+)+)(String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(=|;)/gi;
    const starts=new Set<number>();
    for(const hit of this.masked.matchAll(declarations)){
      if(top[hit.index!-open]!==1)continue;
      const modifiers=hit[1].toLowerCase().trim().split(/\s+/);
      if(!modifiers.includes("static")||!modifiers.includes("private")||modifiers.includes("final"))continue;
      const end=hit[4]==="="?this.masked.indexOf(";",hit.index!+hit[0].length):hit.index!+hit[0].length-1;
      if(end<0||top[end-open]!==1)continue;
      const expression=source.slice(hit.index!+hit[0].length,end).trim();
      const initial=hit[4]===";"?{kind:"null"} as ApexValue:evaluateApexExpression(expression,{values:new Map()});
      if(!["text","number","null"].includes(initial.kind))continue;
      const name=hit[3].toLowerCase();
      if(this.fields.has(name)){this.fields.clear();return;}
      this.fields.set(name,{name,key:(this.owner+"."+name).toLowerCase(),initial});
      starts.add(hit.index!);
    }
    // Fresh entry is opt-in and only for classes without other executable
    // static initialization, inheritance, or static blocks. The method may
    // also be called from Apex; that independent context stays unknown.
    this.freshEligible=!/\b(?:extends|implements)\b/i.test(this.masked.slice(cls.index,open));
    for(const hit of this.masked.matchAll(/\bstatic\b/gi)){
      if(top[hit.index!-open]!==1)continue;
      const tail=this.masked.slice(hit.index!+hit[0].length);
      if(/^\s*\{/.test(tail)){this.freshEligible=false;break;}
      const end=this.masked.indexOf(";",hit.index!);
      const brace=this.masked.indexOf("{",hit.index!);
      // A method signature precedes its body. Every other top-level static
      // declaration must be one of our exact, literal scalar members.
      if(brace>=0&&(end<0||brace<end)&&/\([^;{}]*\)\s*$/.test(this.masked.slice(hit.index!,brace)))continue;
      const field=[...starts].some(start=>start<=hit.index!&&hit.index!-start<100&&
        !/[;{}]/.test(this.masked.slice(start,hit.index!)));
      if(!field){this.freshEligible=false;break;}
    }
    // Only track declarations that are visibly assigned somewhere in a
    // method. Immutable snapshots keep their existing repository semantics.
    for(const [name,field] of this.fields){
      const writes=this.methods.some(method=>{
        const body=this.masked.slice(method.start,method.end);
        return new RegExp("\\b(?:"+this.owner+"\\s*\\.\\s*)?"+name+"\\s*(?:=(?!=|>)|[+\\-*/%&|^]=|\\+\\+|--)","i").test(body);
      });
      if(!writes)this.fields.delete(name);
    }
  }
  locals(method:IndexedApexMethod):Set<string>{
    const cached=this.localNames.get(method);if(cached)return cached;
    const names=new Set(method.parameters.map(p=>p.toLowerCase()));
    const visit=(nodes:readonly SourceNode[])=>{for(const node of nodes){
      if(node.loopVariable)names.add(node.loopVariable.toLowerCase());
      if(node.kind==="statement"){
        const match=/^\s*(?:final\s+)?[\w.]+(?:\s*<[\w\s,.<>]+>)?(?:\[\])?\s+([A-Za-z_]\w*)\s*(?:=|;)/i.exec(maskApexSource(node.text??""));
        if(match)names.add(match[1].toLowerCase());
      }
      visit(node.body??[]);visit(node.otherwise??[]);
    }};visit(method.body);this.localNames.set(method,names);return names;
  }
  key(method:IndexedApexMethod|undefined,name:string):string|undefined{
    if(!method)return undefined;
    const n=name.toLowerCase(),dot=n.indexOf(".");
    if(dot>=0)return n.slice(0,dot)===this.owner?.toLowerCase()?this.fields.get(n.slice(dot+1))?.key:undefined;
    return this.locals(method).has(n)?undefined:this.fields.get(n)?.key;
  }
  freshEntry(method:IndexedApexMethod):Map<string,ApexValue>|undefined{
    if(!this.freshEligible||!this.fields.size||!method.isStatic||method.visibility!=="public")return undefined;
    const prefix=this.masked.slice(Math.max(0,method.start-400),method.start);
    const head=prefix.slice(Math.max(prefix.lastIndexOf("}"),prefix.lastIndexOf(";"))+1);
    if(!/@AuraEnabled(?:\s*\([^)]*\))?\s+(?:public\s+static|static\s+public)\s+[\w.<>,\s[\]]+\s*\([^{};]*\)\s*\{\s*$/i.test(head))return undefined;
    return new Map([...this.fields.values()].map(field=>[field.key,field.initial]));
  }
  private readonly receiverTypes=new Map<IndexedApexMethod,Map<string,string>>();
  private types(method:IndexedApexMethod):Map<string,string>{
    const cached=this.receiverTypes.get(method);if(cached)return cached;
    const types=new Map<string,string>();
    method.parameters.forEach((name,i)=>types.set(name.toLowerCase(),method.parameterTypes?.[i]??""));
    const collect=(nodes:readonly SourceNode[])=>{for(const node of nodes){
      const head=node.kind==="for"?node.text??"":node.text??"";
      const declaration=/^\s*(?:final\s+)?([\w.]+(?:\s*<[\w\s,.<>]+>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*(?:=|;|:)/i.exec(maskApexSource(head));
      if(declaration){
        const key=declaration[2].toLowerCase();
        if(types.has(key))types.set(key,"");else types.set(key,declaration[1]);
      }
      collect(node.body??[]);collect(node.otherwise??[]);
    }};collect(method.body);
    this.receiverTypes.set(method,types);return types;
  }
  /** No generic method-name purity assumption for application receivers. */
  readOnlyCall(method:IndexedApexMethod|undefined,name:string):boolean{
    if(safeCall.test(name)||/^(?:String\.isEmpty|JSON\.deserializeUntyped|Database\.(?:query|queryWithBinds|countQuery|countQueryWithBinds|getQueryLocator|getQueryLocatorWithBinds))$/i.test(name))return true;
    if(/^Schema\.SObjectType\.[A-Za-z_]\w*\.fieldSets\.getMap$/i.test(name))return true;
    if(!method)return false;
    const dot=name.lastIndexOf(".");
    if(dot<0)return false;
    const receiver=name.slice(0,dot).toLowerCase(),operation=name.slice(dot+1);
    const type=this.types(method).get(receiver)??"";
    if(/^(?:List|Set)\s*<\s*String\s*>$|^Map\s*<\s*String\s*,\s*String\s*>$/i.test(type))
      return /^(?:get|contains|containsKey|isEmpty|size|keySet)$/i.test(operation);
    if(/^String$/i.test(type))return /^(?:trim|length|substring|endsWith|startsWith|contains|split|isEmpty|toLowerCase|toUpperCase)$/i.test(operation);
    return /^Schema\.FieldSetMember$/i.test(type)&&/^getFieldPath$/i.test(operation);
  }
  /** Strict replay subset: only local scalars/collections, direct member
   * writes and proven built-ins. Unsupported dispatch/callbacks fail closed. */
  replaySafe(method:IndexedApexMethod):boolean{
    const old=this.safe.get(method);if(old!==undefined)return old;
    this.safe.set(method,false);
    if(!method.isStatic||method.visibility!=="private")return false;
    const types=this.types(method);
    const check=(source:string):boolean=>{
      const visible=maskApexSource(source);
      if(/\b(?:insert|update|upsert|delete|undelete|merge|throw|switch|try|while|do|new)\b/i.test(visible))return false;
      if(/\+\+|--|\[[^\]]*\]\s*(?:=|\+=)|(?:[-*/%&|^]=)/.test(visible))return false;
      const write=/^\s*(?:[\w.]+(?:\s*<[\w\s,.<>]+>)?\s+)?((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s*(?:=(?!=|>)|\+=|[-*/%&|^]=|\+\+|--)/i.exec(visible);
      if(write&&!this.key(method,write[1].replace(/\s/g,""))&&!types.has(write[1].toLowerCase()))return false;
      for(const hit of visible.matchAll(/\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)){
        const name=hit[1].replace(/\s+/g,"");
        if(safeCall.test(name))continue;
        const dot=name.lastIndexOf(".");
        if(dot>0&&safeMember.test(name.slice(dot+1))){
          const type=types.get(name.slice(0,dot).toLowerCase())??"";
          if(/^(?:String|List\s*<\s*String\s*>|Set\s*<\s*String\s*>|Map\s*<\s*String\s*,\s*String\s*>|Schema\.FieldSetMember)$/i.test(type)){
            if(/^(?:add|addAll|clear|put|putAll|remove)$/i.test(name.slice(dot+1))&&directEffectCall(source.trim().replace(/;$/,""))!==name.toLowerCase())return false;
            continue;
          }
        }
        // Allow a uniquely resolved nested local private static helper.
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===name.toLowerCase());
        if(candidates.length===1&&directEffectCall(source.trim().replace(/;$/,""))===name.toLowerCase()&&this.replaySafe(candidates[0]))continue;
        return false;
      }
      return true;
    };
    const visit=(nodes:readonly SourceNode[]):boolean=>nodes.every(node=>
      node.kind!=="opaque"&&!(node.kind==="for"&&!node.loopVariable)&&
      node.condition!=="__apex_exception_path_unknown__"&&
      !(node.kind==="statement"&&!/^\s*(?:return\b|break\s*;|continue\s*;|(?:[\w.]+(?:\s*<[\w\s,.<>]+>)?\s+)?[\w.]+\s*(?:=(?!=|>)|\+=|;)|[\w.]+\s*\()/i.test(maskApexSource(node.text??"")))&&
      check(node.text??"")&&check(node.condition??"")&&check(node.iterable??"")&&
      visit(node.body??[])&&visit(node.otherwise??[]));
    const result=visit(method.body);
    this.safe.set(method,result);return result;
  }
  unknownMembers(values:Map<string,ApexValue>,reason:string):void{
    for(const {key} of this.fields.values())if(values.has(key))values.set(key,unknown(reason));
  }
}
const cache=new WeakMap<readonly IndexedApexMethod[],ApexMemberEffectModel>();
export function memberEffectModel(source:string,methods:readonly IndexedApexMethod[]):ApexMemberEffectModel{
  if(!Object.isFrozen(methods))return new ApexMemberEffectModel(source,methods);
  const old=cache.get(methods);if(old)return old;
  const model=new ApexMemberEffectModel(source,methods);cache.set(methods,model);return model;
}

/** A single top-level call whose arguments contain no invocations. Effects
 * cannot be replayed inside an arbitrary expression or speculative branch. */
export function directEffectCall(source:string):string|undefined{
  const visible=maskApexSource(source).trim();
  const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(visible);
  if(!call)return undefined;
  const open=visible.indexOf("(");
  if(matchingPair(visible,open)!==visible.length-1||/[()]/.test(visible.slice(open+1,-1)))return undefined;
  return call[1].toLowerCase();
}
