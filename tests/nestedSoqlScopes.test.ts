import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSoqlQueries } from "../src/scanner/apexSoqlScanner.js";
import { RelationshipMap } from "../src/analyzer/salesforceRelationshipResolver.js";
import { collectQueryFields } from "../src/analyzer/soqlQueryFieldResolver.js";
import { buildSoqlFieldInventory } from "../src/analyzer/soqlFieldInventoryBuilder.js";

const parse = (soql: string) => {
  const queries = extractSoqlQueries("List<SObject> rows = [" + soql + "];", "classes/Nested.cls");
  assert.equal(queries.length, 1);
  return queries[0];
};
const graph = () => {
  const map = new RelationshipMap();
  map.addChild("Account", "Contacts", "Contact");
  map.addChild("Account", "Opportunities", "Opportunity");
  map.addChild("Contact", "Cases", "Case");
  map.addParent("Contact", "Account", ["Account"], "AccountId");
  return map;
};
const names = (q: ReturnType<typeof parse>, map = graph()) =>
  collectQueryFields(q, map).fields.map(item => item.object + "." + item.field);

test("one root query retains two sibling relationship SELECTs", () => {
  const q = parse("SELECT Id, (SELECT LastName FROM Contacts), (SELECT StageName FROM Opportunities) FROM Account");
  assert.equal(q.subqueries.length, 2);
  assert.deepEqual(q.subqueries.map(s => s.kind), ["CHILD", "CHILD"]);
  assert.deepEqual(q.subqueries.map(s => s.relationshipName), ["Contacts", "Opportunities"]);
  assert.deepEqual(names(q), ["Contact.LastName", "Opportunity.StageName"]);
  assert.ok(collectQueryFields(q, graph()).queriedObjects.includes("Account"), "root object Read remains required");
});
test("nested SELECT scopes resolve child of child", () => {
  const q = parse("SELECT Name, (SELECT LastName, (SELECT Subject FROM Cases) FROM Contacts) FROM Account");
  assert.equal(q.subqueries[0].subqueries.length, 1);
  assert.deepEqual(names(q), ["Account.Name", "Contact.LastName", "Case.Subject"]);
});
test("four descendant levels are represented without flattening into fields", () => {
  const q = parse("SELECT Name, (SELECT LastName, (SELECT Subject, (SELECT Body, (SELECT Grandchild_Field__c FROM Grandchildren__r) FROM Comments__r) FROM Cases) FROM Contacts) FROM Account");
  const m = graph();
  m.addChild("Case", "Comments__r", "Comment__c");
  m.addChild("Comment__c", "Grandchildren__r", "Grandchild__c");
  assert.deepEqual(names(q, m), ["Account.Name", "Contact.LastName", "Case.Subject", "Comment__c.Body", "Grandchild__c.Grandchild_Field__c"]);
});
test("self-referencing ChildAccounts resolves without circular graph traversal", () => {
  const m = graph(); m.addChild("Account", "ChildAccounts", "Account");
  const q = parse("SELECT Name, (SELECT Name, (SELECT Name FROM ChildAccounts) FROM ChildAccounts) FROM Account");
  const c = collectQueryFields(q, m);
  assert.equal(c.unresolved.length, 0);
  assert.equal(c.scopes.length, 3);
  assert.ok(c.references.some(f => f.relationshipPath.includes("ChildAccounts")));
});
test("custom parent-to-child relationship is resolved strictly from metadata", () => {
  const m = graph(); m.addChild("Account", "Orders__r", "Order__c");
  assert.ok(names(parse("SELECT Name, (SELECT Amount__c FROM Orders__r) FROM Account"), m).includes("Order__c.Amount__c"));
});
test("two different relationships to same child object preserve distinct paths", () => {
  const m = graph(); m.addChild("Account", "PrimaryOrders__r", "Order__c"); m.addChild("Account", "SecondaryOrders__r", "Order__c");
  const c = collectQueryFields(parse("SELECT Name, (SELECT Amount__c FROM PrimaryOrders__r), (SELECT Amount__c FROM SecondaryOrders__r) FROM Account"), m);
  assert.equal(c.references.filter(x => x.object === "Order__c").length, 2);
  assert.notEqual(c.references[1].relationshipPath, c.references[2].relationshipPath);
});
test("semi-join FROM names represent actual objects, not relationship aliases", () => {
  const q = parse("SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email != null)");
  assert.equal(q.subqueries[0].kind, "SEMI_JOIN");
  assert.equal(q.subqueries[0].relationshipName, "Contact");
  const c = collectQueryFields(q, graph());
  assert.ok(c.queriedObjects.includes("Contact"));
  assert.ok(c.fields.some(f => f.object === "Contact" && f.field === "Email"));
  assert.ok(c.fields.some(f => f.object === "Contact" && f.field === "AccountId"));
});
test("NOT IN semi-join is classified as ANTI_JOIN", () => {
  const q = parse("SELECT Id FROM Account WHERE Id NOT IN (SELECT AccountId FROM Contact)");
  assert.equal(q.subqueries[0].kind, "ANTI_JOIN");
});
test("subquery WHERE and ORDER BY fields use the child scope, not Account", () => {
  const q = parse("SELECT Name, (SELECT LastName FROM Contacts WHERE Email != null ORDER BY LastName) FROM Account");
  const c = collectQueryFields(q, graph());
  assert.ok(c.fields.some(f => f.object === "Contact" && f.field === "Email"));
  assert.ok(c.references.some(f => f.object === "Contact" && f.source.startsWith("WHERE ")));
  assert.ok(!c.fields.some(f => f.object === "Account" && f.field === "Email"));
});
test("deep parent path inside child query resolves final field object", () => {
  const q = parse("SELECT Name, (SELECT Account.Owner.Email FROM Contacts) FROM Account");
  const m = graph();
  m.addParent("Account", "Owner", ["User"], "OwnerId");
  assert.ok(names(q,m).includes("User.Email"));
});
test("quoted subquery text in a predicate is ignored as executable SOQL", () => {
  const q = parse("SELECT Name FROM Account WHERE Description = '(SELECT Id FROM Contacts)'");
  assert.equal(q.subqueries.length, 0);
});
test("SOQL-looking text inside Apex string or comments is ignored", () => {
  const source = "'[SELECT Id, (SELECT LastName FROM Contacts) FROM Account]';\n" +
    "// [SELECT Name FROM Account]\n/* [SELECT Name FROM Account] */\n" +
    "List<Account> real = [SELECT Name FROM Account];";
  const queries = extractSoqlQueries(source, "classes/Example.cls");
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].fields, ["Name"]);
});
test("nested queries retain their Apex start line", () => {
  const source = "List<Account> data = [SELECT Name,\n  (SELECT LastName\n   FROM Contacts)\n  FROM Account];";
  const [q] = extractSoqlQueries(source, "classes/Example.cls");
  assert.equal(q.lineNumber, 1);
  assert.equal(q.subqueries[0].lineNumber, 2);
  const c = collectQueryFields(q, graph());
  assert.equal(c.references.find(f => f.object === "Contact")?.lineNumber, 2);
});
test("unresolved child is a relationship issue, never a fake SELECT field", () => {
  const q = parse("SELECT Name, (SELECT Foo__c FROM Missing__r) FROM Account");
  const c = collectQueryFields(q, graph());
  assert.equal(c.unresolvedEntries[0].kind, "RELATIONSHIP");
  assert.equal(c.unresolvedEntries[0].fieldPath, "Missing__r");
  assert.ok(c.fields.every(f => !f.field.includes("SELECT")));
  const issues: Array<{ kind?: string; fieldPath: string }> = [];
  buildSoqlFieldInventory([q], graph(), issue => issues.push(issue));
  assert.equal(issues[0].kind, "RELATIONSHIP");
});
test("ambiguous child relationship never guesses target", () => {
  const m = graph();
  m.addChild("Account", "Ambiguous__r", "First__c");
  m.addChild("Account", "Ambiguous__r", "Second__c");
  const c = collectQueryFields(parse("SELECT Name, (SELECT Name FROM Ambiguous__r) FROM Account"), m);
  assert.equal(c.unresolvedEntries[0].kind, "RELATIONSHIP");
});
test("unresolved deep parent path is kept for review", () => {
  const c = collectQueryFields(parse("SELECT Name, (SELECT Account.Other__r.Name FROM Contacts) FROM Account"), graph());
  assert.equal(c.unresolvedEntries[0].kind, "FIELD");
});
test("COUNT-only query retains object Read without inventing Id FLS", () => {
  const inv = buildSoqlFieldInventory([parse("SELECT COUNT() FROM Account")], graph());
  assert.ok(inv.has("Account"));
  assert.equal(inv.get("Account")!.size, 0);
  assert.equal(inv.objectReferences.get("Account")?.length, 1);
});
test("aggregates check their underlying fields without treating function names as FLS fields", () => {
  const c = collectQueryFields(parse("SELECT COUNT(Id), SUM(Amount) FROM Opportunity"), graph());
  assert.deepEqual(c.fields.map(x => x.object + "." + x.field), ["Opportunity.Amount"]);
  assert.ok(!c.fields.some(x => ["SUM", "COUNT"].includes(x.field)));
});
test("TYPEOF is called out as a limitation, not a verified field grant", () => {
  const c = collectQueryFields(parse("SELECT TYPEOF What WHEN Account THEN Name END FROM Task"), graph());
  assert.ok(c.limitations.some(x => x.includes("TYPEOF")));
});
test("repository inventory retains repeated occurrences for the same field", () => {
  const inv = buildSoqlFieldInventory([parse("SELECT Name, Name FROM Account")], graph());
  assert.equal(inv.get("Account")?.get("name")?.length, 2);
});
test("three selected scopes do not inflate static query count", () => {
  const q = parse("SELECT Name, (SELECT LastName FROM Contacts), (SELECT StageName FROM Opportunities) FROM Account");
  assert.equal(q.subqueries.length, 2);
  assert.equal(extractSoqlQueries("List<Account> a=["+q.query+"];", "classes/T.cls").length, 1);
});


test("Apex Set<String> bind is not interpreted as Shipment__c.set/String FLS", () => {
  const q = parse("SELECT Id, OrderSummary__c FROM Shipment__c WHERE " +
    "OrderSummary__c IN :mapOfOrderSummaries.keySet() AND\n" +
    "Status__c IN :new Set<String>{'Draft', 'Discrepancy'} WITH USER_MODE");
  const collected = collectQueryFields(q, graph());
  assert.deepEqual(collected.fields.map(f => f.object + "." + f.field),
    ["Shipment__c.OrderSummary__c", "Shipment__c.Status__c"]);
  assert.equal(collected.unresolved.length, 0);
  assert.ok(!collected.references.some(ref => /^(set|string)$/i.test(ref.field)));
  const inventory = buildSoqlFieldInventory([q], graph());
  assert.deepEqual([...inventory.get("Shipment__c")!.keys()].sort(),
    ["ordersummary__c", "status__c"]);
});

test("Apex generic binds preserve real WHERE fields and following comparison conditions", () => {
  const cases = [
    "SELECT Id FROM Shipment__c WHERE Status__c IN :new Set<String>{'Draft', 'Discrepancy'} AND OrderSummary__c != null",
    "SELECT Id FROM Shipment__c WHERE Status__c IN :new Set<Id>(:ids) AND OrderSummary__c = :summaryId",
    "SELECT Id FROM Shipment__c WHERE Status__c IN :new Map<String, Set<Id>>{} .keySet() AND OrderSummary__c = :summaryId",
    "SELECT Id FROM Shipment__c WHERE OrderSummary__c IN :orders.keySet() AND Status__c = :requestedStatus",
    "SELECT Id FROM Shipment__c WHERE OrderSummary__c != null AND Status__c IN :new Set<String>{'Draft'} ORDER BY Status__c",
  ];
  for (const soql of cases) {
    const c = collectQueryFields(parse(soql), graph());
    const fields = c.fields.map(f => f.field.toLowerCase());
    assert.ok(fields.includes("status__c"), soql);
    assert.ok(fields.includes("ordersummary__c"), soql);
    assert.ok(!fields.includes("string") && !fields.includes("set") && !fields.includes("id"), soql);
    assert.deepEqual(c.unresolved, [], soql);
  }
});

test("Root-qualified OrderSummary.Client__c resolves without inventing a parent hop", () => {
  const q = parse("SELECT Client__c FROM OrderSummary WHERE OrderSummary.Client__c = :clientId");
  const c = collectQueryFields(q, new RelationshipMap());
  assert.deepEqual(c.unresolved, []);
  assert.deepEqual(c.fields.map(f => f.object + "." + f.field), ["OrderSummary.Client__c"]);
  const i = buildSoqlFieldInventory([q], new RelationshipMap());
  assert.ok(i.get("OrderSummary")!.has("client__c"));
  assert.ok(!i.get("OrderSummary")!.has("ordersummary.client__c"));
});

test("Actual parent relationship OrderItemSummary.OrderSummary.Client__c still resolves", () => {
  const map = new RelationshipMap();
  map.addParent("OrderItemSummary", "OrderSummary", ["OrderSummary"], "OrderSummaryId");
  const q = parse("SELECT OrderSummary.Client__c FROM OrderItemSummary WHERE " +
    "OrderSummary.Client__c = :clientId");
  const c = collectQueryFields(q, map);
  assert.equal(c.unresolved.length, 0);
  assert.ok(c.fields.some(f => f.object === "OrderSummary" && f.field === "Client__c"));
  assert.ok(c.objects.includes("OrderItemSummary") && c.objects.includes("OrderSummary"));
});

test("Unresolved genuine relationships remain Review, not silently converted into fields", () => {
  const q = parse("SELECT Missing_Parent__r.Client__c FROM OrderSummary");
  const c = collectQueryFields(q, new RelationshipMap());
  assert.equal(c.unresolvedEntries.length, 1);
  assert.equal(c.unresolvedEntries[0].fieldPath, "Missing_Parent__r.Client__c");
});
