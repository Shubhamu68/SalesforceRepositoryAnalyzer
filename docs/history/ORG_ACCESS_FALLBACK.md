# Access Checker & Object Matrix — repository-first / Salesforce-org fallback

This feature is limited to **Access Checker** (object and field) and **Object Access Matrix**.
SOQL and Stack Trace retain their existing shared Read-verification semantics.

## Decision matrix

| Repository XML | Matching Salesforce users | Result |
| --- | --- | --- |
| Grant found | Not queried | **Yes**, no warning |
| Grant not established | All matching active users granted | **Yes ⚠**, hover: repository grant not established, found in org |
| Grant not established | All matched active users denied | **No** with verification explanation |
| Grant not established | Mixed user access, query failure, missing credentials, insufficient API evidence, no matching users, >50 matches | **Review**, explicit org failure or limitation message |

A repository metadata gap is **not itself a security defect**. The warning means repository vs. org grant coverage differs.

## Verification sources

- **Object Read, Create, Edit and Delete:** Tooling `UserEntityAccess`.
- **View All Records / Modify All Records:** assigned Profile-owned PermissionSet, directly assigned PermissionSets, PSG aggregate PermissionSets; `ObjectPermissions` plus global `PermissionsViewAllData` and `PermissionsModifyAllData`.
- **View All Fields:** `ObjectPermissions.PermissionsViewAllFields`, queried with Salesforce API v63+ even when the project's ordinary API version is older.
- **Field Read and Field Edit:** Tooling `UserFieldAccess.IsAccessible` / `IsUpdatable`, combined with object-level Read/Edit prerequisites. Non-permissionable and universally schema-required fields follow the existing repository FLS rules.

The API uses the same shared fallback logic for **all seven** object permissions and both field permissions.
Only permissions not established in repository XML are sent through the fallback.

## Matched users and fail-closed semantics

Matching is based on **active** Salesforce users whose Profile, direct Permission Sets and Permission Set Groups cover the configured persona. Extra assignments are allowed because they can contribute to actual effective access. Unlike the legacy single-user representative Read check, this workflow verifies **every matched active user**; never-logged-in active users are included.

The check is bounded at 50 users per persona. More matches cause Review rather than sampling a user and incorrectly claiming a unanimous result. The result is Yes only when *every* matched user granted, No only when *every* matched user denied. Mixed/unknown/unsupported answers, missing API rows, connection failures and unmatched users cause Review with a reason.

No direct changes are made to Salesforce or repository XML.

## Operational notes

- The org integration user needs permission to read User/Profile/PermissionSet/PSA/UserEntityAccess/UserFieldAccess/ObjectPermissions metadata. If any required API is unavailable, affected permissions are Review.
- PSG aggregate permissions must have been recalculated by Salesforce; if org metadata cannot be resolved, the result is Review.
- User inventory is reused for three minutes; all-permission evidence is cached for 60 seconds to avoid repeated calls.
- This is **org permission** verification, not record-level sharing evaluation and not license/permission-set assignment attribution.
- These two functions do not block analysis on missing Client Credentials. Missing credentials produce per-permission Review and a message that org verification failed.
- For manual testing, try a persona with complete repository grants, a grant missing in repo but present in the connected org, a persona with two matching users with different privileges, and a run without Salesforce credentials. Confirm tooltip behavior with pointer hover and keyboard focus.

## Regression checks
- `npm run build` and `npm run test:all` in repository root.
- `cd web && npm run build`.
- Tests: `orgPermissionFallback.test.ts`, `orgFullConsensusMatching.test.ts`, `orgEffectivePermissionVerifier.test.ts`.
