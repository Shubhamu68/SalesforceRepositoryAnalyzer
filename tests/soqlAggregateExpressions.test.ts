import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { writeSoqlReport } from "../src/reporter/soqlReportWriter.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { extractSoqlExpressionFields, normalizeApexConstructorBinds } from "../src/analyzer/soqlExpressionInventory.js";
import { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../src/analyzer/soqlQueryFieldResolver.js";
import { buildSoqlFieldInventory } from "../src/analyzer/soqlFieldInventoryBuilder.js";
import { SoqlSecurityAnalyzer } from "../src/analyzer/soqlSecurityAnalyzer.js";
import { OrgObjectReadVerificationService } from "../src/services/OrgObjectReadVerificationService.js";
import type { Persona } from "../src/models/Persona.js";
import type { PersonaPermissionResolver, ResolvedPersonaPermissions } from "../src/analyzer/PersonaPermissionResolver.js";
import type { SalesforcePersonaAccessVerifier } from "../src/salesforce/SalesforcePersonaAccessVerifier.js";

const parse = (soql: string) => {
  const matches = extractSoqlQueries("List<SObject> records = [" + soql + "];", "classes/Aggregate.cls");
  assert.equal(matches.length, 1);
  return matches[0];
};
const rawRefs = (soql: string) => {
  const result = extractSoqlExpressionFields(soql);
  assert.equal(result.parsed, true, result.limitations.join(" | "));
  return result;
};
const scope = (soql: string, relationships = new RelationshipMap()) =>
  collectQueryFields(parse(soql), relationships);
const fields = (soql: string, relationships = new RelationshipMap()) =>
  scope(soql, relationships).fields.map(x => x.object + "." + x.field);

test("all six aggregate families extract their actual fields, not function identifiers", () => {
  const data: Array<[string, string]> = [
    ["MAX(Quantity)", "Quantity"], ["MIN(Quantity)", "Quantity"],
    ["SUM(Amount)", "Amount"], ["AVG(Amount)", "Amount"],
    ["COUNT(Id)", "Id"], ["COUNT_DISTINCT(Client__c)", "Client__c"],
  ];
  for (const [expression, field] of data) {
    const soql = "SELECT " + expression + " result FROM Opportunity";
    const ref = rawRefs(soql).fields;
    assert.deepEqual(ref.map(x => x.fieldPath), [field], expression);
    assert.deepEqual(ref.map(x => x.context), ["SELECT"], expression);
    assert.deepEqual(fields(soql).map(x => x.toLowerCase()), field === "Id" ? [] : ["opportunity." + field.toLowerCase()], expression);
    assert.ok(!ref.some(x => /^(count|count_distinct|max|min|sum|avg)$/i.test(x.fieldPath)));
  }
});

test("COUNT() and COUNT(Id) preserve object Read without a spurious field FLS finding", () => {
  for (const expression of ["COUNT()", "COUNT(Id)"]) {
    const q = parse("SELECT " + expression + " FROM Account");
    const inventory = buildSoqlFieldInventory([q], new RelationshipMap());
    assert.ok(inventory.has("Account"));
    // Account.Id is in the snapshot and explicitly non-permissionable.
    // Retaining the Id reference is safe; access evaluation must not issue FLS.
    assert.deepEqual([...inventory.get("Account")!.keys()],
      expression === "COUNT()" ? [] : ["id"]);
    assert.equal(inventory.objectReferences.get("Account")?.length, 1);
  }
});

test("aggregate aliases are never treated as field names", () => {
  const q = "SELECT StageName, SUM(Amount) totalAmount, MAX(ExpectedRevenue) maxRevenue " +
    "FROM Opportunity GROUP BY StageName ORDER BY totalAmount DESC";
  const refs = rawRefs(q).fields;
  assert.deepEqual([...new Set(refs.map(x => x.fieldPath))],
    ["StageName", "Amount", "ExpectedRevenue"]);
  assert.deepEqual(fields(q), [
    "Opportunity.StageName", "Opportunity.Amount", "Opportunity.ExpectedRevenue"
  ]);
  assert.ok(!refs.some(x => x.fieldPath === "totalAmount" || x.fieldPath === "maxRevenue"));
  assert.ok(refs.some(x => x.context === "ORDER_BY" && x.fieldPath === "Amount"));
});

test("mixed-case aggregate functions and explicit aliases still resolve", () => {
  const q = "SELECT mAx(Net_Total__c) highValue, aVg(Price__c) averagePrice FROM Invoice__c";
  const refs = rawRefs(q);
  assert.deepEqual(refs.fields.map(x => x.fieldPath), ["Net_Total__c", "Price__c"]);
  assert.equal(refs.fields[0].functionName, "MAX");
});

test("SUM and COUNT_DISTINCT in grouped HAVING conditions produce field evidence", () => {
  const q = "SELECT StageName, SUM(Amount) total FROM Opportunity GROUP BY StageName " +
    "HAVING SUM(Amount) > 1000 AND COUNT_DISTINCT(AccountId) > 2";
  const refs = rawRefs(q).fields;
  assert.ok(refs.some(x => x.context === "HAVING" && x.fieldPath === "Amount"));
  assert.ok(refs.some(x => x.context === "HAVING" && x.fieldPath === "AccountId"));
  assert.deepEqual([...new Set(fields(q))].sort(), [
    "Opportunity.AccountId", "Opportunity.Amount", "Opportunity.StageName"
  ]);
});

test("GROUP BY ROLLUP and GROUPING extract only operand fields", () => {
  const q = "SELECT StageName, GROUPING(StageName) subtotal, SUM(Amount) total FROM Opportunity " +
    "GROUP BY ROLLUP(StageName) HAVING GROUPING(StageName) = 1";
  const refs = rawRefs(q).fields;
  assert.ok(refs.some(x => x.context === "GROUP_BY" && x.fieldPath === "StageName"));
  assert.ok(refs.some(x => x.context === "HAVING" && x.fieldPath === "StageName"));
  assert.deepEqual([...new Set(fields(q))].sort(), ["Opportunity.Amount", "Opportunity.StageName"]);
  assert.ok(!refs.some(x => ["ROLLUP", "GROUPING", "SUM"].includes(x.fieldPath)));
});

test("GROUP BY CUBE with two dimensions and aggregate is analyzed recursively", () => {
  const q = "SELECT StageName, Type, COUNT(Id) total FROM Opportunity GROUP BY CUBE(StageName, Type)";
  const r = rawRefs(q).fields;
  assert.deepEqual(r.filter(x => x.context === "GROUP_BY").map(x => x.fieldPath), ["StageName", "Type"]);
  assert.deepEqual([...new Set(fields(q))].sort(), ["Opportunity.StageName", "Opportunity.Type"]);
});

test("date grouping and date scalar functions extract their true field operands", () => {
  const cases = [
    "SELECT CALENDAR_YEAR(CloseDate) yr, SUM(Amount) total FROM Opportunity GROUP BY CALENDAR_YEAR(CloseDate)",
    "SELECT CALENDAR_MONTH(CloseDate) mon, COUNT(Id) total FROM Opportunity GROUP BY CALENDAR_MONTH(CloseDate)",
    "SELECT DAY_ONLY(CreatedDate) day FROM Opportunity",
    "SELECT FISCAL_YEAR(CloseDate) yr FROM Opportunity GROUP BY FISCAL_YEAR(CloseDate)",
  ];
  for (const q of cases) {
    const r = rawRefs(q);
    assert.ok(r.fields.some(f => f.fieldPath === (q.includes("CreatedDate") ? "CreatedDate" : "CloseDate")), q);
    assert.ok(!r.fields.some(f => /^CALENDAR_|^DAY_|^FISCAL_/i.test(f.fieldPath)), q);
  }
});

test("nested FORMAT(SUM(Amount)), TOLABEL and CONVERTCURRENCY traverse operand expression trees", () => {
  const q = "SELECT FORMAT(SUM(Amount)) formatted FROM Opportunity";
  assert.deepEqual(rawRefs(q).fields.map(f => f.fieldPath), ["Amount"]);
  assert.deepEqual(fields(q), ["Opportunity.Amount"]);
  for (const input of ["SELECT TOLABEL(StageName) stage FROM Opportunity",
    "SELECT CONVERTCURRENCY(Amount) converted FROM Opportunity"]) {
    assert.ok(rawRefs(input).fields.length === 1, input);
  }
});

test("DISTANCE/GEOLOCATION and quoted literals are not synthetic FLS fields", () => {
  const q = "SELECT Id FROM Account WHERE DISTANCE(BillingAddress, GEOLOCATION(40, -72), 'mi') < 100";
  const refs = rawRefs(q).fields;
  assert.ok(refs.some(x => x.context === "WHERE" && x.fieldPath === "BillingAddress"));
  assert.ok(!refs.some(x => ["GEOLOCATION", "mi", "DISTANCE", "40"].includes(x.fieldPath)));
});

test("Aggregate references to parent-object fields use the shared relationship map", () => {
  const graph = new RelationshipMap();
  graph.addParent("Opportunity", "Account", ["Account"], "AccountId");
  graph.addParent("Account", "Owner", ["User"], "OwnerId");
  const q = "SELECT Account.Owner.Email, MAX(Amount) highest FROM Opportunity GROUP BY Account.Owner.Email";
  const c = scope(q, graph);
  assert.deepEqual(c.unresolved, []);
  assert.ok(c.fields.some(x => x.object === "User" && x.field === "Email"));
  assert.ok(c.fields.some(x => x.object === "Opportunity" && x.field === "Amount"));
  assert.ok(c.objects.includes("Account") && c.objects.includes("User"));
});

test("Aggregate fields in child relationship SELECTs resolve to the correct object", () => {
  const graph = new RelationshipMap();
  graph.addChild("Account", "Opportunities", "Opportunity");
  const q = "SELECT Name, (SELECT MAX(Amount) high, COUNT(Id) total FROM Opportunities) FROM Account";
  const c = scope(q, graph);
  assert.deepEqual(c.unresolved, []);
  assert.ok(c.fields.some(x => x.object === "Opportunity" && x.field === "Amount"));
  assert.ok(c.fields.some(x => x.object === "Account" && x.field === "Name"));
  assert.ok(!c.fields.some(x => x.field === "MAX"));
  assert.equal(parse(q).subqueries[0]?.relationshipName, "Opportunities");
});

test("Semi-join fields are checked in child scope, without mixing aggregates into parent", () => {
  const graph = new RelationshipMap();
  const q = "SELECT Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email != null)";
  const c = scope(q, graph);
  assert.deepEqual(c.unresolved, []);
  assert.ok(c.fields.some(x => x.object === "Contact" && x.field === "Email"));
  assert.ok(c.fields.some(x => x.object === "Contact" && x.field === "AccountId"));
  assert.ok(c.fields.some(x => x.object === "Account" && x.field === "Name"));
});

test("Apex generic constructor binds are normalized without suppressing real predicates", () => {
  const soql = "SELECT Id FROM Shipment__c WHERE OrderSummary__c IN :mapOfOrderSummaries.keySet() " +
    "AND Status__c IN :new Set<String>{'Draft', 'Discrepancy'} WITH USER_MODE";
  const normalized = normalizeApexConstructorBinds(soql);
  assert.ok(normalized.includes(":analyzerApexBind"));
  assert.ok(!normalized.includes("Set<String>"));
  const refs = rawRefs(soql).fields;
  assert.deepEqual(refs.filter(x => x.context === "WHERE").map(x => x.fieldPath),
    ["OrderSummary__c", "Status__c"]);
  assert.ok(!refs.some(x => x.fieldPath === "String" || x.fieldPath === "set"));
});

test("Nested Apex generic Map constructor is normalized before syntax parsing", () => {
  const soql = "SELECT Id FROM Shipment__c WHERE Status__c IN " +
    ":new Map<String, Set<Id>>{}.keySet() AND OrderSummary__c = :osId";
  assert.ok(!normalizeApexConstructorBinds(soql).includes("Set<Id>"));
  assert.deepEqual(rawRefs(soql).fields.filter(x => x.context === "WHERE").map(x => x.fieldPath),
    ["Status__c", "OrderSummary__c"]);
});

test("Column source context is preserved for SELECT, GROUP BY, HAVING and ORDER BY", () => {
  const q = "SELECT StageName, SUM(Amount) total\nFROM Opportunity\nGROUP BY StageName\n" +
    "HAVING SUM(Amount) > 1000\nORDER BY SUM(Amount) DESC";
  const collection = scope(q);
  assert.ok(collection.references.some(x => x.usageContext === "SELECT" && x.field === "Amount"));
  assert.ok(collection.references.some(x => x.usageContext === "GROUP_BY" && x.field === "StageName"));
  assert.ok(collection.references.some(x => x.usageContext === "HAVING" && x.field === "Amount"));
  assert.ok(collection.references.some(x => x.usageContext === "ORDER_BY" && x.field === "Amount"));
  assert.ok(collection.references.some(x => x.source.startsWith("HAVING")));
});

test("Quoted and commented SOQL-looking text is ignored, including aggregate names", () => {
  const query = "SELECT Name FROM Account WHERE Description = 'MAX(Secret__c)' AND Industry = 'Technology'";
  const refs = rawRefs(query).fields;
  assert.ok(refs.some(x => x.fieldPath === "Name"));
  assert.ok(refs.some(x => x.fieldPath === "Industry"));
  assert.ok(refs.some(x => x.fieldPath === "Description"));
  assert.ok(!refs.some(x => x.fieldPath === "Secret__c" || x.fieldPath === "MAX"));
});

test("SELECT COUNT() leaves the object in the field inventory and no fake fields", () => {
  const query = parse("SELECT COUNT() FROM Opportunity");
  const i = buildSoqlFieldInventory([query], new RelationshipMap());
  assert.ok(i.has("Opportunity"));
  assert.equal(i.get("Opportunity")?.size, 0);
  assert.equal(i.objectReferences.get("Opportunity")?.length, 1);
});

test("Invalid/unrecognized aggregate expression is flagged rather than marked clean", () => {
  const result = extractSoqlExpressionFields("SELECT SUM( FROM Opportunity");
  assert.equal(result.parsed, false);
  assert.ok(result.limitations.some(x => /parse incomplete/i.test(x)));
  // The scanner cannot locate FROM inside an unclosed '(' expression.
  // Direct callers must still retain an explicit parser limitation.
  const q = { ...parse("SELECT Name FROM Opportunity"), query: "SELECT SUM( FROM Opportunity", fields: [] };
  const c = collectQueryFields(q, new RelationshipMap());
  assert.ok(c.limitations.some(x => /parse incomplete/i.test(x)));
});

test("No aggregate is accidentally interpreted as an object or field API name", () => {
  const qs = [
    "SELECT MAX(Amount) maxValue FROM Opportunity",
    "SELECT MIN(Amount) minValue FROM Opportunity",
    "SELECT COUNT_DISTINCT(AccountId) amount FROM Opportunity",
    "SELECT StageName, SUM(Amount) total FROM Opportunity GROUP BY StageName HAVING AVG(Amount) > 500",
  ];
  for (const q of qs) {
    const c = scope(q);
    assert.ok(c.unresolvedEntries.every(x => !/^(MAX|MIN|SUM|AVG|COUNT|COUNT_DISTINCT)$/i.test(x.fieldPath)), q);
    assert.ok(c.fields.every(x => !/^(MAX|MIN|SUM|AVG|COUNT|COUNT_DISTINCT)$/i.test(x.field)), q);
  }
});

test("SOQL Read enforcement checks the real aggregate operand under USER_MODE", async () => {
  const persona: Persona = { name: "Analyst", profile: undefined,
    permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const ps = {
    name: "PS", label: "PS",
    objectPermissions: [{ object: "Opportunity", allowRead: true, allowCreate: false,
      allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false }],
    fieldPermissions: [],
  };
  const resolved = { persona, permissionSetGroups: [], directPermissionSets: [ps],
    permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }], mutingPermissionSets: [],
    mutesByGroup: new Map() } as unknown as ResolvedPersonaPermissions;
  const resolver = { resolve: async () => resolved } as unknown as PersonaPermissionResolver;
  const calls: string[] = [];
  const verifier = {
    getVerificationScope: () => "aggregate-test",
    verifyObjectRead: async () => { throw new Error("Already granted in repository"); },
    verifyFieldRead: async (_p: Persona, object: string, field: string) => {
      calls.push(object + "." + field);
      return { object, field, outcome: "DENIED" as const, matchedUsers: 1, checkedUsers: 1, sampled: false,
        message: "Salesforce denied access" };
    },
  } as unknown as SalesforcePersonaAccessVerifier;
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-aggregate-test-"));
  try {
    const file = path.join(dir, "Aggregate.cls");
    await writeFile(file + "-meta.xml", "<ApexClass><apiVersion>66.0</apiVersion></ApexClass>");
    const query = extractSoqlQueries("List<AggregateResult> agg = [SELECT MAX(Amount) value " +
      "FROM Opportunity WITH USER_MODE];", file);
    const results = await new SoqlSecurityAnalyzer(resolver, dir,
      new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, verifier)).analyze(persona, query);
    assert.equal(results.length, 1);
    assert.equal(results[0].object, "Opportunity");
    assert.equal(results[0].field, "Amount");
    assert.equal(results[0].criticality, "High");
    assert.equal(results[0].verificationSource, "ORG_DENIED");
    assert.deepEqual(calls, ["Opportunity.Amount"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("all aggregate functions used on one field preserve references but dedupe Salesforce FLS checks", () => {
  const q = parse("SELECT SUM(Amount) total, AVG(Amount) average, MIN(Amount) minimum, MAX(Amount) maximum FROM Opportunity");
  const collection = collectQueryFields(q, new RelationshipMap());
  assert.equal(collection.references.filter(ref => ref.field === "Amount").length, 4);
  const inventory = buildSoqlFieldInventory([q], new RelationshipMap());
  assert.deepEqual([...inventory.get("Opportunity")!.keys()], ["amount"]);
  assert.equal(extractSoqlQueries("List<AggregateResult> a=[SELECT MAX(Amount) FROM Opportunity];", "classes/C.cls").length, 1);
});

test("FORMULA() in WHERE checks both operand fields and never a synthetic FORMULA field", () => {
  const q = "SELECT Id FROM Opportunity WHERE FORMULA('Amount - ExpectedRevenue') > 100";
  const result = extractSoqlExpressionFields(q);
  assert.equal(result.parsed, true, result.limitations.join("; "));
  assert.deepEqual(result.fields.filter(ref => ref.context === "WHERE").map(ref => ref.fieldPath),
    ["Amount", "ExpectedRevenue"]);
  assert.ok(!result.fields.some(ref => ref.fieldPath === "FORMULA"));
});

test("dynamic FIELDS() projection produces an explicit review limitation", () => {
  const result = extractSoqlExpressionFields("SELECT FIELDS(ALL) FROM Account");
  assert.ok(result.limitations.length > 0,
    "FIELDS(ALL) must not silently skip field-level access analysis");
  assert.ok(result.fields.every(ref => ref.fieldPath !== "ALL" && ref.fieldPath !== "FIELDS"));
});

test("source lines for SELECT aggregate and HAVING-only aggregate remain distinct", () => {
  const q = parse("SELECT StageName, SUM(Amount) amount\nFROM Opportunity\nGROUP BY StageName\n" +
    "HAVING MAX(ExpectedRevenue) > 1000\nORDER BY StageName");
  const c = collectQueryFields(q, new RelationshipMap());
  const select = c.references.find(ref => ref.field === "Amount" && ref.usageContext === "SELECT");
  const having = c.references.find(ref => ref.field === "ExpectedRevenue" && ref.usageContext === "HAVING");
  assert.equal(select?.lineNumber, 1);
  assert.equal(having?.lineNumber, 4);
  assert.equal(having?.queryLineNumber, 1);
});

test("multi-level aggregate references preserve child field and parent source lines", () => {
  const graph = new RelationshipMap();
  graph.addChild("Account", "Opportunities", "Opportunity");
  const query = parse("SELECT Name,\n(SELECT MAX(Amount) peak,\n SUM(ExpectedRevenue) total FROM Opportunities)\nFROM Account");
  const c = collectQueryFields(query, graph);
  assert.equal(query.subqueries[0].lineNumber, 2);
  assert.deepEqual([...new Set(c.fields.map(f => f.object + "." + f.field))],
    ["Account.Name", "Opportunity.Amount", "Opportunity.ExpectedRevenue"]);
  assert.ok(c.references.some(f => f.object === "Opportunity" && f.field === "ExpectedRevenue" && f.lineNumber === 3));
});

test("unsupported function syntax is a parse limitation, not a false field-permission denial", () => {
  const q = parse("SELECT Name FROM Account");
  q.query = "SELECT UNKNOWNFUNC(Secret__c) FROM Account";
  const c = collectQueryFields(q, new RelationshipMap());
  assert.ok(c.limitations.length > 0);
  assert.ok(c.unresolvedEntries.every(x => x.fieldPath !== "UNKNOWNFUNC"));
});

test("SECURITY_ENFORCED does not mark a HAVING-only denied field as High", async () => {
  const persona: Persona = { name: "Analyst", profile: undefined,
    permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const ps = { name: "PS", label: "PS", objectPermissions: [
    { object: "Opportunity", allowRead: true, allowCreate: false, allowEdit: false,
      allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false },
  ], fieldPermissions: [] };
  const resolver = { resolve: async () => ({ persona, permissionSetGroups: [], directPermissionSets: [ps],
    permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }], mutingPermissionSets: [],
    mutesByGroup: new Map() }) } as unknown as PersonaPermissionResolver;
  const mock = {
    getVerificationScope: () => "test-org",
    verifyObjectRead: async () => { throw new Error("Already granted from repository"); },
    verifyFieldRead: async (_p: Persona, object: string, field: string) => ({
      object, field, outcome: "DENIED" as const, checkedUsers: 1, matchedUsers: 1,
      sampled: false, message: "Salesforce denied Read",
    }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-aggregate-security-"));
  try {
    const file = path.join(dir, "Aggregate.cls");
    await writeFile(file + "-meta.xml", "<ApexClass><apiVersion>66.0</apiVersion></ApexClass>");
    const soql = "SELECT StageName, COUNT(Id) FROM Opportunity WITH SECURITY_ENFORCED " +
      "GROUP BY StageName HAVING SUM(Amount) > 100";
    const result = await new SoqlSecurityAnalyzer(resolver, dir,
      new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, mock))
      .analyze(persona, extractSoqlQueries("List<AggregateResult> r=[" + soql + "];", file));
    const select = result.find(f => f.field === "StageName");
    const having = result.find(f => f.field === "Amount");
    assert.equal(select?.criticality, "High");
    assert.equal(having?.criticality, "Low");
    assert.equal(having?.runtimeImpact, "Undetermined");
    assert.match(having?.reason ?? "", /outside SELECT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Excel report records the real MAX operand and never creates an OrderItemSummary.MAX row", async () => {
  const persona: Persona = { name: "OTC", profile: undefined,
    permissionSets: [], permissionSetGroups: [], mutingPermissionSets: [] };
  const ps = { name: "PS", label: "PS", objectPermissions: [{
    object: "OrderItemSummary", allowRead: true, allowCreate: false, allowEdit: false,
    allowDelete: false, viewAllRecords: false, modifyAllRecords: false, viewAllFields: false
  }], fieldPermissions: [] };
  const resolver = { resolve: async () => ({ persona, permissionSetGroups: [], directPermissionSets: [ps],
    permissionSetGrants: [{ permissionSet: ps, type: "directPermissionSet" }],
    mutingPermissionSets: [], mutesByGroup: new Map() }) } as unknown as PersonaPermissionResolver;
  const mock = { getVerificationScope: () => "test",
    verifyObjectRead: async () => { throw Error("Object permission was provided in the repository"); },
    verifyFieldRead: async (_p: Persona, object: string, field: string) => ({
      object, field, outcome: "DENIED" as const, matchedUsers: 1, checkedUsers: 1,
      sampled: false, message: "Access denied",
    }),
  } as unknown as SalesforcePersonaAccessVerifier;
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-aggregate-excel-"));
  try {
    const file = path.join(dir, "OMSQueryService.cls");
    await writeFile(file + "-meta.xml", "<ApexClass><apiVersion>66.0</apiVersion></ApexClass>");
    const queries = extractSoqlQueries(
      "List<AggregateResult> result = [SELECT MAX(Net_Extended_Total__c) maximum " +
      "FROM OrderItemSummary WITH USER_MODE];", file);
    const findings = await new SoqlSecurityAnalyzer(resolver, dir,
      new OrgObjectReadVerificationService({ statusNeutralObjectRead: new Set() }, mock)).analyze(persona, queries);
    assert.deepEqual(findings.filter(f => f.findingType === "FIELD_READ").map(f => f.field),
      ["Net_Extended_Total__c"]);
    const saved = await writeSoqlReport(dir, persona.name, queries.length, findings);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(saved.summaryReportPath);
    const sheet = book.getWorksheet("Summary")!;
    assert.equal(sheet.getCell("B3").value, 1);
    assert.equal(sheet.getCell("B7").value, "Net_Extended_Total__c");
    assert.equal(sheet.getCell("E7").value, "High");
    const json = sheet.getSheetValues().map(row => JSON.stringify(row)).join("\n");
    assert.doesNotMatch(json, /"MAX"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
