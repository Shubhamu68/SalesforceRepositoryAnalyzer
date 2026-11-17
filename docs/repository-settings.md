# Repository settings checklist (maintainer-only)

The GitHub connector can edit repository files and create PRs, but repository administration settings are not exposed through the available connection. **The following settings require a maintainer to configure them in GitHub's web UI.** No setting has been changed by this PR.

## About sidebar

On the repository homepage, click the gear icon beside **About** and add:

**Description**

> Salesforce repository security analyzer with SOQL analysis, persona-based access verification, stack trace analysis, and Excel reporting.

**Topics**

`salesforce`, `apex`, `soql`, `security-analysis`, `typescript`, `react`, `salesforce-metadata`

Website is optional; leave blank until there is an approved product page.

## Branch governance

1. Open **Settings → General → Pull Requests**; enable **Automatically delete head branches** after merged PRs.
2. Open **Settings → Rules → Rulesets** (or **Settings → Branches**, depending on GitHub UI and plan).
3. Protect `main`: require a PR, prevent force pushes/deletions and require successful `Salesforce Analyzer Regression` checks on both Windows and Ubuntu.
4. Decide whether approvals should be required in addition to the owner’s UAT. Confirm available rules on the repository's GitHub plan.
5. Delete **only confirmed merged** historical feature branches after verifying their commits are on `main`; never delete unmerged work just to reduce the branch count.

The repository currently allows squash, merge-commit and rebase merge strategies. You may standardize on squash for a tidier history, but that is optional and should not be silently changed by code.

## Releases

Publishing is controlled by the explicit `v*` version tag and [Release workflow](../.github/workflows/release-windows.yml), not by merges alone. Tag only reviewed `main` commits after changing the package version and running UAT.

For private repositories, download access to releases is limited to authorized collaborators.
