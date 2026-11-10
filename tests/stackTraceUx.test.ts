import assert from "node:assert/strict";
import test from "node:test";
import { focusedQueries, hasNoMatchingUsers, orgVerifiedSummary, partitionFindings } from "../web/src/components/stackTraceViewModel.js";
import type { Persona, Query } from "../web/src/components/stackTraceTypes.js";
import { isStatusNeutralOrgObjectRead } from "../src/config/orgVerificationStatusPolicy.js";

const missingObject = { object: "OrderItemSummary", reason: "OBJECT_READ" as const };
const denied = { object: "OrderItemSummary", field: "Order_Quantity_Change__c", reason: "FIELD_READ" as const, orgOutcome: "DENIED" as const };
const noMatch = { object: "OrderItemSummary", field: "Item_Code__c", reason: "FIELD_READ" as const,
  orgOutcome: "UNVERIFIED" as const, orgReason: "NO_MATCHING_USERS" as const };

function persona(missing: Persona["missing"], status: Persona["status"] = "REVIEW"): Persona {
  return { personaName: "OMS View Only", status, atRiskQueries: 0, reviewQueries: 1, missing };
}

test("confirmed missing permission and inconclusive permission remain separate", () => {
  const result = partitionFindings([noMatch, denied]);
  assert.deepEqual(result.denied, [denied]);
  assert.deepEqual(result.unverified, [noMatch]);
});

test("no-match message requires a structured no-match reason", () => {
  assert.equal(hasNoMatchingUsers(persona([noMatch])), true);
  assert.equal(hasNoMatchingUsers(persona([{ ...noMatch, orgReason: undefined }])), false);
  assert.equal(hasNoMatchingUsers(persona([noMatch, denied], "AT_RISK")), false);
  assert.equal(hasNoMatchingUsers({ ...persona([noMatch]), orgCheckedUsers: [{ id: "005xx", name: "A", username: "a@org" }] }), false);
});

test("verified message does not include Salesforce user counts", () => {
  assert.equal(orgVerifiedSummary({ object: "OrderItemSummary", matchedUsers: 2, checkedUsers: 2, sampled: false, message: "Access verified from Salesforce for all 2 matching active users." }),
    "Verified from Org: OrderItemSummary Read — Access verified from Salesforce");
});

test("SOQL query results are scoped to the selected persona", () => {
  const query: Query = {
    id: "q1", methodId: "m1", className: "A", methodName: "m", filePath: "A.cls", lineNumber: 5,
    object: "OrderItemSummary", query: "SELECT Id FROM OrderItemSummary", withUserMode: true,
    securityMode: "USER_MODE", checkedFields: [], unresolvedFields: [], limitations: [],
    personas: [
      { personaName: "OMS View Only", status: "AT_RISK", missing: [denied], notes: [] },
      { personaName: "System Admin", status: "NO_GAPS", missing: [], notes: [] }
    ]
  };
  assert.equal(focusedQueries([query], "", false).length, 0);
  assert.deepEqual(focusedQueries([query], "OMS View Only", true).map(({ impact }) => impact.personaName), ["OMS View Only"]);
  assert.equal(focusedQueries([query], "System Admin", true).length, 0);
  assert.equal(focusedQueries([query], "System Admin", false).length, 1);
});

test("the status-neutral object policy never exempts field Read", () => {
  const policy = { statusNeutralObjectRead: new Set(["orderitemsummary"]) };
  assert.equal(isStatusNeutralOrgObjectRead(policy, "OrderItemSummary"), true);
  assert.equal(isStatusNeutralOrgObjectRead(policy, "OrderItemSummary", "Order_Quantity_Change__c"), false);
  assert.equal(isStatusNeutralOrgObjectRead(policy, missingObject.object, undefined), true);
});
