# Effective access and Salesforce verification

The Access Checker and Object Access Matrix evaluate Profile, direct Permission Set and Permission Set Group grants from a Salesforce metadata checkout. Connected-org verification can establish permissions not provable from repository metadata.

## Statuses

| Status | Meaning |
| --- | --- |
| **Yes** | Both required object and field permissions are established via repository and/or Salesforce evidence |
| **No** | Salesforce explicitly confirmed a missing prerequisite |
| **Review** | Repository grants were absent and Salesforce evidence could not establish a definite result |
| Neutral **ⓘ** | An affirmative result relies on Salesforce-verified evidence; this is informative, not a warning |

Object access and field FLS are separate prerequisites: a field Read grant without object Read does not establish effective Read. Verification details identify which prerequisite was established in the repository versus live Salesforce.

## Sources and safeguards

- Repository metadata: Profile, Permission Sets, PSG composition/muting, object CRUD, field FLS and global permissions.
- Live effective-access checks: authorized Salesforce active-user queries with conservative consensus/uncertainty handling.
- `EntityParticle` metadata: identifies non-permissionable fields and compound field components; an org-scoped cache avoids repeated lookups.
- Compound Name/Address/Location and supported polymorphic `Name` pseudo-fields are metadata-verified, not hardcoded grants.
- Unresolvable relationships, incomplete org evidence, absent metadata and mixed results remain Review.
- Read-only: verification does not change user assignments, Profile or Permission Set XML, or org data.

SOQL Security Analysis and Stack Trace analysis reuse the central verification services but additionally consider query scope and enforcement mode.

See [Architecture](../architecture.md), [Security](../security.md), and [historical fallback design](../history/ORG_ACCESS_FALLBACK.md).
