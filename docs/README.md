# Documentation

Start with the **Electron desktop setup** if you received an approved desktop-folder ZIP. The current source baseline is v0.1.1; previously distributed builds do not automatically update. The browser-based portable launcher and source-code developer setup are separate workflows. Historical notes are preserved for traceability and may describe superseded authentication or deployment approaches.

## Current guides

| Guide | Subject |
| --- | --- |
| [Windows desktop setup](setup/windows-desktop.md) | **Primary recipient guide** for the Electron folder ZIP, executable, CLI login and troubleshooting |
| [Electron desktop build notes](../desktop/electron/README.md) | Maintainer packaging instructions for the `win-unpacked` distribution |
| [Windows browser-portable setup](setup/windows-portable.md) | Separate `Start Analyzer.cmd` launcher package |
| [Development setup](setup/development.md) | Clone, local development API/UI, tests and optional CLI authorization |
| [Architecture](architecture.md) | Components, analysis flow and output |
| [Security](security.md) | Public source precautions, credentials, read-only scope, unsigned executable |
| [Builds and releases](releases.md) | Difference between emailed ZIP, CI artifact and official tagged browser-portable Release |
| [Repository settings](repository-settings.md) | Maintainer-only GitHub About and branch governance checklist |
| [Dynamic SOQL v0.1.1 design and test coverage](features/dynamic-soql-resolution-v011.md) | Merged AUE implementation, resolution contracts and limitations |
| [SOQL performance](soql-analysis-performance.md) | Metadata batching, dependency-validated reuse and release-owned defaults |
| [Development roadmap](features/milestone-2-coverage-roadmap.md) | Historical milestones and v0.1.1 scope closure |
| [v0.1.2 Stack Trace integration](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/issues/58) | Planned AUE integration; not yet implemented |
| [SOQL aggregate analysis](features/soql-aggregates.md) | Parser, field extraction, limitations and UAT |
| [Org permission fallback](features/org-access-fallback.md) | Repository-first effective permission verification |

## Historical design and implementation notes

See [Historical notes](history/README.md) for earlier feature write-ups, migrations and archived patches. These capture implementation history; they should not override current setup or authentication guides.

The root [`package.json`](../package.json) records the source version. The current code and regression tests, not historical prose, govern actual behavior. A distributed ZIP should also be tied to its source commit and build ID.
