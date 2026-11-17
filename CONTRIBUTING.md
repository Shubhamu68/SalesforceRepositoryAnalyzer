# Contributing

This is a private, actively developed Salesforce metadata analysis project. Changes should preserve accuracy and explainability: a false permission grant is worse than a visible Review result.

## Development workflow

1. Confirm the latest `origin/main` contains all approved merges, then branch directly from `main`.
2. Choose `feature/`, `fix/`, or `chore/` with a descriptive short name.
3. Keep the scope small and add focused regression tests for new syntax, permissions, and UI labels.
4. Run:
   ```bash
   npm ci
   npm run build
   npm run test:all
   cd web
   npm ci
   npm run build
   npm run lint
   ```
5. Push the branch and open a PR using the template. Reference relevant GitHub issues (e.g., `Fixes #123`).
6. Leave the PR **open** for the owner to test and merge. Do not merge without approval.

## Engineering rules

- Centralize Salesforce object/FLS decisions and query parsing; avoid feature-specific bypasses.
- Treat unverified/unsupported permission evidence as **Review**, not as proof of a grant or denial.
- Preserve real source line numbers and Apex/metadata context in reports.
- Test repository-only and live-org paths, missing credentials, and edge cases.
- Do not change the analysis engine as part of documentation or visual-copy cleanup.
- Avoid new dependencies without a clear need, pinned versions where relevant, and regression evidence.

## Security

Never commit `.env`, customer data, org IDs, tokens, client secrets or raw private logs. Redact examples before putting them into issues/PRs. The portable ZIP must exclude `.env` and contain only the safe example file.

## Versioning and Releases

`main` is development source; only the owner/maintainer creates an approved tag after UAT. A tag invokes the Windows Release workflow, re-runs packaging tests and publishes immutable versioned files. Read [Release process](docs/releases.md) before tagging.

## Documentation

Keep the root README short. New current docs belong under `docs/setup/`, `docs/features/` or `docs/`. Old one-off implementation notes belong under `docs/history/` instead of cluttering the repository root.
