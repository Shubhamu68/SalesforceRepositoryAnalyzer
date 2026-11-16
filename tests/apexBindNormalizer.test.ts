import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApexBindExpressions } from "../src/analyzer/apexBindNormalizer.js";
import { extractSoqlExpressionFields } from "../src/analyzer/soqlExpressionInventory.js";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../src/analyzer/soqlQueryFieldResolver.js";
import { buildSoqlFieldInventory } from "../src/analyzer/soqlFieldInventoryBuilder.js";

/** Real-world queries that previously generated bogus SOQL syntax Review rows. */
const aggregateApexBind = `SELECT Product2Id, COUNT(Id) recordCount, MAX(LastModifiedDate) lastModified
                    FROM OrderItemSummary
                    WHERE OrderSummary.Client__c = :client
                    AND OrderSummary.AccountId = :customer
                    AND Status != :AdvantageConstants.CANCELED
                    AND LastModifiedDate >= :System.today().addDays(-daysLimit)
                    GROUP BY Product2Id
                    ORDER BY MAX(LastModifiedDate) DESC
                    LIMIT :maxResults`;

const constantsInList = `SELECT Id, OrderNumber
                FROM OrderSummary
                WHERE OrderNumber IN :orderNumberSet
                AND Id NOT IN :currentOsIdSet
                AND RecordType.Name IN (:AdvantageConstants.CORE, :AdvantageConstants.OTC)
                LIMIT 50000`;

const spacedBinds = `SELECT Id, Client_Promo_Ref__c, Rate__c, Basis__c, UOM__c, Delivery_Condition__c FROM Promotion_Allowance__c
                    WHERE Client_Promo_Ref__c IN: setPromoMasterIds AND Rate__c IN: setRate AND Basis__c IN: setBasis
                    AND UOM__c IN: setUOM AND Delivery_Condition__c IN: setDelivery AND Is_Active__c =: true WITH SECURITY_ENFORCED`;

function parseFromApex(query: string) {
  const source = "public class QueryTest {\n" +
    "  public static void run() {\n" +
    "    List<SObject> rows = [\n" + query + "\n    ];\n" +
    "  }\n}";
  const result = extractSoqlQueries(source, "classes/OMSQueryService.cls");
  assert.equal(result.length, 1, "one static SOQL query must be discovered");
  return { query: result[0], source };
}
const inventoryFor = (text: string, graph = new RelationshipMap()) => {
  const q = parseFromApex(text).query;
  const c = collectQueryFields(q, graph);
  const limits: string[] = [];
  const inventory = buildSoqlFieldInventory([q], graph, undefined,
    (_query, issue) => limits.push(issue));
  return { q, c, limits, inventory };
};

test("actual aggregate query with chained Apex date calculation has no parser limitations", () => {
  const map = new RelationshipMap();
  map.addParent("OrderItemSummary", "OrderSummary", ["OrderSummary"], "OrderSummaryId");
  const { q, c, limits, inventory } = inventoryFor(aggregateApexBind, map);
  assert.deepEqual(c.limitations, []);
  assert.deepEqual(limits, []);
  assert.deepEqual(c.unresolved, []);
  assert.equal(q.securityMode, "UNSPECIFIED");
  const names = c.fields.map(f => f.object + "." + f.field);
  for (const expected of [
    "OrderItemSummary.Product2Id", "OrderItemSummary.Id",
    "OrderItemSummary.LastModifiedDate", "OrderItemSummary.Status",
    "OrderSummary.Client__c", "OrderSummary.AccountId",
  ]) assert.ok(names.includes(expected), expected);
  for (const invalid of ["recordCount", "lastModified", "MAX", "COUNT", "System", "today",
    "addDays", "daysLimit", "client", "customer", "CANCELED", "maxResults"]) {
    assert.ok(!names.some(name => name.endsWith("." + invalid)), invalid);
  }
  assert.ok(c.references.some(ref => ref.functionName === "MAX" && ref.field === "LastModifiedDate"));
  assert.ok(c.references.some(ref => ref.usageContext === "GROUP_BY" && ref.field === "Product2Id"));
  assert.ok(inventory.get("OrderSummary")?.has("client__c"));
});

test("two Apex constants in a parenthesized IN list do not become SOQL fields", () => {
  const map = new RelationshipMap();
  map.addParent("OrderSummary", "RecordType", ["RecordType"], "RecordTypeId");
  const { q, c, limits } = inventoryFor(constantsInList, map);
  assert.deepEqual(c.limitations, []);
  assert.deepEqual(limits, []);
  assert.deepEqual(c.unresolved, []);
  assert.equal(q.object, "OrderSummary");
  // The syntax tree must retain the relationship; the existing system-field
  // rule can exclude Name from configurable FLS checks.
  assert.ok(extractSoqlExpressionFields(constantsInList).fields.some(
    x => x.fieldPath === "RecordType.Name" && x.context === "WHERE"));
  assert.ok(c.objects.includes("RecordType"));
  assert.ok(c.fields.some(x => x.object === "OrderSummary" && x.field === "OrderNumber"));
  assert.ok(!c.fields.some(x => x.object === "AdvantageConstants" ||
    x.field === "CORE" || x.field === "OTC"));
  assert.equal(q.lineNumber, 3, "the original Apex start line must be preserved");
});

test("IN: variable, =: true, and SECURITY_ENFORCED are handled without parser warnings", () => {
  const { q, c, limits } = inventoryFor(spacedBinds);
  assert.deepEqual(c.limitations, []);
  assert.deepEqual(limits, []);
  assert.deepEqual(c.unresolved, []);
  assert.equal(q.securityMode, "SECURITY_ENFORCED");
  assert.deepEqual([...new Set(c.fields.map(x => x.field))].sort(),
    ["Basis__c", "Client_Promo_Ref__c", "Delivery_Condition__c",
      "Is_Active__c", "Rate__c", "UOM__c"].sort());
  assert.ok(extractSoqlExpressionFields(spacedBinds).fields.some(x => x.fieldPath === "Id"));
  assert.ok(c.references.some(x => x.field === "Is_Active__c" && x.usageContext === "WHERE"));
  assert.ok(!c.fields.some(x => x.field === "true" || x.field === "setRate"));
});

test("method chaining and unary negative values are isolated inside Apex binds", () => {
  const cases = [
    [":System.today().addDays(-daysLimit)", ":analyzerApexBind"],
    [":Date.today().addMonths(-3)", ":analyzerApexBind"],
    [":CalendarUtil.adjust(Date.today(), -offset)", ":analyzerApexBind"],
    [":mapOfOrderSummaries.keySet()", ":analyzerApexBind"],
    [":new Set<String>{'Draft', 'Discrepancy'}", ":analyzerApexBind"],
    [":new Map<String, Set<Id>>{}.keySet()", ":analyzerApexBind"],
    [":obj?.resolve()[0].value", ":analyzerApexBind"],
  ];
  for (const [expression, expected] of cases) {
    const q = "SELECT Id FROM Account WHERE Name = " + expression;
    const result = normalizeApexBindExpressions(q);
    assert.equal(result.count, 1, expression);
    assert.deepEqual(result.limitations, [], expression);
    assert.ok(result.query.endsWith(expected), expression);
    const parsed = extractSoqlExpressionFields(q);
    assert.equal(parsed.parsed, true, parsed.limitations.join("; ") + ": " + expression);
    assert.deepEqual(parsed.fields.filter(x => x.context === "WHERE").map(x => x.fieldPath), ["Name"]);
  }
});

test("parenthesized IN lists normalize Apex values to literal tokens without affecting predicates", () => {
  const q = "SELECT Id FROM OrderSummary WHERE RecordType.Name IN " +
    "(:AdvantageConstants.CORE, :AdvantageConstants.OTC, 'Other') AND OrderNumber = :po";
  const value = normalizeApexBindExpressions(q);
  assert.equal(value.count, 3);
  assert.deepEqual(value.limitations, []);
  assert.match(value.query, /IN\s*\('analyzerApexBind',\s*'analyzerApexBind',\s*'Other'\)/);
  assert.ok(value.query.includes("OrderNumber = :analyzerApexBind"));
  const fields = extractSoqlExpressionFields(q);
  assert.equal(fields.parsed, true, fields.limitations.join("; "));
  assert.ok(fields.fields.some(ref => ref.fieldPath === "RecordType.Name"));
  assert.ok(fields.fields.some(ref => ref.fieldPath === "OrderNumber"));
});

test("IN: var, IN :var, NOT IN :var, =:false, and bind in LIMIT/OFFSET all parse", () => {
  const cases = [
    "SELECT Id FROM Account WHERE Name IN: names",
    "SELECT Id FROM Account WHERE Name IN :names",
    "SELECT Id FROM Account WHERE Id NOT IN :blockedIds",
    "SELECT Id FROM Account WHERE IsActive__c =:false",
    "SELECT Id FROM Account WHERE IsActive__c =: true",
    "SELECT Id FROM Account LIMIT :maxResults",
    "SELECT Id FROM Account LIMIT :maxResults OFFSET :startOffset",
  ];
  for (const soql of cases) {
    const result = extractSoqlExpressionFields(soql);
    assert.equal(result.parsed, true, soql + ": " + result.limitations.join("; "));
    assert.deepEqual(result.limitations, [], soql);
  }
});

test("SOQL date literals, time fragments, strings, and comments are never interpreted as binds", () => {
  const q = "SELECT Name FROM Account WHERE CreatedDate = LAST_N_DAYS:30 " +
    "AND Name = 'text :notABind' /* :commentOnly */ " +
    "AND Description = :description // :ignored\nAND Industry = :industry";
  const normalized = normalizeApexBindExpressions(q);
  assert.equal(normalized.count, 2);
  assert.ok(normalized.query.includes("LAST_N_DAYS:30"));
  assert.ok(normalized.query.includes("'text :notABind'"));
  assert.ok(normalized.query.includes("/* :commentOnly */"));
  assert.ok(normalized.query.includes("// :ignored"));
  assert.equal(normalized.query.split("\n").length, q.split("\n").length);
});

test("semi-join subqueries do not convert their ordinary WHERE binds into IN-list literals", () => {
  const q = "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email = :emailAddress)";
  const normalized = normalizeApexBindExpressions(q);
  assert.ok(normalized.query.includes("Email = :analyzerApexBind"));
  assert.ok(!normalized.query.includes("Email = 'analyzerApexBind'"));
  const { c } = inventoryFor(q);
  assert.ok(c.fields.some(x => x.object === "Contact" && x.field === "Email"));
  assert.deepEqual(c.limitations, []);
});

test("multiline Apex expression normalization retains newline counts and original source lines", () => {
  const q = "SELECT Id FROM Opportunity WHERE CloseDate < :System.today()\n" +
    "  .addDays(\n    -daysLimit\n  ) AND StageName = :status";
  const normalized = normalizeApexBindExpressions(q);
  assert.equal(normalized.count, 2);
  assert.equal(normalized.query.split("\n").length, q.split("\n").length);
  assert.equal(extractSoqlExpressionFields(q).parsed, true);
  const { c } = inventoryFor(q);
  assert.deepEqual(c.limitations, []);
  assert.ok(c.references.some(x => x.field === "StageName" && x.usageContext === "WHERE"));
});

test("unbalanced Apex constructors/method calls retain a Review instead of inventing permission grants", () => {
  const invalid = [
    "SELECT Id FROM Account WHERE Name = :new Set<String>{'a'",
    "SELECT Id FROM Account WHERE CreatedDate = :System.today().addDays(-n",
  ];
  for (const query of invalid) {
    const normalized = normalizeApexBindExpressions(query);
    assert.ok(normalized.limitations.length > 0, query);
    const parsed = extractSoqlExpressionFields(query);
    assert.equal(parsed.parsed, false);
    assert.ok(parsed.limitations.some(v => /bind expression/i.test(v)));
  }
});

test("backwards compatibility with aggregate syntax and constructors remains intact", () => {
  const q = "SELECT MAX(LastModifiedDate) peak, COUNT(Id) quantity FROM OrderItemSummary " +
    "WHERE Status IN :new Set<String>{'Draft', 'Discrepancy'} GROUP BY Product2Id " +
    "HAVING COUNT(Id) > 0 ORDER BY MAX(LastModifiedDate) DESC";
  const result = extractSoqlExpressionFields(q);
  assert.equal(result.parsed, true, result.limitations.join("; "));
  assert.ok(result.fields.some(v => v.fieldPath === "LastModifiedDate" && v.functionName === "MAX"));
  assert.ok(result.fields.some(v => v.fieldPath === "Product2Id" && v.context === "GROUP_BY"));
  assert.ok(!result.fields.some(v => ["Set", "String", "MAX", "COUNT"].includes(v.fieldPath)));
});
