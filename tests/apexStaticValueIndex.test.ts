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
  assert.deepEqual(idx.resolve("AdvantageConstants.ACTIVE"),{kind:"text",values:["true"],scalarType:"boolean"});
  assert.deepEqual(idx.resolve("Objects.LIMIT"),{kind:"number",value:12});
});

test("v0.1.1 declared initializer snapshot intentionally uses initial values even with later writes",()=>{
  const idx=index(["PrivateConsts.cls","public class PrivateConsts {\n"+
    " private static String STABLE = 'Id';\n"+
    " private static String LATER = 'Name';\n"+
    " private static String INCREMENTED = 'Phone';\n"+
    " public static void update(){LATER = 'Phone'; INCREMENTED += 'more';}\n}"]);
  expectText(idx,"PrivateConsts.STABLE","Id");
  expectText(idx,"PrivateConsts.LATER","Name");
  expectText(idx,"PrivateConsts.INCREMENTED","Phone");
});

test("v0.1.1 public or protected initialized scalar fields participate in the snapshot",()=>{
  const idx=index(["AdvantageConstants.cls","public class AdvantageConstants {\n"+
    " public static String PRODUCT_APINAME = 'Product2';\n"+
    " protected static String ORDER_SUMMARY = 'OrderSummary';\n"+
    " private static final String SECRET = 'Id';\n"+
    " public static final String VERIFIED = 'OrderSummary';\n}"]);
  expectText(idx,"AdvantageConstants.PRODUCT_APINAME","Product2");
  expectText(idx,"AdvantageConstants.ORDER_SUMMARY","OrderSummary");
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

test("v0.1.1 snapshot ignores later prefix increments but null initializer stays unknown",()=>{
  const idx=index(["MutableConfig.cls","public class MutableConfig {\n"+
    " private static Integer COUNT = 1;\n"+
    " public static final String FIELD = null;\n"+
    " public static void update(){++COUNT;}\n}"]);
  assert.deepEqual(idx.resolve("MutableConfig.COUNT"),{kind:"number",value:1});
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

test("real AdvantageConstants declarations: initialized nonfinal product names and final OTC selectors resolve",()=>{
  const idx=index(["AdvantageConstants.cls",[
    "public class AdvantageConstants {",
    " public static String AUTHORIZED_PRODUCT_APINAME='Authorized_Product__c';",
    " public static String PRODUCT_APINAME='Product2';",
    " public static String BILL_ONLY ='Bill Only';",
    " public static final String TRX_SET_945 = '945';",
    " public static final String OTC_DRAFT_INVOICE_CREATION = 'OTC Draft Invoice Creation';",
    "}",
  ].join("\n")]);
  expectText(idx,"AdvantageConstants.PRODUCT_APINAME","Product2");
  expectText(idx,"AdvantageConstants.AUTHORIZED_PRODUCT_APINAME","Authorized_Product__c");
  expectText(idx,"AdvantageConstants.BILL_ONLY","Bill Only");
  expectText(idx,"AdvantageConstants.TRX_SET_945","945");
  expectText(idx,"AdvantageConstants.OTC_DRAFT_INVOICE_CREATION","OTC Draft Invoice Creation");
});

test("real OTC object mapping constants: all initialized scalar names resolve",()=>{
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
  expectText(idx,"AdvantageConstants.ORDER_SUMMARY","OrderSummary");
  expectText(idx,"AdvantageConstants.ORDER_DELIVERY_GROUP_SUMMARY","OrderDeliveryGroupSummary");
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
  expectText(idx,"ModifierMatrix.M","Description");
  expectUnknown(idx,"ModifierMatrix.J",/instance field/i);
  const incomplete=idx.resolveInstance("ModifierMatrix","J");
  assert.equal(incomplete.kind,"unknown");
  if(incomplete.kind==="unknown")assert.match(incomplete.reason,/constructor|initializer-block/i);
});

test("collection declarations resolve while unsupported arrays and properties remain unknown",()=>{
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
  assert.deepEqual(idx.resolve("NonScalars.ALIASES"),{kind:"collection",items:["Name"],unique:false});
  expectUnknown(idx,"NonScalars.PROPERTY",/no supported static scalar initializer/i);
});

test("TestVisible and other annotations do not change the initializer snapshot policy",()=>{
  const idx=index(["TestVisibleFields.cls",[
    "public class TestVisibleFields {",
    " @TestVisible",
    " private static String OVERRIDABLE = 'Name';",
    " @TestVisible private static final String IMMUTABLE = 'Id';",
    " private static String INTERNAL = 'CreatedDate';",
    "}",
  ].join("\n")]);
  expectText(idx,"TestVisibleFields.OVERRIDABLE","Name");
  expectText(idx,"TestVisibleFields.IMMUTABLE","Id");
  expectText(idx,"TestVisibleFields.INTERNAL","CreatedDate");
});

test("unqualified references respect static and instance member scope",()=>{
  const idx=index(["ScopedFields.cls",[
    "public class ScopedFields {",
    " static final String STATIC_FIELD = 'Id';",
    " public final String INSTANCE_FIELD = 'Name';",
    " public String MUTABLE_INSTANCE = 'Phone';",
    "}",
  ].join("\n")]);
  assert.deepEqual(idx.resolveUnqualified("ScopedFields","STATIC_FIELD",true),
    {kind:"text",values:["Id"]});
  assert.deepEqual(idx.resolveUnqualified("ScopedFields","INSTANCE_FIELD",false),
    {kind:"text",values:["Name"]});
  const invalid=idx.resolveUnqualified("ScopedFields","INSTANCE_FIELD",true);
  assert.equal(invalid?.kind,"unknown");
  if(invalid?.kind==="unknown")assert.match(invalid.reason,/instance member.*static/i);
  const variable=idx.resolveUnqualified("ScopedFields","MUTABLE_INSTANCE",false);
  assert.deepEqual(variable,{kind:"text",values:["Phone"]});
  assert.equal(idx.resolveUnqualified("ScopedFields","NO_SUCH_FIELD",false),undefined);
});

test("snapshot policy resolves mutable aliases across unrelated classes without naming conventions",()=>{
  const idx=index(
    ["Names.cls","public class Names { global static String PREFIX = 'Order'; private static String SUFFIX = 'Summary'; public static String API = PREFIX + SUFFIX; }"],
    ["Settings.cls","public class Settings { public static String TARGET = Names.API; public String FIELD = 'Id'; public String MISSING; public String EMPTY = null; }"],
  );
  expectText(idx,"Settings.TARGET","OrderSummary");
  assert.deepEqual(idx.resolveInstance("Settings","FIELD"),{kind:"text",values:["Id"]});
  assert.equal(idx.resolveInstance("Settings","MISSING").kind,"unknown");
  assert.equal(idx.resolveInstance("Settings","EMPTY").kind,"unknown");
});

test("repository snapshot resolves nested maps, set/list copies and instance aliases",()=>{
  const idx=index(
    ["Fields.cls",[
      "public class Fields {",
      " public static String NAME = 'Name';",
      " public static List<String> BASE = new List<String>{'Id',NAME};",
      " private static Set<String> SET_FIELDS = new Set<String>{'Id','Id',NAME};",
      " public static Map<String,List<String>> GROUPS = new Map<String,List<String>>{'Account'=>BASE};",
      " public static Map<String,Map<String,String>> NESTED = new Map<String,Map<String,String>>{'Account'=>new Map<String,String>{'1'=>NAME,'2'=>'Phone'}};",
      " private List<String> own = new List<String>{'Email'};",
      " private List<String> ownCopy = new List<String>(own);",
      "}",
    ].join("\n")],
    ["Other.cls","public class Other { public static List<String> FIELDS = new List<String>(Fields.BASE); }"],
  );
  const list={kind:"collection",items:["Id","Name"],unique:false};
  assert.deepEqual(idx.resolve("Fields.BASE"),list);
  assert.deepEqual(idx.resolve("Other.FIELDS"),list);
  assert.deepEqual(idx.resolve("Fields.SET_FIELDS"),{kind:"collection",items:["Id","Name"],unique:true});
  assert.deepEqual(idx.resolve("Fields.GROUPS"),{kind:"map",entries:[["Account",list]]});
  assert.deepEqual(idx.resolve("Fields.NESTED"),{kind:"map",entries:[["Account",{kind:"map",entries:[["1",{kind:"text",values:["Name"]}],["2",{kind:"text",values:["Phone"]}]]}]]});
  assert.deepEqual(idx.resolveInstance("Fields","ownCopy"),{kind:"collection",items:["Email"],unique:false});
});
test("unknown collection initializer preserves its dependency",()=>{
  const idx=index(["Fields.cls","public class Fields { public static List<String> ITEMS = new List<String>{UnknownConfig.FIELD}; }"]);
  expectUnknown(idx,"Fields.ITEMS",/UnknownConfig.*missing/i);
});


test("straight-line static blocks establish blank static scalars and string collections",()=>{
  const idx=index(["BlockConfig.cls",[
    "public class BlockConfig {",
    "  static String OBJECT_NAME;",
    "  private static Set<String> FIELDS;",
    "  static { OBJECT_NAME = 'Acc' + 'ount'; FIELDS = new Set<String>{'Id','Name','Id'}; }",
    "  public static String getObject(){return OBJECT_NAME;}",
    "}",
  ].join("\n")]);
  expectText(idx,"BlockConfig.OBJECT_NAME","Account");
  assert.deepEqual(idx.resolve("BlockConfig.FIELDS"),{kind:"collection",items:["Id","Name"],unique:true});
  assert.deepEqual(idx.resolveUnqualified("BlockConfig","OBJECT_NAME",true),{kind:"text",values:["Account"]});
});

test("conditional, duplicate, forward and unsupported static-block assignments stay unknown",()=>{
  for(const [name,code] of [
    ["Conditional","static String FIELD; static { if (true) {FIELD = 'Id';} }"],
    ["Repeated","static String FIELD; static {FIELD='Id';} static {FIELD='Name';}"],
    ["Forward","static { FIELD='Id'; } static String FIELD;"],
    ["Helper","static String FIELD; static {FIELD = helper();}"],
    ["OtherEffect","static String FIELD; static {FIELD='Id'; System.debug('other effect');}"],
    ["InstanceOnly","String FIELD; { FIELD='Id'; }"],
  ]){
    const idx=index([name+".cls","public class "+name+" {"+code+"}"]);
    assert.equal(idx.resolve(name+".FIELD").kind,"unknown",name);
  }
});

test("direct writes invalidate newly inferred static-block snapshots",()=>{
  const idx=index(
    ["Config.cls",[
      "public class Config {",
      "  public static String FIELD;",
      "  public static List<String> FIELDS;",
      "  public static Integer COUNT;",
      "  public static String EXTERNAL;",
      "  public static String STABLE;",
      "  static {FIELD='Id'; FIELDS=new List<String>{'Id'}; COUNT=1; EXTERNAL='Id'; STABLE='Name';}",
      "  public static void change(){FIELD += 'x'; FIELDS.add('Name'); ++COUNT;}",
      "  public static void read(){Boolean b = STABLE == 'Name'; System.debug('STABLE = test');}",
      "}",
    ].join("\n")],
    ["Writer.cls","public class Writer { public static void change(){Config.EXTERNAL = 'Phone';} }"],
  );
  for(const name of ["FIELD","FIELDS","COUNT","EXTERNAL"])
    expectUnknown(idx,"Config."+name,/additional repository-visible writes/i);
  expectText(idx,"Config.STABLE","Name");
});

test("comments, nested blocks and map arrows do not invent a static initializer or mutation",()=>{
  const idx=index(["BlockMap.cls",[
    "public class BlockMap {",
    "  static String MISSING;",
    "  static String FIELD;",
    "  static { /* comment */ FIELD = 'Id'; }",
    "  // static { MISSING='Name'; }",
    "  public static Map<String,String> read(){ return new Map<String,String>{FIELD => 'Name'}; }",
    "  public class Inner { static { MISSING='Phone'; } }",
    "}",
  ].join("\n")]);
  expectText(idx,"BlockMap.FIELD","Id");
  expectUnknown(idx,"BlockMap.MISSING",/no declaration initializer/i);
});
