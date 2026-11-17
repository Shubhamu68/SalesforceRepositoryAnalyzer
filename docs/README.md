# Documentation

Start with the current user/developer guides; the historical notes are preserved for traceability and must not be treated as installation instructions for today's `main`.

## Current guides

| Guide | Subject |
| --- | --- |
| [Architecture](architecture.md) | Components, execution, security decisions and output |
| [Development setup](setup/development.md) | Clone, dependencies, local dev, tests and configuration |
| [Windows portable setup](setup/windows-portable.md) | End-user launcher, artifact versus Release, troubleshooting |
| [Security](security.md) | Credentials, access verification and repository boundaries |
| [Releases](releases.md) | Versioning, manual approval and tagged Windows ZIP publication |
| [Repository settings](repository-settings.md) | Maintainer-only About, branch cleanup and protection |
| [SOQL aggregate analysis](features/soql-aggregates.md) | Parser, field extraction, limits and UAT |
| [Org permission fallback](features/org-access-fallback.md) | Repository-first effective-permission verification |

## Historical design and implementation notes

See [Historical notes](history/README.md) for previous feature write-ups, migration notes and archived patches. These documents record what changed at that time and may contain obsolete procedures.

The current software version is in [`package.json`](../package.json). The source of truth for behavior is current source code and regression tests.
