import {maskApexSource,matchingPair,splitApexTopLevel,parseApexStatements,type SourceNode} from "./ApexSourceModel.js";
import {evaluateApexExpression,unknown,type ApexValue} from "./ApexValueEvaluator.js";

type Instance=Extract<ApexValue,{kind:"instance"}>;
type Resolver=(name:string,args:ApexValue[])=>ApexValue|undefined;
interface ClassShape {
  name:string;
  filePath:string;
  fields:Array<{name:string;initializer?:string}>;
  constructors:Array<{parameters:string[];body:SourceNode[]}>;
  initializers:SourceNode[][];
  supported:boolean;
}
const scalar=/^(?:(?:public|private|protected|global|final|transient)\s+)*(?:String|Boolean|Integer|Long|Decimal|Double|Id)\s+([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/i;

/** Small, explicit object domain: allocation identity is reference identity.
 * Only source-backed scalar fields and straight-line initialization are
 * modeled. No guessed inheritance, properties, dynamic dispatch or effects. */
export class ApexInstanceIndex {
  private readonly shapes=new Map<string,ClassShape[]>();
  constructor(files:readonly {filePath:string;source:string}[]){
    for(const file of files){
      const source=file.source,masked=maskApexSource(source);
      const classes:Array<{name:string;start:number;end:number}>=[];
      for(const hit of masked.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*([^{;]*)\{/gi)){
        const open=hit.index!+hit[0].length-1,close=matchingPair(masked,open,"{","}");
        if(close<0)continue;
        const parent=classes.filter(c=>c.start<open&&open<c.end).at(-1);
        const name=parent?parent.name+"."+hit[1]:hit[1];
        classes.push({name,start:open,end:close});
        const shape:ClassShape={name,filePath:file.filePath,fields:[],constructors:[],initializers:[],
          supported:!/\b(?:extends|implements)\b/i.test(hit[2])};
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
              if(field)shape.fields.push({name:field[1],initializer:field[2]});
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
            const parameters=ctor[1].trim()?splitApexTopLevel(ctor[1],",").map(p=>p.trim().match(/([A-Za-z_]\w*)$/)?.[1]??""):[];
            if(parameters.some(p=>!p))shape.supported=false;
            else shape.constructors.push({parameters,body:parseApexStatements(source,boundary+1,end,masked)});
          }else if(!visible){
            shape.initializers.push(parseApexStatements(source,boundary+1,end,masked));
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

  construct(name:string,args:readonly ApexValue[],filePath:string,resolve?:Resolver):ApexValue|undefined{
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
    const constructors=shape.constructors.filter(c=>c.parameters.length===args.length);
    if(constructors.length!==1&&(shape.constructors.length||args.length))
      return unknown("Constructor overload is not uniquely proven for "+name+".");
    const fields=new Map<string,ApexValue>();
    const fieldNames=new Map(shape.fields.map(f=>[f.name.toLowerCase(),f.name]));
    const evaluate=(expr:string,parameters:Map<string,ApexValue>):ApexValue=>{
      // No arbitrary helper calls from constructors: effects and heap transfer
      // are not modeled here. Pure scalar expressions and metadata constants
      // can be evaluated using the existing expression interpreter.
      const calls=[...maskApexSource(expr).matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)];
      if(calls.length)return unknown("Constructor expression has unproven effects.");
      const env=new Map<string,ApexValue>();
      for(const [key,value] of fields){env.set(key,value);env.set("this."+key,value);}
      for(const [key,value] of parameters)env.set(key,value);
      return evaluateApexExpression(expr,{values:env,resolveCall:resolve});
    };
    for(const field of shape.fields){
      const value=field.initializer?evaluate(field.initializer,new Map()):unknown("Instance field has no proven assignment.");
      fields.set(field.name,value);
    }
    const execute=(nodes:SourceNode[],parameters:Map<string,ApexValue>):boolean=>{
      for(const node of nodes){
        if(node.kind!=="statement")return false;
        const assignment=/^\s*(?:(this)\s*\.\s*)?([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+?)\s*;?\s*$/i.exec(node.text??"");
        if(!assignment)return false;
        const [,explicit,key,rhs]=assignment;
        const field=fieldNames.get(key.toLowerCase());
        if(!explicit&&parameters.has(key)){parameters.set(key,evaluate(rhs,parameters));continue;}
        if(!field)return false;
        fields.set(field,evaluate(rhs,parameters));
      }
      return true;
    };
    for(const block of shape.initializers)if(!execute(block,new Map()))
      return unknown("Instance initializer has unsupported effects for "+name+".");
    if(constructors.length){
      const ctor=constructors[0];
      const parameters=new Map(ctor.parameters.map((p,i)=>[p,args[i]]));
      if(!execute(ctor.body,parameters))return unknown("Constructor has unsupported effects for "+name+".");
    }
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
