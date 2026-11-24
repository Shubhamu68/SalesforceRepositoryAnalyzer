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

test("v0.1.1 pure scalar initializers support String/Integer.valueOf chains",()=>{
  const idx=index(
    ["NumericCodes.cls","public class NumericCodes {\n"+
      " public static final Integer CODE = Integer.valueOf('945');\n"+
      " public static final String TRX_SET_945 = String.valueOf(CODE);\n"+
      " public static final String PREFIX = 'TRX_';\n"+
      " public static final String FULL = PREFIX + TRX_SET_945;\n}"],
  );
  assert.deepEqual(idx.resolve("NumericCodes.CODE"),{kind:"number",value:945});
  expectText(idx,"NumericCodes.TRX_SET_945","945");
  expectText(idx,"NumericCodes.FULL","TRX_945");
});

test("v0.1.1 null initializers and prefix increments cannot prove static query fields",()=>{
  const idx=index(["MutableConfig.cls","public class MutableConfig {\n"+
    " private static Integer COUNT = 1;\n"+
    " public static final String FIELD = null;\n"+
    " public static void update(){++COUNT;}\n}"]);
  expectUnknown(idx,"MutableConfig.COUNT",/assigned after initialization/i);
  expectUnknown(idx,"MutableConfig.FIELD",/null initializer/i);
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

test("real AdvantageConstants declarations: public mutable product names stay unknown but final OTC selectors resolve",()=>{
  const idx=index(["AdvantageConstants.cls",[
    "public class AdvantageConstants {",
    " public static String AUTHORIZED_PRODUCT_APINAME='Authorized_Product__c';",
    " public static String PRODUCT_APINAME='Product2';",
    " public static String BILL_ONLY ='Bill Only';",
    " public static final String TRX_SET_945 = '945';",
    " public static final String OTC_DRAFT_INVOICE_CREATION = 'OTC Draft Invoice Creation';",
    "}",
  ].join("\n")]);
  expectUnknown(idx,"AdvantageConstants.PRODUCT_APINAME",/externally mutable/i);
  expectUnknown(idx,"AdvantageConstants.AUTHORIZED_PRODUCT_APINAME",/externally mutable/i);
  expectUnknown(idx,"AdvantageConstants.BILL_ONLY",/externally mutable/i);
  expectText(idx,"AdvantageConstants.TRX_SET_945","945");
  expectText(idx,"AdvantageConstants.OTC_DRAFT_INVOICE_CREATION","OTC Draft Invoice Creation");
});

test("real OTC object mapping constants: Shipment mappings final, OS and ODGS mappings mutable",()=>{
  const idx=index(["AdvantageConstants.cls",[
    "public class AdvantageConstants {",
    " public static String ORDER_SUMMARY = 'OrderSummary';",
    " public static String ORDER_DELIVERY_GROUP_SUMMARY ='OrderDeliveryGroupSummary';",
    " public static final String SHIPMENT = 'Shipment__c';",
    " public static final String SHIPMENT_LINE = 'ShipmentLine__c';",
    " public static final String INVOICE = 'Invoice__c';",
    " public static final String INVOICELINE = 'InvoiceLine__c';",
    " public static final String TRX_SET_945 = '945';",
    " public static final String OTC_DRAFT_INVOICE_CREATION = 'OTC Draft Invoice Creation';",
    "}",
  ].join("\n")]);
  for(const field of ["ORDER_SUMMARY","ORDER_DELIVERY_GROUP_SUMMARY"])
    expectUnknown(idx,"AdvantageConstants."+field,/externally mutable/i);
  expectText(idx,"AdvantageConstants.SHIPMENT","Shipment__c");
  expectText(idx,"AdvantageConstants.SHIPMENT_LINE","ShipmentLine__c");
  expectText(idx,"AdvantageConstants.INVOICE","Invoice__c");
  expectText(idx,"AdvantageConstants.INVOICELINE","InvoiceLine__c");
  expectText(idx,"AdvantageConstants.TRX_SET_945","945");
  expectText(idx,"AdvantageConstants.OTC_DRAFT_INVOICE_CREATION",
    "OTC Draft Invoice Creation");
});

test("Apex map literal key is not a static field write",()=>{
  const idx=index(["Config.cls",[
    "public class Config {",
    " private static String PRODUCT = 'Product2';",
    " public static Map<String,String> build(){",
    "   return new Map<String,String>{ PRODUCT => 'Name' };",
    " }",
    "}",
  ].join("\n")]);
  expectText(idx,"Config.PRODUCT","Product2");
});

test("all modifier and scope variants are classified without treating instance final as class constants",()=>{
  const idx=index(["ModifierMatrix.cls",[
    "public class ModifierMatrix {",
    " public static final String A = 'Id';",
    " private static final string B = 'Name';",
    " protected final static String C = 'Phone';",
    " global STATIC FINAL STRING D = 'CreatedDate';",
    " static final String E = 'OwnerId';",
    " final static String F = 'LastModifiedDate';",
    " private final String G = 'Industry';",
    " public final String H = 'Type';",
    " final String I = 'AnnualRevenue';",
    " private final String J;",
    " public static final String K;",
    " public static String L;",
    " public static String M = 'Description';",
    "}",
  ].join("\n")]);
  for(const [field,expected] of Object.entries({
    A:"Id",B:"Name",C:"Phone",D:"CreatedDate",E:"OwnerId",F:"LastModifiedDate",
  }))expectText(idx,"ModifierMatrix."+field,expected);
  for(const field of ["G","H","I"])
    expectUnknown(idx,"ModifierMatrix."+field,/instance field/i);
  for(const [field,expected] of Object.entries({
    G:"Industry",H:"Type",I:"AnnualRevenue",
  }))expectText({resolve:(name:string)=>idx.resolveInstance("ModifierMatrix",name.split(".")[1])} as ApexStaticValueIndex,"ModifierMatrix."+field,expected);
  expectUnknown(idx,"ModifierMatrix.K",/no declaration initializer/i);
  expectUnknown(idx,"ModifierMatrix.L",/no declaration initializer/i);
  expectUnknown(idx,"ModifierMatrix.M",/externally mutable/i);
  expectUnknown(idx,"ModifierMatrix.J",/instance field/i);
  const incomplete=idx.resolveInstance("ModifierMatrix","J");
  assert.equal(incomplete.kind,"unknown");
  if(incomplete.kind==="unknown")assert.match(incomplete.reason,/constructor|initializer-block/i);
});

test("non-primitive or unsupported declarations never become scalar constants",()=>{
  const idx=index(["NonScalars.cls",[
    "public class NonScalars {",
    " public static final String QUERY = 'SELECT Id FROM Account';",
    " public static final Integer LIMIT_VALUE = 5;",
    " public static final String[] FIELDS = new String[]{'Name'};",
    " public static final List<String> ALIASES = new List<String>{'Name'};",
    " public static final String PROPERTY { get; private set; }",
    "}",
  ].join("\n")]);
  expectText(idx,"NonScalars.QUERY","SELECT Id FROM Account");
  assert.deepEqual(idx.resolve("NonScalars.LIMIT_VALUE"),{kind:"number",value:5});
  expectUnknown(idx,"NonScalars.FIELDS",/no supported static scalar initializer/i);
  expectUnknown(idx,"NonScalars.ALIASES",/no supported static scalar initializer/i);
  expectUnknown(idx,"NonScalars.PROPERTY",/no supported static scalar initializer/i);
});
