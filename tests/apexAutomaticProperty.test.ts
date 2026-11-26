import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexInstanceIndex} from "../src/core/apex/ApexInstanceModel.js";
import {readApexAutomaticScalarProperty} from "../src/core/apex/ApexAutomaticProperty.js";
import {textValue} from "../src/core/apex/ApexValueEvaluator.js";

test("automatic scalar property and ordinary field use the same constructed instance slots",()=>{
 const source="public class Parent { public class Column { @AuraEnabled public Boolean navigable {get;set;} @AuraEnabled public String path {get;set;} public String idPath; public Column(){this.navigable=false;this.path='Header.Name';this.idPath='Header.Id';} } }";
 const index=new ApexInstanceIndex([{filePath:"Parent.cls",source}]);
 const value=index.construct("Column",[],"Parent.cls");
 assert.equal(value?.kind,"instance",JSON.stringify(value));
 if(value?.kind!=="instance")return;
 assert.deepEqual(new Map(value.entries).get("path"),textValue("Header.Name"));
 assert.deepEqual(new Map(value.entries).get("idPath"),textValue("Header.Id"));
 assert.deepEqual(new Map(value.entries).get("navigable"),{kind:"text",values:["false"],scalarType:"boolean"});
});
test("automatic property proof rejects custom accessors, static, collection and duplicate storage",()=>{
 for(const [header,body] of [
  ["public String path","get {return 'Name';} set;"],
  ["public String path","get; set {System.debug(value);}"],
  ["public static String path","get;set;"],
  ["public List<String> path","get;set;"],
  ["public String path","get;private set;"]
 ])assert.equal(readApexAutomaticScalarProperty(header,body),undefined);
 for(const source of [
  "public class C { public String path {get {return 'Name';} set;} }",
  "public class C { public String path {get;set;} public String PATH; }"
 ]){
  const index=new ApexInstanceIndex([{filePath:"C.cls",source}]);
  assert.equal(index.construct("C",[],"C.cls")?.kind,"unknown",source);
 }
});
