import {apexStateIdentity} from "./ApexStateIdentity.js";
import {unknown,type ApexEnvironment,type ApexValue} from "./ApexValueEvaluator.js";

/** Only applied at path-budget pressure. Unknown diagnostic provenance is
 * not an executable value. Preserve every known binding and reference
 * topology, including runtime symbol identities. If unknown evidence differs,
 * replace that leaf with an unknown rather than choose one path's evidence.
 * No known/unknown or known/known alternatives are merged by this operation. */
export function compactUnknownStates<T extends {values:ApexEnvironment;stopped?:boolean;loopControl?:"break"|"continue"}>(states:readonly T[]):T[]{
  const groups=new Map<string,T[]>();
  for(const state of states){
    const key=(state.loopControl??"normal")+"|"+apexStateIdentity(state.values,!!state.stopped,true);
    const group=groups.get(key)??[];
    group.push(state);groups.set(key,group);
  }
  return [...groups.values()].map(group=>{
    const first=group[0];
    if(group.length===1)return first;
    const memo=new Map<ApexValue,ApexValue>();
    const merge=(values:ApexValue[]):ApexValue=>{
      const value=values[0];
      if(value.kind==="unknown"){
        if(values.every(other=>JSON.stringify(other)===JSON.stringify(value)))return value;
        return {...unknown("Multiple unresolved runtime paths share the same known state."),
          ...(value.symbol?{symbol:value.symbol}:{})} as ApexValue;
      }
      const previous=memo.get(value);
      if(previous)return previous;
      if(value.kind==="map"||value.kind==="instance"){
        const result={...value,entries:[] as Array<[string,ApexValue]>};
        memo.set(value,result);
        result.entries=value.entries.map(([key,item],index)=>[key,merge(values.map(other=>
          other.kind==="map"||other.kind==="instance"?other.entries[index][1]:item))]);
        return result;
      }
      if(value.kind==="instanceList"){
        const result={...value,items:[] as ApexValue[]};
        memo.set(value,result);
        result.items=value.items.map((item,index)=>merge(values.map(other=>other.kind==="instanceList"?other.items[index]:item)));
        return result;
      }
      return value;
    };
    const values:ApexEnvironment=new Map();
    for(const [name,value] of first.values)
      values.set(name,merge(group.map(state=>state.values.get(name)??value)));
    return {...first,values};
  });
}
