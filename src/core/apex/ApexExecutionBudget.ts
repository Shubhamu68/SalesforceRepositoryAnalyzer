/** Bounded interpreter accounting independent of SOQL or a particular
 * analysis consumer. Limits are never silently raised by an optimizer. */
export class ApexExecutionBudget {
  private operations=0;
  private peakPaths=0;
  private issue:string|undefined;
  constructor(private readonly maxOperations:number,private readonly maxPaths:number){}
  get exceeded():boolean{return this.issue!==undefined;}
  get reason():string|undefined{return this.issue;}
  reset():void {this.operations=0;this.peakPaths=0;this.issue=undefined;}
  visit(offset:number,method:string):boolean{
    if(this.exceeded)return false;
    if(++this.operations>this.maxOperations){
      this.issue="Apex operation budget exceeded ("+this.operations+"/"+this.maxOperations+
        " operations, peak "+this.peakPaths+" paths; "+method+" at source offset "+offset+").";
      return false;
    }
    return true;
  }
  checkPaths(paths:number,offset:number,method:string):boolean{
    this.peakPaths=Math.max(this.peakPaths,paths);
    if(this.exceeded)return false;
    if(paths>this.maxPaths){
      this.issue="Apex path enumeration budget exceeded ("+paths+"/"+this.maxPaths+
        " distinct paths, "+this.operations+" operations; "+method+" at source offset "+offset+").";
      return false;
    }
    return true;
  }
}
