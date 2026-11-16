import { parseQuery } from '@jetstreamapp/soql-parser-js';
const cases = {
  basic: "SELECT Name, MAX(Amount) mx, MIN(Amount) mn, SUM(Amount) total, AVG(Amount) av, COUNT(Id) c, COUNT_DISTINCT(AccountId) cnt FROM Opportunity GROUP BY Name",
  countStar: "SELECT COUNT() FROM Opportunity",
  having: "SELECT StageName, SUM(Amount) total FROM Opportunity GROUP BY StageName HAVING SUM(Amount) > 1000 ORDER BY SUM(Amount) DESC",
  rollup: "SELECT StageName, COUNT(Id) n FROM Opportunity GROUP BY ROLLUP(StageName)",
  cube: "SELECT StageName, Type, COUNT(Id) n FROM Opportunity GROUP BY CUBE(StageName, Type)",
  grouping: "SELECT StageName, GROUPING(StageName) isSubtotal, SUM(Amount) amount FROM Opportunity GROUP BY ROLLUP(StageName) HAVING GROUPING(StageName) = 1",
  date: "SELECT CALENDAR_YEAR(CloseDate) yr, SUM(Amount) total FROM Opportunity GROUP BY CALENDAR_YEAR(CloseDate)",
  nestedFunc: "SELECT FORMAT(SUM(Amount)) formatted FROM Opportunity",
  nestedChild: "SELECT Id, (SELECT MAX(Amount) mx FROM Opportunities) FROM Account",
  semiJoin: "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email != null)",
  apexBasic: "SELECT Id FROM Shipment__c WHERE OrderSummary__c IN :mapOfOrderSummaries.keySet() AND Status__c IN :new Set<String>{'Draft', 'Discrepancy'} WITH USER_MODE",
  relationship: "SELECT Account.Owner.Name, MAX(Amount) total FROM Opportunity GROUP BY Account.Owner.Name",
  havingAnd: "SELECT StageName, SUM(Amount) total FROM Opportunity GROUP BY StageName HAVING SUM(Amount) > 1000 AND COUNT(Id) > 2",
  orderAlias: "SELECT StageName, SUM(Amount) totalAmount FROM Opportunity GROUP BY StageName ORDER BY totalAmount DESC",
  literal: "SELECT MAX(CloseDate) latest FROM Opportunity WHERE StageName = 'Prospecting'",
  withClause: "SELECT MAX(Amount) FROM Opportunity WITH USER_MODE",
  distance: "SELECT Id FROM Account WHERE DISTANCE(BillingAddress, GEOLOCATION(40, -72), 'mi') < 100"
};
for (const [label, sql] of Object.entries(cases)) {
  try { const ast = parseQuery(sql, { allowApexBindVariables: true });
    console.log("PASS " + label + " " + JSON.stringify(ast).slice(0,3500)); }
  catch (error) { console.log("FAIL " + label + " " + String(error?.message ?? error).slice(0,250)); }
}
