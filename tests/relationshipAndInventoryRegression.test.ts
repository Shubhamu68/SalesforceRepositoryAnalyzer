import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelationshipMap } from '../src/analyzer/salesforceRelationshipResolver.js';
import { buildSoqlFieldInventory } from '../src/analyzer/soqlFieldInventoryBuilder.js';
import { collectQueryFields } from '../src/analyzer/soqlQueryFieldResolver.js';
import type { SoqlQuery } from '../src/models/SoqlQuery.js';

function query(object: string, fields: string[], subqueries: SoqlQuery['subqueries'] = []): SoqlQuery {
  return { object, fields, subqueries, filePath: 'classes/Inventory.cls', lineNumber: 22,
    query: `SELECT ${fields.join(', ')} FROM ${object}`, withUserMode: true, securityMode: 'USER_MODE' };
}

test('Simple field resolves to the queried object', () => {
  const graph = new RelationshipMap();
  graph.registerObject('Account');
  assert.deepEqual(graph.resolveField('Account', 'Name'), { object: 'Account', field: 'Name', objects: ['Account'] });
});

test('Deep parent traversal resolves final object and preserves intermediate path', () => {
  const graph = new RelationshipMap();
  graph.addParent('OrderItemSummary', 'OriginalOrderItem', ['OrderItem'], 'OriginalOrderItemId');
  graph.addParent('OrderItem', 'Order', ['Order'], 'OrderId');
  graph.addParent('Order', 'Client__r', ['Account'], 'Client__c');
  const resolved = graph.resolveField('OrderItemSummary', 'OriginalOrderItem.Order.Client__r.Name');
  assert.equal(resolved?.object, 'Account');
  assert.deepEqual(resolved?.objects, ['OrderItemSummary', 'OrderItem', 'Order', 'Account']);
});

test('Unknown relationship is unresolved, not silently guessed', () => {
  const graph = new RelationshipMap();
  assert.equal(graph.resolveField('OrderSummary', 'Unrecognized__r.Name'), undefined);
  assert.match(graph.explainUnresolved('OrderSummary', 'Unrecognized__r.Name'), /metadata unavailable/);
});

test('Ambiguous polymorphic parent is not assigned to a random object', () => {
  const graph = new RelationshipMap();
  graph.addParent('Task', 'What', ['Account', 'Opportunity'], 'WhatId');
  assert.equal(graph.resolveField('Task', 'What.Name'), undefined);
  assert.match(graph.explainUnresolved('Task', 'What.Name'), /ambiguous targets/);
});

test('Owner.Name polymorphic special case remains safe', () => {
  const graph = new RelationshipMap();
  graph.addParent('OrderSummary', 'Owner', ['User', 'Group'], 'OwnerId', { namePointing: true });
  assert.equal(graph.resolveField('OrderSummary', 'Owner.Name')?.object, 'Name');
  assert.equal(graph.resolveField('OrderSummary', 'Owner.Email'), undefined);
});

test('Child subquery relationship resolves to the actual child object', () => {
  const graph = new RelationshipMap();
  graph.addChild('Account', 'Contacts', 'Contact');
  assert.equal(graph.childObject('Account', 'Contacts'), 'Contact');
  const inv = buildSoqlFieldInventory([query('Account', ['Industry'], [{ relationshipName: 'Contacts', fields: ['LastName'], subqueries: [] }])], graph);
  assert.ok(inv.has('Account'));
  assert.equal(inv.has('Contact'), true);
  assert.equal(inv.get('Contact')?.get('lastname')?.[0].object, 'Contact');
});

test('Missing child relationship is surfaced for review', () => {
  const missing: string[] = [];
  const graph = new RelationshipMap();
  buildSoqlFieldInventory([query('Account', ['Industry'], [{ relationshipName: 'UnmappedChildren__r', fields: ['Name'], subqueries: [] }])], graph,
    issue => missing.push(issue.fieldPath));
  assert.ok(missing.some(x => x.includes('UnmappedChildren__r')));
});

test('Inventory keeps query locations while deduplicating the same field key', () => {
  const graph = new RelationshipMap();
  const q = query('Account', ['Industry', 'Industry']);
  const inv = buildSoqlFieldInventory([q], graph);
  assert.equal(inv.get('Account')?.size, 1);
  assert.equal(inv.get('Account')?.get('industry')?.length, 2);
});

test('Aggregate operands are retained without treating functions as fields', () => {
  const graph = new RelationshipMap();
  const inv = buildSoqlFieldInventory([query('Account', ['COUNT(Id)', 'Industry'])], graph);
  assert.deepEqual([...inv.get('Account')!.keys()].sort(), ['id', 'industry']);
  assert.ok(!inv.get('Account')?.has('count'));
});

test('Query field collection tracks WHERE and ORDER BY fields', () => {
  const graph = new RelationshipMap();
  const q = query('Account', ['Industry']);
  q.query = 'SELECT Industry FROM Account WHERE AccountNumber = :number ORDER BY BillingCity';
  const collection = collectQueryFields(q, graph);
  assert.ok(collection.fields.some(f => f.field === 'Industry'));
  assert.ok(collection.fields.some(f => f.field === 'AccountNumber'));
  assert.ok(collection.fields.some(f => f.field === 'BillingCity'));
});

test('Unsupported relationship or filter does not produce a false clean result', () => {
  const graph = new RelationshipMap();
  const q = query('Account', ['Client__r.Name']);
  q.query = 'SELECT Client__r.Name FROM Account WHERE DISTANCE(Location__c, GEOLOCATION(0,0), \'mi\') < 10';
  const collection = collectQueryFields(q, graph);
  assert.ok(collection.unresolved.length > 0 || collection.limitations.length > 0);
});


test("Explicit root name is not a relationship when resolving a field from that root", () => {
  const graph = new RelationshipMap();
  assert.deepEqual(graph.resolveField("OrderSummary", "OrderSummary.Client__c"),
    { object: "OrderSummary", field: "Client__c", objects: ["OrderSummary"] });
  assert.deepEqual(graph.resolveField("OrderSummary", "ordersummary.Client__c"),
    { object: "OrderSummary", field: "Client__c", objects: ["OrderSummary"] });
  assert.deepEqual(graph.resolveField("Account", "Account.Owner.Email"), undefined,
    "genuine unknown relationship hops remain unresolved");
});

test("True relationship edges take precedence over same-name root qualifier", () => {
  const graph = new RelationshipMap();
  graph.addParent("OrderSummary", "OrderSummary", ["Alternate__c"], "Alternate__c");
  graph.addParent("Alternate__c", "Owner__r", ["Account"], "Owner__c");
  assert.deepEqual(graph.resolveField("OrderSummary", "OrderSummary.Owner__r.Name"), {
    object: "Account", field: "Name", objects: ["OrderSummary", "Alternate__c", "Account"],
  });
});

test("Unqualified multi-hop relationships retain all intermediate object checks", () => {
  const graph = new RelationshipMap();
  graph.addParent("OrderItemSummary", "OriginalOrderItem", ["OrderItem"], "OriginalOrderItemId");
  graph.addParent("OrderItem", "Order", ["Order"], "OrderId");
  graph.addParent("Order", "Client__r", ["Account"], "Client__c");
  const field = graph.resolveField("OrderItemSummary", "OriginalOrderItem.Order.Client__r.Name");
  assert.deepEqual(field?.objects, ["OrderItemSummary", "OrderItem", "Order", "Account"]);
  assert.equal(field?.field, "Name");
});
