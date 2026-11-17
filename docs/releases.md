# Release process — Windows portable

**Release publishing is deliberately separate from PR merges and development builds.** Only an approved, tested tag on `main` can publish a Release. GitHub Packages is not used.

## Two distribution channels

| Channel | Produced by | Intended use |
| --- | --- | --- |
| Temporary CI artifact | Manual [Build Windows Portable Analyzer](../.github/workflows/windows-portable.yml) run | Smoke testing or ad-hoc internal sharing; expires after 30 days |
| Versioned GitHub Release | [Publish Windows Portable Release](../.github/workflows/release-windows.yml) on a pushed version tag | Approved, traceable Windows ZIP with generated release notes and SHA256 checksum |

Both use the **same reusable Windows packaging workflow**, which compiles the backend, runs regression tests, builds the React UI, bundles Node.js and dependencies, runs packaged smoke checks, and rejects credential-bearing `.env` files.

## Publishing checklist (release owner only)

1. Verify all desired PRs were **merged into `main`** and UAT is complete.
2. Update the root `package.json` **and `package-lock.json`** version in a PR (for example, `0.1.1`) and merge it after review. Update [CHANGELOG](../CHANGELOG.md) with release highlights.
3. After merging, fetch the verified `main` commit:
   ```bash
   git fetch origin
   git checkout main
   git pull --ff-only
   ```
4. **Explicitly tag this approved commit** and push the tag:
   ```bash
   git tag -a v0.1.1 -m "Salesforce Repository Analyzer v0.1.1"
   git push origin v0.1.1
   ```
5. The release workflow verifies the tag format, confirms the tagged commit is on `origin/main`, and verifies the package version. It calls the reusable Windows build, runs all packaging checks and publishes a Release with the ZIP and `SHA256SUMS.txt` if successful.
6. Open the new [Release](https://github.com/Shubhamu68/SalesforceRepositoryAnalyzer/releases), review notes, download/extract/test the published ZIP, and share the Release link with authorized users.

Use `vMAJOR.MINOR.PATCH`; optional prerelease suffixes (for example `v0.2.0-beta.1`) must match `package.json`'s version exactly.

## Safety checks

- The workflow will **not** publish for an untagged commit, a tag not reachable from `main`, mismatched package version, failed build/tests, missing ZIP, or an existing Release with that tag.
- Source `.env` is not bundled; the ZIP contains only `.env.example`.
- Release artifacts of this private repository require authorized GitHub access.
- A Release does not update previously downloaded ZIP files. Tag a new version for new features.
- Only the repository owner/maintainer should approve, tag, or merge releases.
