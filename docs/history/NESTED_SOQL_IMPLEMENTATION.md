# Nested SOQL relationship resolution

All permission-dependent features should consume the shared scanner +
collectQueryFields() -> buildSoqlFieldInventory() pipeline and the existing
OrgObjectReadVerificationService. Do not add feature-local parsers or hardcode
relationship names.

## Scope
- Recursive parent-to-child SELECTs, multiple siblings, self-relationships
- Semi/anti-joins: FROM is an sObject name, not a child relationship
- Child filters, sorting, GROUP BY/HAVING best-effort static field collection
- Child relationship resolution: repository metadata -> Salesforce Describe fallback
- Unresolved relationships: REVIEW / Unable to verify, never a fake FLS field
- Actual Apex source lines + relationship path/level in Excel
- Existing High/Low/Unable to verify execution-mode rules remain unchanged
- Bounded verification and shared in-flight Describe metadata lookups

## Changes and compatibility
src/analyzer/nestedSoqlScopes.ts: source tokenizer/scoped SELECT parser
src/scanner/apexSoqlScanner.ts: use parser in both SOQL and Stack Trace
src/models/SoqlQuery.ts: optional child kind, source, line metadata
src/analyzer/soqlQueryFieldResolver.ts: shared recursive SELECT + filter resolver
src/analyzer/soqlFieldInventoryBuilder.ts: shared inventory with object refs
src/models/SoqlFieldInventory.ts: source-level object references without dummy FLS
src/analyzer/soqlSecurityAnalyzer.ts: optional Describe, scoped source lines
src/salesforce/SalesforceRelationshipMetadataService.ts: coalesced concurrent Describe
src/models/SoqlSecurityFinding.ts: optional relationshipPath and queryLevel
src/reporter/soqlReportWriter.ts: two extra columns in Summary/References
src/api/server.ts: wire existing Describe service into SOQL analyzer

No npm dependencies were added. Existing stack statuses and shared org-verification
policy are retained. No specialized ApexEmailNotification rules are introduced.

## Run locally
npm ci
npm run build
npm run test:all
cd web
npm ci
npm run build

## Test scenarios
- Nested children, siblings, deep levels, self-relationships, custom __r
- Several relationships returning the same child object
- Semi-joins and anti-joins, WITH USER_MODE inheritance
- WHERE/ORDER BY fields per scope, dotted ancestor relationships
- Aggregates and COUNT-only object access
- Strings/comments and malformed or ambiguous relationship names
- Unresolved metadata stays Review; Salesforce Describe fallback
- Same extraction pipeline in SOQL and Stack Trace
- Excel source lines, paths, levels and High/Low preservation
