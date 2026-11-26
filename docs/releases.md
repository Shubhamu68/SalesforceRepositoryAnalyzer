# Builds, distribution and GitHub Releases

**Do not confuse source version, an emailed ZIP, a temporary GitHub Actions artifact, and an official tagged GitHub Release.** Changes merged into `main` do not automatically publish a release or update previously distributed ZIPs.

## Distribution channels

| Channel | Produced by | Contents and intended use |
| --- | --- | --- |
| **Electron desktop-folder ZIP** | [Build Windows Desktop Folder ZIP](../.github/workflows/windows-desktop.yml), run manually or for selected PRs | `SalesforceRepositoryAnalyzer-Desktop-Unpacked.zip` containing `win-unpacked/Salesforce Repository Analyzer.exe`, supporting DLLs, `resources`, and runtime. This is the format supplied separately to initial v0.1.0 recipients. CI artifact, **not an official GitHub Release**. |
| Browser portable CI artifact | [Build Windows Portable Analyzer](../.github/workflows/windows-portable.yml), run manually | `SalesforceRepositoryAnalyzer-Windows-Portable.zip` with bundled runtime and `Start Analyzer.cmd`. For temporary smoke testing or approved ad-hoc sharing. |
| **Official tagged GitHub Release — browser portable only** | [Publish Windows Portable Release](../.github/workflows/release-windows.yml) after an approved `v*` tag | Versioned **browser portable** ZIP, generated release notes and `SHA256SUMS.txt`. **The current workflow does not package or publish the Electron desktop ZIP.** |

Temporary GitHub Actions artifacts have a configured 30-day retention period and may be wrapped in an outer archive. This public repository does not currently have a published `v0.1.0` GitHub Release. Public visibility does not automatically make any emailed ZIP a verified release.

## Electron desktop distribution

1. Review and test the proposed source commit. Do not distribute an unverified build.
2. Run the [desktop folder ZIP workflow](../.github/workflows/windows-desktop.yml) for the approved commit; it builds the backend/frontend, runs regressions, stages the app, packages the `win-unpacked` folder and smoke-tests the packaged backend.
3. Download and **fully extract** `SalesforceRepositoryAnalyzer-Desktop-Unpacked.zip`. Test `win-unpacked/Salesforce Repository Analyzer.exe` with its supporting files intact.
4. Share the approved ZIP and [Windows desktop setup guide](setup/windows-desktop.md) through an authorized distribution channel. Record the source commit and build/run ID with the shared package.
5. Do **not** provide a GitHub Release link for this Electron ZIP unless a dedicated release-publishing process is implemented, approved and validated.

## Publishing the existing browser-portable GitHub Release (maintainer only)

The current `release-windows.yml` workflow publishes the **browser-based portable** package; it cannot be used to publish the Electron desktop package without further changes.

1. Confirm desired PRs are merged to `main` and testing/UAT is approved.
2. Keep the root, web and Electron `package.json` and matching lockfile root versions aligned for a new version (for example, `0.1.1`), update [CHANGELOG](../CHANGELOG.md), and merge through review.
3. Pull the approved `main` commit:

   ```bash
   git fetch origin
   git checkout main
   git pull --ff-only
   ```

4. Tag the approved commit and push it:

   ```bash
   git tag -a v0.1.1 -m "Salesforce Repository Analyzer v0.1.1"
   git push origin v0.1.1
   ```

5. The workflow verifies semver, package version and `main` ancestry, then runs browser portable packaging tests and creates an immutable versioned Release with ZIP and SHA256 checksum if successful.
6. Verify the published [Releases page](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/releases) before distributing its link.

Use `vMAJOR.MINOR.PATCH` (optional prerelease suffix matching `package.json`). **Do not tag merely to distribute the Electron ZIP**; the current tag workflow produces the different browser-based edition.

## Safety and access

- Both packaging workflows reject a real packaged `.env`; bundled configuration uses only the safe `.env.example`. Do not package CLI auth files, tokens, private Salesforce metadata or customer data.
- The repository is **public**. Review source and Git history for sensitive content, and confirm redistribution rights and company policy before sharing builds. Public source access is not a software license.
- Failed CI/tests or incomplete UAT are release blockers. Review workflow status rather than relying on a README badge.
- Only an authorized maintainer should approve and tag releases; do not merge or publish as an incidental result of a documentation change.
