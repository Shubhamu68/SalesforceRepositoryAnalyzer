# Security practices

The Analyzer reads local Salesforce repository metadata and can optionally connect to a Salesforce org to verify permission evidence. **The source repository is public**, but customer repositories, org metadata, report outputs, logs, and individual credentials should be treated as organization-controlled information.

## Authentication and credentials

- The current Analyzer uses **Salesforce CLI-managed browser OAuth** and each user's authorized CLI org; it does not require a custom shared client ID, client secret, or Salesforce password.
- Never commit or distribute a real `.env`, access token, CLI authorization file, auth URL, refresh token, certificate, customer record, or user-specific secrets. The tracked `.env.example` is a safe template.
- Salesforce credentials must only be entered on Salesforce's own login page. Use organizational SSO/MFA and least-privilege access.
- CLI credentials remain managed by Salesforce CLI even after disconnecting the Analyzer; sign out/revoke them using supported CLI/Salesforce account controls when necessary.
- Review build scripts, workflows and generated archives before distribution. The packaged desktop and browser editions deliberately exclude real `.env` and local org-specific metadata caches.
- Never post tokens, customer metadata, full logs or sensitive screenshots to **public GitHub Issues or PRs**.

## Permission findings

- Repository XML alone is not equivalent to Salesforce runtime authorization for an active user.
- **Yes:** supported grant evidence; **No:** confirmed denial; **Review:** missing or incomplete evidence. Evidence and caveats must be considered when acting on a finding.
- Object CRUD, field FLS, compound fields and relationships are evaluated separately. Org-dependent conclusions require an authenticated, sufficiently authorized connection.
- The tool does not autonomously modify Salesforce permission metadata, users or org settings.

## Desktop application and distribution

- The **Electron desktop folder ZIP** is not a standalone installer or single EXE. Distribute the complete packaged folder.
- The desktop executable is **unsigned**. Do not disable Microsoft SmartScreen, WDAC, antivirus or corporate endpoint policies to run it; obtain IT approval or a signed build.
- The renderer runs with sandbox restrictions and the local API uses loopback networking. Salesforce browser login is delegated to Salesforce CLI.
- Per-user configuration and startup diagnostics are stored in Electron's user-data folder, not in the shared ZIP. Diagnostic reports can still disclose context; review content before sharing.
- Excel reports can contain proprietary object/field names and Apex paths; save and distribute them through approved channels.

## Public repository and reuse

Public GitHub visibility permits source viewing but does not itself provide a reuse or redistribution license. No root `LICENSE` file is currently present; confirm rights and ownership with the maintainer before reusing the code or distributing derived builds.

For suspected vulnerabilities, contact the repository maintainer privately rather than disclosing sensitive details in a public issue.
