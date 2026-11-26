import { ApexApiVersionIndex } from "../core/apex/ApexApiVersionIndex.js";
import { classifySoqlMode, resolveSoqlExecutionMode, type SoqlExecutionMode } from "../analyzer/soqlExecutionMode.js";

/** SOQL enforcement rules consume shared Apex API-version metadata. */
export class ApexExecutionSecurityModeResolver {
  constructor(private readonly versions=new ApexApiVersionIndex()){}
  clearCache():void { this.versions.clearCache(); }
  getApiVersion(sourceFilePath:string):Promise<number|undefined>{return this.versions.getApiVersion(sourceFilePath);}
  async resolve(query:string,sourceFilePath:string):Promise<SoqlExecutionMode>{
    const declared=classifySoqlMode(query);
    return resolveSoqlExecutionMode(declared,await this.getApiVersion(sourceFilePath));
  }
}
