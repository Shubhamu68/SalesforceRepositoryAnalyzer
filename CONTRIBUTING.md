# Contributing

This is a **public, actively developed** Salesforce metadata analysis repository. Changes should preserve accuracy and explainability: a false permission grant is worse than a visible `Review` result.

**Reuse notice:** Public repository visibility does not itself grant a reuse or distribution license. There is currently no root `LICENSE` file; confirm contribution and redistribution terms with the maintainer before making assumptions.

## Development workflow

1. Confirm the latest `origin/main` contains approved merges, then create a branch from `main`.
2. Use a descriptive `feature/`, `fix/`, `docs/` or `chore/` branch.
3. Keep the scope small and add focused regression tests when application behavior changes.
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

5. Push the branch and open a PR using the template. Reference a GitHub issue when applicable.
6. Leave the PR **open** for owner review/UAT. Do not merge without approval.

## Engineering rules

- Centralize Salesforce object/FLS decisions and query parsing; avoid feature-specific bypasses.
- Treat unverified/unsupported permission evidence as `Review`, not proof of a grant or denial.
- Preserve real source line numbers and Apex/metadata context in reports.
- Test repository-only and live-org paths, missing CLI authentication, and important edge cases.
- Do not change the analysis engine as part of documentation/visual-copy cleanup.
- Avoid unnecessary dependencies; pin and test added packages.

## Security

Never commit `.env`, real customer data, org IDs, access tokens, CLI auth files, secrets or raw private logs. Sanitize screenshots, examples, issues and PR descriptions: this repository is public. Desktop and browser-portable ZIPs must exclude real per-user settings and include only the safe `.env.example` template.

## Versioning and distributions

`main` is development source. The **Electron desktop-folder ZIP** is built using [Build Windows Desktop Folder ZIP](.github/workflows/windows-desktop.yml); that temporary artifact is distinct from the current tagged GitHub Release workflow, which publishes **only the browser-based portable ZIP**. Approval, UAT and distribution are maintainer decisions. See [Builds and releases](docs/releases.md) before tagging or sharing an artifact.

## Documentation

Keep the root README short and current. New guides belong under `docs/setup/`, `docs/features/`, or `docs/`. Historical implementation material belongs in `docs/history/`. See [Documentation index](docs/README.md).
