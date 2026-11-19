# Security practices

The Analyzer reads Salesforce repository metadata locally and can optionally connect to a Salesforce org to verify permission evidence. Treat source code, org metadata, logs and report outputs as organization-controlled information.

## Credentials

- Never commit `.env`, Salesforce tokens, client IDs/secrets containing real values, certificates or test-user information. The tracked `.env.example` contains only empty credential placeholders.
- Avoid distributing a client secret to untrusted end users. Client credentials are reusable by recipients who receive them.
- Provide permissions at minimum scope and share configuration through approved organization-managed channels.
- Review CI changes for secrets and environment expansion. The portable packaging step actively rejects a packaged `.env`.
- Do not paste live customer records, API tokens or full logs into public GitHub issues.

## Permission findings

- Repository permissions are not equivalent to a complete effective Salesforce authorization decision.
- **Yes:** established repository or Salesforce evidence; **No:** confirmed denial; **Review:** missing or incomplete evidence. The UI identifies the relevant source.
- Object CRUD, field FLS, compound fields, and relationship metadata are evaluated separately. Org-dependent checks require valid authorization.
- The tool does not autonomously deploy XML permissions, alter users, or change a Salesforce org.

## Report and artifact handling

- Excel reports may contain client object/field metadata and Apex paths; store them in a controlled folder.
- Publish official portable versions only after UAT. Portable and desktop packages allowlist application config files and exclude local org-specific field/relationship caches.
- Follow organizational data-retention requirements for analysis outputs and downloaded ZIPs.

For a potential security vulnerability, contact the repository owner privately rather than publishing sensitive exploitation details in an issue.
