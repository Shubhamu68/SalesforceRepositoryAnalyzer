import assert from "node:assert/strict";
import {test} from "node:test";
import {ApexStaticValueIndex} from "../src/core/apex/ApexStaticValueIndex.js";

function index(...files:Array<[string,string]>):ApexStaticValueIndex {
  return new ApexStaticValueIndex(files.map(([filePath,source])=>({filePath,source})));
}
function expectText(idx:ApexStaticValueIndex,name:string,expected:string){
  assert.deepEqual(idx.resolve(name),{kind:"text",values:[expected]});
}
function expectUnknown(idx:ApexStaticValueIndex,name:string,why:RegExp){
  const value=idx.resolve(name);
  assert.equal(value.kind,"unknown",JSON.stringify(value));
  if(value.kind==="unknown")assert.match(value.reason,why);
}

test("v0.1.1 constant chain: static final aliases, cross-class members, derived values",()=>{
  const idx=index(
    ["Objects.cls","public class Objects {\n"+
      " public static final String PRODUCT = 'Product2';\n"+
      " public static final String AUTH = 'Authorized_' + 'Product__c';\n"+
      " public static final Integer LIMIT = 12;\n}"],
    ["AdvantageConstants.cls","public class AdvantageConstants {\n"+
      " public static final String PRODUCT_APINAME = Objects.PRODUCT;\n"+
      " public static final String AUTHORIZED_PRODUCT_APINAME = Objects.AUTH;\n"+
      " public static final String QUERY_OBJECT = PRODUCT_APINAME;\n"+
      " public static final String EXTRA = QUERY_OBJECT + ' WHERE IsActive = true';\n"+
      " public static final Boolean ACTIVE = true;\n}"],
  );
  expectText(idx,"AdvantageConstants.PRODUCT_APINAME","Product2");
  expectText(idx,"AdvantageConstants.AUTHORIZED_PRODUCT_APINAME","Authorized_Product__c");
  expectText(idx,"AdvantageConstants.QUERY_OBJECT","Product2");
  expectText(idx,"AdvantageConstants.EXTRA","Product2 WHERE IsActive = true");
  expectText(idx,"AdvantageConstants.ACTIVE","true");
  assert.deepEqual(idx.resolve("Objects.LIMIT"),{kind:"number",value:12});
});

test("v0.1.1 private static initializer is provable only if no class code writes it",()=>{
  const idx=index(["PrivateConsts.cls","public class PrivateConsts {\n"+
    " private static String STABLE = 'Id';\n"+
    " private static String LATER = 'Name';\n"+
    " private static String INCREMENTED = 'Phone';\n"+
    " public static void update(){LATER = 'Phone'; INCREMENTED += 'more';}\n}"]);
  expectText(idx,"PrivateConsts.STABLE","Id");
  expectUnknown(idx,"PrivateConsts.LATER",/assigned after initialization/i);
  expectUnknown(idx,"PrivateConsts.INCREMENTED",/assigned after initialization/i);
});

test("v0.1.1 public or protected mutable static fields do not become query constants",()=>{
  const idx=index(["AdvantageConstants.cls","public class AdvantageConstants {\n"+
    " public static String PRODUCT_APINAME = 'Product2';\n"+
    " protected static String ORDER_SUMMARY = 'OrderSummary';\n"+
    " private static final String SECRET = 'Id';\n"+
    " public static final String VERIFIED = 'OrderSummary';\n}"]);
  expectUnknown(idx,"AdvantageConstants.PRODUCT_APINAME",/externally mutable/i);
  expectUnknown(idx,"AdvantageConstants.ORDER_SUMMARY",/externally mutable/i);
  expectText(idx,"AdvantageConstants.SECRET","Id");
  expectText(idx,"AdvantageConstants.VERIFIED","OrderSummary");
});

test("v0.1.1 cyclic constant dependencies remain unknown",()=>{
  const idx=index(["Cycle.cls","public class Cycle {\n"+
    " public static final String A = B;\n"+
    " public static final String B = A;\n}"]);
  expectUnknown(idx,"Cycle.A",/cyclic/i);
  expectUnknown(idx,"Cycle.B",/cyclic/i);
});

test("v0.1.1 quoted/commented declarations and method-local variables are not static constants",()=>{
  const idx=index(["NotConstants.cls","public class NotConstants {\n"+
    " // public static final String FAKE = 'Secret__c';\n"+
    " public static final String ACTUAL = 'Name';\n"+
    " public static void example(){\n"+
    "   final String LOCAL = 'Id';\n"+
    " }\n}"]);
  expectText(idx,"NotConstants.ACTUAL","Name");
  expectUnknown(idx,"NotConstants.FAKE",/no supported static scalar initializer/i);
  expectUnknown(idx,"NotConstants.LOCAL",/no supported static scalar initializer/i);
});

test("v0.1.1 missing source, ambiguous class and unsupported initializer are explicit",()=>{
  const idx=index(
    ["a/AdvantageConstants.cls","public class AdvantageConstants {\n"+
      " public static final String COL = System.getenv('RUNTIME');\n}"],
    ["b/AdvantageConstants.cls","public class AdvantageConstants {\n"+
      " public static final String COL = 'Id';\n}"],
  );
  expectUnknown(idx,"AdvantageConstants.COL",/ambiguous repository definitions/i);
  expectUnknown(idx,"NotIncluded.PRODUCT_APINAME",/missing from the indexed repository/i);
  const only=index(["Config.cls","public class Config {\n"+
    " public static final String FIELD = System.Label.Dynamic_Field;\n}"]);
  expectUnknown(only,"Config.FIELD",/label|unsupported/i);
});
