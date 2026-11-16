# UI messaging cleanup — Issue #22

**Scope:** presentation only. No changes to persona matching, object/FLS policies,
SOQL scanning, org verification decisions, API payloads, or report file structure.

| Area | Before | After |
| --- | --- | --- |
| Access Checker / SOQL | Generic "Repository metadata" badge and repeated explanations | Short workflow-specific instructions and a Salesforce-connection-aware verification hint |
| Dashboard | API/org statuses duplicated in dashboard, repeated metric captions, sidebar report box | Statuses remain independently visible in the header; dashboard shows only latest analysis context |
| SOQL results | Repeated completion/success language, "reports" plural | One clear completion message: an Excel workbook saved for the selected persona |
| Object Access Matrix | Static "Repository + Salesforce verification" claim | "Repository first" with connection-aware state; compact warnings and details |
| Matrix permission details | Only Read showed org fallback evidence; missing metadata could be read as denied | All seven privileges show their own org evidence; "No repository grant" is clearly distinct from Salesforce denial |
| Stack Trace | Long helper text and duplicated finding explanations | Short static-scan caveat and concise, distinct confirmed-denial versus incomplete-verification messages |
| Salesforce Org | Long credential explanation, details always shown, "Proof of concept" label | Compact connection status; diagnostic details expandable; query test labels current |
| Repository setup | Extensive folder instructions and repeated invalid-path warning | Root-path guidance with expandable required metadata folders; concrete validation errors remain |
| Excel setup | Duplicate output-folder prompt | One clear workbook description; invalid/missing-folder errors still shown |
| Loaders | Inaccurate fixed 20–30 second hints | Accurate progress descriptions with no invented duration |

## Meaning of status and evidence

- **API connected:** local backend is running, not proof of a repository or Salesforce session.
- **Repository connected:** selected repository root passed metadata validation.
- **Salesforce connected:** authentication session available, not proof that a particular grant has been verified.
- **Org-verified:** permission specifically confirmed through Salesforce and distinguished by evidence/warning icon.
- **No / confirmed denial:** permission missing based on actual verification outcome, not merely a missing metadata file.
- **Review / unable to verify:** org verification missing, failed, incomplete, or mixed; not a confirmed denial.

## Safety and review

- Existing first-run folder picker, modal focus/keyboard navigation, and React page routing remain.
- The Repository card is not reintroduced into the sidebar.
- Platform Events remain excluded from data-access analysis.
- Preserve raw backend permission evidence in expandable sections for troubleshooting.
- Validate with `npm run build`, `npm run test:all`, and `cd web && npm run build`
  on both Linux and Windows GitHub CI.
- Visual/manual UAT remains recommended for narrow desktop/mobile layouts and modal focus.
