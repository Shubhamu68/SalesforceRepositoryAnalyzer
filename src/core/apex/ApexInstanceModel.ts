import {maskApexSource,matchingPair,splitApexTopLevel,parseApexStatements,stripApexComments,type SourceNode,type ApexRepositorySyntaxInventory} from "./ApexSourceModel.js";
import {evaluateApexExpression,addApexValues,unknown,type ApexValue} from "./ApexValueEvaluator.js";
import {parseApexDeclaration,selectApexOverload,type ApexArgumentTypes,type ApexCallResolver} from "./ApexTypeSystem.js";
import {knownBoolean} from "./ApexScalarOperators.js";

type Instance=Extract<ApexValue,{kind:"instance"}>;
type Resolver=ApexCallResolver;
interface ClassShape {
  name:string;
  filePath:string;
  fields:Array<{name:string;initializer?:string}>;
  constructors:Array<{parameters:string[];parameterTypes:string[];body:SourceNode[]}>;
  initializationOrder:Array<{field:string;initializer?:string}|{block:SourceNode[]}>;
  supported:boolean;
}
const scalar=/^(?:(?:public|private|protected|global|final|transient)\s+)*(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/i;

/** Small, explicit object domain: allocation identity is reference identity.
 * Only source-backed scalar fields and bounded, known-branch initialization are
 * modeled. No guessed inheritance, properties, dynamic dispatch or effects. */
export class ApexInstanceIndex {
  private readonly shapes=new Map<string,ClassShape[]>();
  constructor(files:readonly {filePath:string;source:string}[],syntax?:ApexRepositorySyntaxInventory){
    for(const file of files){
      const source=file.source,masked=syntax?.masked(source)??maskApexSource(source);
      const classes:Array<{name:string;start:number;end:number}>=[];
      for(const hit of masked.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*([^{;]*)\{/gi)){
        const open=hit.index!+hit[0].length-1,close=matchingPair(masked,open,"{","}");
        if(close<0)continue;
        const parent=classes.filter(c=>c.start<open&&open<c.end).at(-1);
        const name=parent?parent.name+"."+hit[1]:hit[1];
        classes.push({name,start:open,end:close});
        const shape:ClassShape={name,filePath:file.filePath,fields:[],constructors:[],initializationOrder:[],
          supported:!/\b(?:extends|implements)\b/i.test(hit[2])||/^\s*implements\s+Database\s*\.\s*Batchable\s*<\s*[A-Za-z_]\w*\s*>\s*$/i.test(hit[2])};
        // Split direct class members at top-level semicolons and blocks.
        let start=open+1;
        while(start<close){
          while(start<close&&/\s/.test(masked[start]))start++;
          if(start>=close)break;
          let boundary=start,paren=0,bracket=0;
          for(;boundary<close;boundary++){
            const ch=masked[boundary];
            if(ch==="(")paren++;else if(ch===")")paren--;
            else if(ch==="[")bracket++;else if(ch==="]")bracket--;
            if(paren===0&&bracket===0&&(ch===";"||ch==="{"))break;
          }
          if(boundary>=close){shape.supported=false;break;}
          const header=source.slice(start,boundary).trim();
          const visible=masked.slice(start,boundary).trim();
          if(masked[boundary]===";"){
            if(!/\bstatic\b/i.test(visible)){
              const field=scalar.exec(header);
              if(field){shape.fields.push({name:field[1],initializer:field[2]});shape.initializationOrder.push({field:field[1],initializer:field[2]});}
              else shape.supported=false;
            }
            start=boundary+1;continue;
          }
          const end=matchingPair(masked,boundary,"{","}");
          if(end<0||end>close){shape.supported=false;break;}
          // A collection literal/property is not a supported scalar declaration.
          // Methods/nested classes do not run during construction.
          const simple=hit[1];
          const ctor=new RegExp("^(?:(?:public|private|protected|global)\\s+)*"+simple+"\\s*\\(([\\s\\S]*)\\)$","i").exec(visible);
          if(ctor){
            const params=ctor[1].trim()?splitApexTopLevel(ctor[1],",").map(p=>parseApexDeclaration(p)):[];
            if(params.some(p=>!p))shape.supported=false;
            else shape.constructors.push({parameters:params.map(p=>p!.name),parameterTypes:params.map(p=>p!.type),body:parseApexStatements(source,boundary+1,end,masked)});
          }else if(!visible){
            shape.initializationOrder.push({block:parseApexStatements(source,boundary+1,end,masked)});
          }else if(/^static$/i.test(visible)){
            // Static initialization is outside the per-instance domain.
          }else if(!/\)\s*$/.test(visible)&&!/\bclass\b/i.test(visible)){
            shape.supported=false;
          }
          start=end+1;
        }
        const key=name.toLowerCase();
        this.shapes.set(key,[...(this.shapes.get(key)??[]),shape]);
      }
    }
  }

  construct(name:string,args:readonly ApexValue[],filePath:string,resolve?:Resolver,types?:ApexArgumentTypes):ApexValue|undefined{
    let candidates=this.shapes.get(name.toLowerCase())??[];
    if(!candidates.length&&!name.includes(".")){
      candidates=[...this.shapes.values()].flat().filter(c=>
        c.filePath===filePath&&c.name.toLowerCase().endsWith("."+name.toLowerCase()));
    }
    if(!candidates.length)return undefined;
    if(candidates.length!==1)return unknown("Ambiguous Apex instance class "+name+".");
    const shape=candidates[0];
    if(!shape.supported||shape.fields.length>100)
      return unknown("Unsupported instance declarations or initialization for "+name+".");
    const constructor=selectApexOverload(shape.constructors,args.length,types);
    if(!constructor&&(shape.constructors.length||args.length))
      return unknown("Constructor overload is not uniquely proven for "+name+".");
    const fields=new Map<string,ApexValue>();
    const fieldNames=new Map(shape.fields.map(f=>[f.name.toLowerCase(),f.name]));
    let unsupportedEffect=false;
    const evaluate=(expr:string,parameters:Map<string,ApexValue>):ApexValue=>{
      // No arbitrary helper calls from constructors: effects and heap transfer
      // are not modeled here. Pure scalar expressions and metadata constants
      // can be evaluated using the existing expression interpreter.
      const calls=[...maskApexSource(expr).matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)];
      if(calls.some(call=>!/^String\.(?:isBlank|isNotBlank|valueOf|escapeSingleQuotes)$/i.test(call[1]))){unsupportedEffect=true;return unknown("Constructor expression has unproven effects.");}
      const env=new Map<string,ApexValue>();
      for(const [key,value] of fields){env.set(key,value);env.set("this."+key,value);}
      for(const [key,value] of parameters)env.set(key,value);
      return evaluateApexExpression(expr,{values:env,resolveCall:resolve});
    };
    for(const field of shape.fields)fields.set(field.name,unknown("Instance field has no proven assignment."));
    let operations=0;
    const execute=(nodes:SourceNode[],parameters:Map<string,ApexValue>,depth=0):boolean=>{
      if(depth>12)return false;
      const scoped=(body:SourceNode[]):boolean=>{
        const local=new Map(parameters);
        if(!execute(body,local,depth+1))return false;
        for(const key of parameters.keys())parameters.set(key,local.get(key)!);
        return true;
      };
      for(const node of nodes){
        if(++operations>500)return false;
        if(node.kind==="block"){if(!scoped(node.body??[]))return false;continue;}
        if(node.kind==="if"){
          const condition=knownBoolean(evaluate(node.condition??"",parameters));
          if(condition===undefined)return false;
          if(!scoped(condition?node.body??[]:node.otherwise??[]))return false;
          continue;
        }
        if(node.kind!=="statement")return false;
        const statement=stripApexComments(node.text??"").trim().replace(/;\s*$/,"");
        const local=/^(?:final\s+)?(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/i.exec(statement);
        if(local){
          // Shadowing an existing parameter/local requires a separate lexical
          // binding model. Reject rather than silently changing the outer slot.
          if([...parameters.keys()].some(k=>k.toLowerCase()===local[1].toLowerCase()))return false;
          parameters.set(local[1],local[2]?evaluate(local[2],parameters):unknown("Constructor local is not assigned."));
          continue;
        }
        const assignment=/^(?:(this)\s*\.\s*)?([A-Za-z_]\w*)\s*(\+?=)(?!=|>)\s*([\s\S]+)$/i.exec(statement);
        if(!assignment)return false;
        const [,explicit,key,operator,rhs]=assignment;
        const localKey=!explicit?[...parameters.keys()].find(k=>k.toLowerCase()===key.toLowerCase()):undefined;
        const field=fieldNames.get(key.toLowerCase());
        const previous=localKey?parameters.get(localKey):field?fields.get(field):undefined;
        let next=evaluate(rhs,parameters);
        if(operator==="+=")next=previous?addApexValues(previous,next):unknown("Constructor assignment has no proven previous value.");
        if(localKey){parameters.set(localKey,next);continue;}
        if(!field)return false;
        fields.set(field,next);
      }
      return true;
    };
    for(const step of shape.initializationOrder){
      if("block" in step){if(!execute(step.block,new Map()))return unknown("Instance initializer has unsupported effects for "+name+".");}
      else if(step.initializer)fields.set(step.field,evaluate(step.initializer,new Map()));
    }
    if(constructor){
      const active=new Set<typeof constructor>();
      const invoke=(ctor:typeof constructor,inputs:readonly ApexValue[]):boolean=>{
        if(active.has(ctor)||active.size>=8)return false;
        active.add(ctor);
        try{
          const parameters=new Map(ctor.parameters.map((p,i)=>[p,inputs[i]]));
          const first=ctor.body[0];
          const delegation=first?.kind==="statement"
            ?/^\s*this\s*\(([\s\S]*)\)\s*;\s*$/i.exec(stripApexComments(first.text??""))
            :null;
          if(delegation){
            const expressions=delegation[1].trim()?splitApexTopLevel(delegation[1],","):[];
            const delegated=expressions.map(expr=>evaluate(expr,parameters));
            const delegatedTypes=expressions.map(expr=>{
              const index=ctor.parameters.findIndex(p=>p.toLowerCase()===expr.trim().toLowerCase());
              if(index>=0)return ctor.parameterTypes[index];
              if(/^\x27(?:\\.|[^\x27\\])*\x27$/s.test(expr.trim()))return "string";
              if(/^(?:true|false)$/i.test(expr.trim()))return "boolean";
              if(/^-?\d+$/.test(expr.trim())&&Math.abs(Number(expr))<=2147483647)return "integer";
              if(/^null$/i.test(expr.trim()))return "null";
              return undefined;
            });
            const selected=selectApexOverload(shape.constructors,delegated.length,delegatedTypes);
            if(!selected||delegated.some(value=>value.kind==="unknown")||!invoke(selected,delegated))return false;
            return execute(ctor.body.slice(1),parameters);
          }
          return execute(ctor.body,parameters);
        }finally{active.delete(ctor);}
      };
      if(!invoke(constructor,args))return unknown("Constructor has unsupported effects or delegation for "+name+".");
    }
    if(unsupportedEffect)return unknown("Constructor or initializer contains unproven effects for "+name+".");
    return {kind:"instance",className:shape.name,entries:[...fields]} satisfies Instance;
  }
}

export function readInstanceMember(value:Instance,field:string):ApexValue{
  return value.entries.find(([key])=>key.toLowerCase()===field.toLowerCase())?.[1]??
    unknown("Instance member "+field+" is not proven.");
}
export function writeInstanceMember(value:Instance,field:string,next:ApexValue):ApexValue{
  const key=value.entries.find(([key])=>key.toLowerCase()===field.toLowerCase())?.[0];
  if(!key)return unknown("Instance member assignment is not proven.");
  return {...value,entries:value.entries.map(([name,old])=>[name,name===key?next:old])};
}
