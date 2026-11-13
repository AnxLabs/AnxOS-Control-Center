# Phase 9 release candidate: approval request

Prepared 2026-11-13. Nothing in this document has been run yet; every step
below needs the owner's explicit approval first.

## Goal

A signed release candidate of this branch that installs, runs, updates and
uninstalls in Windows Sandbox with **Smart App Control on**, with Defender
and SmartScreen enabled, without changing any Windows security setting.

## What would be pushed

| Item | Value |
| --- | --- |
| Source branch (local) | `claude/anxos-control-center-simplify-8080f1` |
| Commit | the branch tip at approval time (recorded in the request message) |
| Remote branch to create | `rc/2.0-build210-phase9` on `origin` (`AnxLabs/AnxOS-Control-Center`, **public** repository) |
| Base | `chore/build-210` (`8745dcce`) + the Phase 4–9 commits of this branch |
| Version identity | `release.json`: 2.0 Build 210, channel "Private Alpha"; artifacts named `2.0-build210` |

No tag is pushed and no branch is merged.

## How the build would run (recommended: Option A)

```bash
git push origin claude/anxos-control-center-simplify-8080f1:refs/heads/rc/2.0-build210-phase9
gh workflow run "Desktop Release" -R AnxLabs/AnxOS-Control-Center --ref rc/2.0-build210-phase9
```

The existing **Desktop Release** workflow (`.github/workflows/windows-release.yml`,
unchanged) runs:

1. `static-validation`: `node --check` on every tracked JS file.
2. `rc-validation` (Ubuntu): `npm run rc:validate` under xvfb.
3. `windows` (windows-latest): `npm run dist:win -- --publish never --no-increment-build`
   with the Azure Trusted Signing secrets. This now also signs the 25 NSIS
   plugins (`scripts/sign-nsis-toolsets.js`) and the files in
   `build.win.signExts`, then runs `scripts/verify-windows-signatures.js`,
   which now fails the job if any `.exe`, `.dll`, `.node`, `.ps1` or NSIS
   plugin is unsigned, tampered or signed by the wrong publisher.
4. `linux`: desktop `.deb`/AppImage and the Agent `.deb` (which now refuses
   dirty source and records its commit).
5. `publish`: **skipped**, because it only runs for tags
   (`if: startsWith(github.ref, 'refs/tags/')`). The last RC run on
   2026-11-07 (`workflow_dispatch` on `chore/build-210`) shows the same:
   static-validation, rc-validation, linux, windows succeeded; publish
   skipped.

### What becomes accessible, and to whom

| Thing | Where | Who can see it | How long |
| --- | --- | --- | --- |
| Source of the branch | `AnxLabs/AnxOS-Control-Center`, branch `rc/2.0-build210-phase9` | Anyone (public repository) | Until deleted |
| Workflow logs | Actions run page | Anyone | Repository setting: 90 days |
| Signed Windows installer + portable `.exe`, `latest.yml` | Workflow artifact `anxos-control-center-windows` | Anyone signed in to GitHub with read access, which for a public repository means any GitHub user | 14 days |
| Linux packages and Agent `.deb` | Workflow artifact `anxos-control-center-linux` | Same | 14 days |
| RC validation log | Workflow artifact `rc-validation-log` | Same | 7 days |
| Release in `AnxOS-Control-Center-Releases` | — | **Not created** | — |
| Website / update manifest | — | **Not changed** | — |

The artifacts are not linked from anywhere and no updater sees them, but they
are not private. If that is not acceptable, the alternatives are a private
fork or a self-hosted runner, both of which need new setup.

### Option B (not recommended for this test)

Pushing a tag such as `v2.0-build210-rc1` runs the same build **and the
`publish` job**, which creates a **public pre-release** in
`AnxLabs/AnxOS-Control-Center-Releases` with every installer and a pointer
release in the source repository. That is public distribution and falls
under the `🚀 publish` gate in AGENTS.md.

## Signing requirements

- Existing repository secrets (names checked, values never read):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`,
  `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`. No new secret, certificate or
  service.
- Certificate identity stays **Anjo ROSIMO** (Microsoft ID Verified CS);
  the displayed publisher is AnxLabs.
- Signing volume: the existing build already signs the app and roughly 180
  bundled executables; this build adds about 34 signatures (25 NSIS plugins,
  6 Electron DLLs, 2 native modules, 1 PowerShell script). It uses the
  existing Azure Trusted Signing account; whether that stays within its
  plan's monthly signature allowance has not been checked.
- The `TrustedSigning` PowerShell module is installed from PSGallery on the
  runner, as electron-builder already does.

## Acceptance once the build exists (all local, nothing published)

1. Download the artifacts with `gh run download`; check SHA-256 against
   `latest.yml`; run the installer signature check and the signature
   coverage check on every file.
2. Scan the installer, portable build and unpacked app with Microsoft
   Defender on this PC (scan only, `-DisableRemediation`).
3. Windows Sandbox, Smart App Control **on**, networking **on**, installer
   marked as downloaded (Mark of the Web, so SmartScreen evaluates it):
   - silent install: program files, Helper task, no Code Integrity blocks,
     every installed `.exe`/`.dll`/`.node`/`.ps1` validly signed;
   - first launch with the bundled Local Agent healthy;
   - reinstall over it, keeping user data;
   - uninstall, keeping user data;
   - the branded installer pages (UI tour), including `/NOHELPER`.
4. Windows Sandbox (Defender antivirus is not active inside Windows Sandbox,
   so Defender is covered by step 2).
5. Record results in `docs/PHASE9_AUDIT.md` and report.

Known limit: upgrading from the published Build 209 cannot be tested with
Smart App Control on, because Build 209 itself cannot install there; that
path is tested with Smart App Control off inside the sandbox only.

## Exact approval needed

> Approve pushing `claude/anxos-control-center-simplify-8080f1` at commit
> `<tip>` to `origin` as `rc/2.0-build210-phase9` and running the "Desktop
> Release" workflow on it with `workflow_dispatch` (no tag, no release; signed
> artifacts kept as workflow artifacts for 14 days).
