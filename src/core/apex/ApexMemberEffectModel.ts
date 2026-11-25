import {maskApexSource,matchingPair,type IndexedApexMethod,type SourceNode} from "./ApexSourceModel.js";
import {evaluateApexExpression,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import {canonicalApexType} from "./ApexTypeSystem.js";
import {maskSchemaEffectReads} from "./ApexSchemaModel.js";

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
  private readonly outerMethods=new Set<string>();
  private methodIdentity(method:IndexedApexMethod):string{return method.start+"|"+method.end+"|"+method.name.toLowerCase();}
  private isOuter(method:IndexedApexMethod):boolean{return this.outerMethods.has(this.methodIdentity(method));}
  private readonly inertDtos=new Map<string,Set<string>>();
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
    for(const method of methods)if(top[method.start-1-open]===1)this.outerMethods.add(this.methodIdentity(method));
    this.indexInertDtos(open,close,top);
    const declarations=/\b((?:(?:private|public|protected|global|static|final|transient)\s+)+)(String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(=|;)/gi;
    const starts=new Set<number>();
    for(const hit of this.masked.matchAll(declarations)){
      if(top[hit.index!-open]!==1)continue;
      const modifiers=hit[1].toLowerCase().trim().split(/\s+/);
      if(!modifiers.includes("static")||!modifiers.includes("private")||modifiers.includes("final"))continue;
      const end=hit[4]==="="?this.masked.indexOf(";",hit.index!+hit[0].length):hit.index!+hit[0].length-1;
      if(end<0||top[end-open]!==1)continue;
      const expression=source.slice(hit.index!+hit[0].length,end).trim();
      if(hit[4]==="="&&!/^(?:'(?:\\.|[^'\\])*'|true|false|null|-?\d+(?:\.\d+)?)$/i.test(expression))continue;
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
  /** A narrow DTO proof: nested non-inheriting class, scalar automatic
   * properties, and at most one constructor assigning only those properties
   * from its parameters or literal scalars. No custom accessors or callbacks. */
  private indexInertDtos(open:number,close:number,top:Int16Array):void{
    for(const hit of this.masked.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*\{/gi)){
      if(top[hit.index!-open]!==1)continue;
      const start=hit.index!+hit[0].length-1;
      const end=matchingPair(this.masked,start,"{","}");
      if(end<0||end>close)continue;
      const name=hit[1],props=new Set<string>();
      let body=this.masked.slice(start+1,end);
      body=body.replace(/(?:@\w+\s*)?(?:public|private|global)\s+(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*\{\s*get\s*;\s*set\s*;\s*\}/gi,(_all,prop:string)=>{
        props.add(prop.toLowerCase());return "";
      });
      const constructor=new RegExp("^\\s*(?:public|private|global)\\s+"+name+"\\s*\\(([^()]*)\\)\\s*\\{([\\s\\S]*)\\}\\s*$","i").exec(body);
      if(constructor){
        const parameters=new Set<string>();
        let valid=true;
        for(const part of constructor[1].split(",").filter(p=>p.trim())){
          const param=/^\s*(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*$/i.exec(part);
          if(!param){valid=false;break;}
          parameters.add(param[1].toLowerCase());
        }
        for(const part of constructor[2].split(";").filter(p=>p.trim())){
          const assignment=/^\s*this\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*|[-+]?\d+|\s*)\s*$/i.exec(part);
          // Quoted strings are masked; the syntax cannot contain a call.
          if(!assignment||!props.has(assignment[1].toLowerCase())||
            !(parameters.has(assignment[2].toLowerCase())||/^(?:true|false|null|[-+]?\d+|\s*)$/i.test(assignment[2]))){valid=false;break;}
        }
        if(!valid)continue;
      }else if(body.trim())continue;
      if(props.size)this.inertDtos.set(name.toLowerCase(),props);
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
    if(!method||!this.isOuter(method))return undefined;
    const n=name.toLowerCase(),dot=n.indexOf(".");
    if(dot>=0)return n.slice(0,dot)===this.owner?.toLowerCase()?this.fields.get(n.slice(dot+1))?.key:undefined;
    return this.locals(method).has(n)?undefined:this.fields.get(n)?.key;
  }
  freshEntry(method:IndexedApexMethod):Map<string,ApexValue>|undefined{
    if(!this.freshEligible||!this.isOuter(method)||!this.fields.size||!method.isStatic||method.visibility!=="public")return undefined;
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
      if(declaration&&!/^(?:return|throw|insert|update|upsert|delete|undelete|merge|break|continue)$/i.test(declaration[1])){
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
    return /^Schema\.FieldSetMember$/i.test(type)&&/^(?:getFieldPath|getLabel|getType)$/i.test(operation);
  }
  /** Strict replay subset: only local scalars/collections, direct member
   * writes and proven built-ins. Unsupported dispatch/callbacks fail closed. */
  replaySafe(method:IndexedApexMethod):boolean{
    const old=this.safe.get(method);if(old!==undefined)return old;
    this.safe.set(method,false);
    if(!this.isOuter(method)||!method.isStatic||method.visibility!=="private")return false;
    const types=this.types(method);
    const check=(source:string,statement=false):boolean=>{
      let visible=maskApexSource(source);
      const schemaAllowed=!this.locals(method).has("schema")&&!/\bclass\s+Schema\b/i.test(this.masked);
      visible=maskSchemaEffectReads(visible,types,schemaAllowed);
      if(/\b(?:insert|update|upsert|delete|undelete|merge|throw|switch|try|while|do)\b/i.test(visible))return false;
      // Recognize only platform constructors and independently proven inert
      // nested DTOs. Unknown allocations are not safe effect evidence.
      const allocations=[...visible.matchAll(/\bnew\s+([A-Za-z_]\w*)(?:\s*<([^<>]+)>)?\s*\(/gi)];
      if(allocations.length!==[...visible.matchAll(/\bnew\b/gi)].length)return false;
      for(const allocation of allocations){
        if(/^(?:List|Set)$/i.test(allocation[1])&&/^\s*(?:String|Object)\s*$/i.test(allocation[2]??""))continue;
        if(!allocation[2]&&this.inertDtos.has(allocation[1].toLowerCase()))continue;
        return false;
      }
      // The only supported chained metadata call here is enum name() on
      // FieldSetMember.getType(). It cannot dispatch into application Apex.
      visible=visible.replace(/\b([A-Za-z_]\w*)\.getType\s*\(\s*\)\s*\.\s*name\s*\(\s*\)/gi,(all,receiver:string)=>
        /^Schema\.FieldSetMember$/i.test(types.get(receiver.toLowerCase())??"")?receiver+".getType()":all);
      // Serialization is permitted only for a source-proven automatic DTO
      // and the read-only literal String.removeEnd suffix.
      visible=visible.replace(/\bJSON\.serialize\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\.\s*removeEnd\s*\(\s*\)/gi,(all,receiver:string)=>
        this.inertDtos.has((types.get(receiver.toLowerCase())??"").toLowerCase())?"JSON.serialize("+receiver+")":all);
      if(/\+\+|--|\[[^\]]*\]\s*(?:=|\+=)|(?:[-*/%&|^]=)/.test(visible))return false;
      const assignments=[...visible.matchAll(/(?:^|[^=!<>])(?:\+=|=(?!=|>))/g)];
      const standalone=visible.trim().replace(/;$/,"");
      const rhs=/^[\w.<> ,]+\s*=(?!=|>)\s*([\s\S]+)$/.exec(standalone)?.[1];
      const direct=directEffectCall(rhs??standalone);
      if(assignments.length>(statement?1:0))return false;
      const write=/^\s*(?:[\w.]+(?:\s*<[\w\s,.<>]+>)?\s+)?((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s*(?:=(?!=|>)|\+=|[-*/%&|^]=|\+\+|--)/i.exec(visible);
      if(write&&!this.key(method,write[1].replace(/\s/g,""))&&!types.has(write[1].toLowerCase())){
        const [receiver,property]=write[1].replace(/\s/g,"").toLowerCase().split(".");
        if(!property||!this.inertDtos.get((types.get(receiver)??"").toLowerCase())?.has(property))return false;
      }
      // Arbitrary application property getters may execute code even without
      // a call token. Only known members, standard metadata type tokens and
      // automatic DTO properties are allowed as non-call qualified reads.
      for(const hit of visible.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b/g)){
        const tail=visible.slice(hit.index!+hit[0].length);
        if(/^\s*[.(]/.test(tail))continue; // the complete call is checked below
        const receiver=hit[1].toLowerCase(),member=hit[2].toLowerCase();
        if(receiver==="label"||receiver==="schema"&&member==="fieldsetmember"||
          this.key(method,hit[1]+"."+hit[2])||
          this.inertDtos.get((types.get(receiver)??"").toLowerCase())?.has(member))continue;
        return false;
      }
      for(const hit of visible.matchAll(/\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)){
        const name=hit[1].replace(/\s+/g,"");
        if(safeCall.test(name)||this.readOnlyCall(method,name))continue;
        if(/^Label\.[A-Za-z_]\w*\.split$/i.test(name))continue;
        if(/^JSON\.serialize$/i.test(name)){
          const open=visible.indexOf("(",hit.index!);
          const close=matchingPair(visible,open);
          const receiver=visible.slice(open+1,close).trim().toLowerCase();
          if(this.inertDtos.has((types.get(receiver)??"").toLowerCase()))continue;
          return false;
        }
        if(this.inertDtos.has(name.toLowerCase())&&/\bnew\s*$/i.test(visible.slice(0,hit.index)))continue;
        const dot=name.lastIndexOf(".");
        if(dot>0&&safeMember.test(name.slice(dot+1))){
          const type=types.get(name.slice(0,dot).toLowerCase())??"";
          if(/^(?:String|List\s*<\s*String\s*>|Set\s*<\s*String\s*>|Map\s*<\s*String\s*,\s*String\s*>|Schema\.FieldSetMember|List\s*<\s*Object\s*>)$/i.test(type)){
            if(/^(?:add|addAll|clear|put|putAll|remove)$/i.test(name.slice(dot+1))&&direct!==name.toLowerCase())return false;
            continue;
          }
        }
        // Allow a uniquely resolved nested local private static helper.
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===name.toLowerCase());
        if(candidates.length===1&&direct===name.toLowerCase()&&this.replaySafe(candidates[0]))continue;
        return false;
      }
      return true;
    };
    const visit=(nodes:readonly SourceNode[]):boolean=>nodes.every(node=>
      node.kind!=="opaque"&&!(node.kind==="for"&&!node.loopVariable)&&
      node.condition!=="__apex_exception_path_unknown__"&&
      !(node.kind==="statement"&&!/^\s*(?:return\b|break\s*;|continue\s*;|(?:[\w.]+(?:\s*<[\w\s,.<>]+>)?\s+)?[\w.]+\s*(?:=(?!=|>)|\+=|;)|[\w.]+\s*\()/i.test(maskApexSource(node.text??"")))&&
      check(node.text??"",node.kind==="statement")&&check(node.condition??"")&&check(node.iterable??"")&&
      visit(node.body??[])&&visit(node.otherwise??[]));
    const result=visit(method.body);
    this.safe.set(method,result);return result;
  }
  /** No write, alias, escape, or unknown receiver use of a typed map
   * argument. Allows caller loops to reuse the original Describe snapshot. */
  schemaArgumentReadOnly(method:IndexedApexMethod,index:number):boolean{
    if(!method.parameters[index]||canonicalApexType(method.parameterTypes?.[index])!=="map<string,schema.sobjectfield>"||!this.replaySafe(method))return false;
    const name=method.parameters[index];
    const visible=this.masked.slice(method.start,method.end);
    const body=maskSchemaEffectReads(visible,this.types(method),!this.locals(method).has("schema")&&!/\bclass\s+Schema\b/i.test(this.masked));
    return !new RegExp("\\b"+name+"\\b","i").test(body);
  }
  /** Exact reference summaries must not depend on an unspecified Set
   * iteration order. Reuse the existing typed receiver and replay proofs;
   * conservatively reject potentially ordered observations of a Set,
   * including conversions to List. Ordinary forward replay is unchanged. */
  argumentSummarySafe(method:IndexedApexMethod):boolean{
    if(!this.replaySafe(method))return false;
    const checked=new Set<IndexedApexMethod>();
    const visit=(helper:IndexedApexMethod):boolean=>{
      if(checked.has(helper))return true;
      checked.add(helper);
      const rawBody=this.masked.slice(helper.start,helper.end);
      const body=maskSchemaEffectReads(rawBody,this.types(helper),!this.locals(helper).has("schema")&&!/\bclass\s+Schema\b/i.test(this.masked));
      const hasSet=[...this.types(helper).values()].some(t=>canonicalApexType(t)?.startsWith("set<"))||
        /\bnew\s+Set\s*</i.test(body);
      if(hasSet){
        const setNames=[...this.types(helper)].filter(([,t])=>canonicalApexType(t)?.startsWith("set<")).map(([n])=>n);
        // Remove only typed Set mutations and membership/cardinality reads.
        // Remaining Set uses in ordered observations are unproven. Keep
        // the older conservative rule for untyped/new Set expressions.
        if(!setNames.length&&/\bfor\s*\(|\bString\s*\.\s*join\s*\(|\bnew\s+List\s*<|\.\s*get\s*\(|\[[^\]]*\]/i.test(body))return false;
        for(const name of setNames){
          const ordered=new RegExp("(?:\\bfor\\s*\\([^)]*:\\s*"+name+"\\b|\\bString\\s*\\.\\s*join\\s*\\(\\s*"+name+"\\b|\\bnew\\s+List\\s*<[^>]+>\\s*\\(\\s*"+name+"\\b|\\b"+name+"\\s*(?:\\[|\\.\\s*get\\s*\\())","i");
          if(ordered.test(body))return false;
        }
      }
      // replaySafe admits only uniquely resolved nested private static calls;
      // inspect those same source targets for Set ordering as well.
      for(const hit of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)){
        if(/\.\s*$/.test(body.slice(0,hit.index)))continue;
        const candidates=this.methods.filter(m=>m.name.toLowerCase()===hit[1].toLowerCase());
        if(candidates.length===1&&this.replaySafe(candidates[0])&&!visit(candidates[0]))return false;
      }
      return true;
    };
    return visit(method);
  }
  /** An ignored scalar or inert DTO result cannot expose a mutable input
   * collection through a returned alias. Do not assume arbitrary DTOs are inert. */
  resultCannotExposeReference(method:IndexedApexMethod):boolean{
    const type=canonicalApexType(method.returnType);
    return !!type&&(/^(?:void|string|boolean|integer|long|decimal|double|id|date|datetime)$/.test(type)||this.inertDtos.has(type));
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
export function directEffectInvocation(source:string):{name:string;argumentText:string}|undefined{
  const masked=maskApexSource(source);
  const start=masked.length-masked.trimStart().length;
  const end=masked.trimEnd().length;
  const expr=source.slice(start,end);
  const visible=masked.slice(start,end);
  const call=/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(visible);
  if(!call)return undefined;
  const open=visible.indexOf("(");
  if(matchingPair(visible,open)!==visible.length-1||/[()]/.test(visible.slice(open+1,-1)))return undefined;
  return {name:call[1].toLowerCase(),argumentText:expr.slice(open+1,-1)};
}
export function directEffectCall(source:string):string|undefined{
  return directEffectInvocation(source)?.name;
}

/** Exact metadata access, with no embedded executable arguments. */
export function isLiteralFieldSetRead(source:string):boolean{
  const expr=source.trim();
  return /^(?:Schema\.SObjectType\.[A-Za-z_]\w*|[A-Za-z_]\w*\.SObjectType\.getDescribe\s*\(\s*\))\s*\.fieldSets\s*\.getMap\s*\(\s*\)\s*\.get\s*\(\s*'[A-Za-z_]\w*'\s*\)(?:\s*\.getFields\s*\(\s*\))?$/i.test(expr);
}
