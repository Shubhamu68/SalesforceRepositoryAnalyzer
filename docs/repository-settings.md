# Repository settings checklist (maintainer-only)

This repository is currently **public**. The GitHub connector can update source files and open PRs but does not provide the necessary repository-admin settings access. A maintainer must apply any requested settings in GitHub's UI. This documentation does **not** change repository administration settings.

## About sidebar

In the repository homepage's **About** sidebar, use the settings/gear control to configure:

**Description**

> Salesforce repository security analyzer with SOQL analysis, persona-based access verification, stack trace analysis, and Excel reporting.

**Topics**

`salesforce`, `apex`, `soql`, `security-analysis`, `typescript`, `react`, `salesforce-metadata`

Website: leave blank unless there is an approved project landing page.

## Branch governance

1. Go to **Settings → General → Pull Requests** and consider automatically deleting *merged* head branches.
2. Configure branch protection using **Settings → Rules → Rulesets** (or **Settings → Branches**, depending on plan/UI).
3. Protect `main`: require PR review as appropriate, prevent force pushes/deletion, and require the relevant `Salesforce Analyzer Regression` checks on Windows/Ubuntu.
4. Determine whether approval beyond the owner’s UAT is required. Verify which repository rules are supported on the account plan.
5. Delete only branches confirmed merged into `main`; preserve unmerged work.

Optional: standardize on squash-merge for a tidy history; this is not a necessary change for this documentation PR.

## Public-repository hygiene

- Review the **entire commit history** for secret/customer metadata exposure, not only the latest tracked files.
- Keep actual user `.env`, CLI auth materials and private customer repositories out of commits and public issue attachments.
- Decide software ownership and licensing before presenting the public repository as open-source licensed.
- Follow organizational policy before publishing ZIPs or source belonging to a client or employer.

## Releases and distributions

A `v*` tag invokes the existing **browser-portable** [Release workflow](../.github/workflows/release-windows.yml), **not** the Electron desktop-folder ZIP workflow. The Electron ZIP is currently a separate Actions artifact or approved shared file. Review [Builds and releases](releases.md) before publishing anything.
