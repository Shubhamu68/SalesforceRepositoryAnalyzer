import {ApexMetadataReplay} from "../core/metadata/ApexMetadataSnapshot.js";
import {scanApexSoqlWithUnresolved} from "../scanner/apexSoqlScanner.js";
import path from "node:path";

// Explicit developer workflow only; no Salesforce connection, permission
// verifier, .env loading or persona report is constructed in this process.
const [snapshotFile,repositoryPath,filter]=process.argv.slice(2);
if(!snapshotFile||!repositoryPath){
  console.error("Usage: npm run replay:metadata -- <snapshot.json> <Salesforce repository> [Apex filename]");
  process.exitCode=1;
}else{
  try{
    const replay=await ApexMetadataReplay.load(snapshotFile);
    process.env.SALESFORCE_SOQL_TRACE="1";
    const result=await scanApexSoqlWithUnresolved(repositoryPath,replay.provider);
    const include=(file:string)=>!filter||path.basename(file).toLowerCase()===filter.toLowerCase();
    console.log(JSON.stringify({mode:"OFFLINE_METADATA_REPLAY",metadata:replay.stats,missingRequests:replay.missingRequests,
      queries:result.queries.length,unresolved:result.unresolvedDynamic.length,
      selectedQueries:result.queries.filter(q=>include(q.filePath)),
      selectedUnresolved:result.unresolvedDynamic.filter(q=>include(q.filePath))},null,2));
    if(replay.stats.missing)process.exitCode=2;
  }catch{
    console.error("Offline replay failed: invalid snapshot, unreadable repository or analysis error.");
    process.exitCode=1;
  }
}
