# Phase 9 audit: release, update and ASRE state (P9-A)

Date: 2026-11-13. Branch `claude/anxos-control-center-simplify-8080f1`
(= `chore/build-210` `8745dcce` + 44 Phase 4–8 commits, last `73563e47`).
Inspected read-only: this repository; `A:/AnxLabs/10-Products/Release-Fabric`
(`main` `20a3db5`); AnxBrowse `main` `91ae531` and its worktrees
`AnxBrowse-alsp-pilot` (`integration/anxbrowse-real-disposable-20261111`
`6e078a6`) and `AnxBrowse-amdp` (`amdp-reports` `fc360a5`); Anx-Creds
`docs/AMDP.md`; the installed desktop app on this PC. Nothing outside this
repository was edited.

Labels: **Verified** (seen working, with evidence named), **Existing but
incomplete**, **Missing**, **Blocked** (needs an owner decision or another
project's change), **Historical** (documented in the past, not re-checked),
**Proposed** (designed, not built).

## 1. What ASRE actually is today

ASRE is not a running system. Its four parts exist in very different states,
and two of them are not where or what the Phase 9 brief assumes.

| Part | Where it lives | Real state | Label |
| --- | --- | --- | --- |
| **SAUS** (Shared AnxLabs Update Service) | `shared/saus` in AnxBrowse branches `isolation-test-environments` / `amdp-reports` / the ALSP pilot branch. **Not on AnxBrowse `main`.** | Rust library `saus-core` 0.1.0 (`publish = false`). Ed25519 domain-separated signed manifests with locally pinned keys, bounded staging, activation journal, health acknowledgement, rollback, replay floor. **No network transport, no installer, no app adapter, no service.** 23/23 core tests and a Release Fabric bridge fixture (9/9) are recorded by its relay (2026-11-11), not re-run here. | Existing but incomplete |
| **Release Fabric** (`rfab`) | `A:/AnxLabs/10-Products/Release-Fabric` (Python 3.11 + PyYAML, v0.2 private pre-release) | Working local orchestrator: DAG, cache, signed artifacts with provenance, typed approvals, protected environments, rollback, audit chain. Has an **AnxOS config** in its own repo (`private/anxlabs/anxos-control-center/`) that reads the tier lists from this repo's `scripts/release-validation.js` and gates `github-prerelease` / `public-stable` behind approvals. It does not build the desktop installers (the GitHub "Desktop Release" workflow does) or the Agent `.deb`. | Existing but incomplete (for AnxOS) |
| **ALSP** (AnxLabs Shared Projects) | `shared/alsp` on the AnxBrowse ALSP pilot branch only | New (2026-11-11) descriptor/adapter glue: `anxlabs-shared-project/v1` descriptors, dependency ordering, Git/relay discovery, thin adapters onto AnxLabs Work, RF checks, AMDP and the SAUS fixture. No daemon or database. **Its registry only accepts two hard-coded adapter sets, both of which name a SAUS update adapter AnxOS does not have**, and its own adoption map lists AnxOS as "not registered". | Existing but incomplete; AnxOS adoption Blocked |
| **AMDP** | `Anx-Creds/docs/AMDP.md` (+ Rust `src/amdp.rs`) | **AnxLabs Mutual Defense Protocol v1**: credential and app-compromise containment between Anx-Creds, its Sentinel service and AnxBrowse ("reports only narrow", Sentinel decides releases of credentials). Its contract states **"Updater … out of AMDP scope today"**. It is not a deployment or release policy engine. | Exists, but **not the system the Phase 9 brief describes**; Blocked |

Consequences:

- Building a SAUS adapter, a deployment-policy "AMDP" or an AnxOS ALSP
  registration inside this repository would either duplicate a shared system
  or change another project's shared code. Both are ruled out by the brief
  and by the SAUS/ALSP relays, which name their owners and next writers.
- The deployment and release gates that **do** exist and are enforced are:
  the ADP approval matrix (AGENTS.md), Release Fabric's protected
  environments and typed approval phrases, the GitHub environment and
  signing secrets, and the `promote-release.yml` promotion step.

## 2. Capability matrix (this product)

### Packaging and installation

| Capability | State | Evidence / notes |
| --- | --- | --- |
| Windows NSIS installer (per-user, assisted, directory choice, desktop + Start Menu shortcuts, uninstaller) | Verified | `package.json` `build.nsis`; installed copy on this PC registers `AnxOS Control Center 2.0.0` with a quiet uninstall string |
| Installer registers the elevated Local Agent scheduled task and removes it on uninstall | Existing | `windows/installer.nsh`, `install-agent-task.ps1`; aborts with a repair hint if the Agent cannot start |
| Windows portable build | Existing | `win.target` portable |
| Authenticode signing via Azure Trusted Signing in CI | Verified | Installed `AnxOS Control Center.exe`: status Valid, subject `CN=Anjo ROSIMO, O=Anjo ROSIMO, L=calgary, S=ab, C=CA`, issuer `Microsoft ID Verified CS AOC CA 03` |
| Uninstall keeps user data (`%APPDATA%\AnxHub`, servers, backups) | Existing, not re-verified | electron-builder default keeps app data; no explicit "also remove my data" choice |
| Uninstall registry metadata | Existing but incomplete | `DisplayVersion` is `2.0.0` (no build), `Publisher` is `Anx` while the signature says `Anjo ROSIMO` |
| Repair | Existing but incomplete | Re-running the installer repairs; Agent Control has "Stop Old Local Agent and Repair"; no single "Repair" entry |
| Linux desktop AppImage + `.deb` | Existing (built in CI) | `build.linux`; install guide covers Linux; not run in this audit |
| Linux Agent `.deb` (systemd, preserves `/var/lib`, sudoers rule for start/stop/restart) | Verified | Built and installed on Anxlab 2026-11-13 (Phase 8 maintenance); maintainer scripts byte-identical to 209 |
| Agent `.deb` provenance (source commit, clean tree) | Missing | `agent-release.json` has version, tag and build time only; the Anxlab build needed a hand-written `SOURCE_COMMIT` |
| Linux packages built from a Windows checkout get CRLF | Verified hazard | AGENTS.md lesson 2026-11-13 |

### First run and onboarding

| Capability | State | Notes |
| --- | --- | --- |
| Onboarding wizard (welcome, local Agent, connect Agent, setup type) | Existing | `app.js` onboarding functions; `docs/ONBOARDING_VALIDATION.md` (Historical) |
| Returning users are not re-onboarded | Existing | `reconcileOnboardingForExistingSetup` |
| Readiness checks (OS, RAM, disk, runtimes) at first run | Existing but incomplete | Home and Computers show live readiness (Phase 4/8); not a single first-run checklist |
| "Create my first server" path for beginners | Existing | Add Server / Marketplace; beginner flow not re-tested in a clean install |

### Updates

| Capability | State | Notes |
| --- | --- | --- |
| Discover releases (website manifest, then GitHub releases), compare version + build | Verified (unit) | `src/services/updateManager.js`; `versioning-smoke` |
| Download with size + SHA-256 check, re-checked before install | Verified (unit) | `verifyUpdateArtifact` |
| Hand the installer to Windows (never silent execution) | Existing | `shell.openPath`; pending-install record survives restart |
| Data-schema rollback guidance (SAFE / DEGRADED / UNKNOWN) | Existing | Manifest `dataSchema` contract |
| **Signed release metadata** | Missing | The SHA-256 is only as trustworthy as the HTTPS source; no manifest signature (SAUS would provide this) |
| **Authenticode check of the downloaded installer before handoff** | Missing | `win.verifyUpdateCodeSignature` is an electron-updater option; this app does not use electron-updater |
| Release channels (Stable / Beta / Private Alpha / Development) | Existing but incomplete | Channel is a label; selection is "not pre-release unless allowed"; no per-channel feed or isolation |
| Downgrade / replay protection | Existing but incomplete | Strict "newer than installed" comparison; no signed sequence floor |
| Agent compatibility (protocol version range, minimum Agent version) | Verified (unit) | `nodeService.js`, `agent-compatibility-smoke` |
| Agent updates (desktop push for checkout Agents; `.deb` via apt for packaged Agents) | Existing | Push refuses package-managed Agents; an Agent update stops its servers (AGENTS.md lesson) |
| Update history | Existing but incomplete | Pending-install record; no readable history list |

### Release production

| Capability | State | Notes |
| --- | --- | --- |
| CI build + sign + RC pre-release, owner gates, promotion | Verified (Historical runs) | `windows-release.yml`, `promote-release.yml`, AGENTS.md RC workflow |
| Update manifest with checksums and data-schema contract | Existing | `scripts/write-update-manifest.js` |
| Release Fabric verification of this repo | Existing (in RF repo) | `private/anxlabs/anxos-control-center/release-fabric.yml`; 89-check benchmark recorded by RF |
| Provenance record per artifact (commit, dirty state, toolchain) | Existing but incomplete | RF provides it for what RF builds; CI artifacts and the Agent `.deb` carry no commit |

### Security and reliability

| Capability | State | Notes |
| --- | --- | --- |
| AnxNet custom UDP channel | Existing, **not independently audited** | `docs/ANXNET_SECURITY_REVIEW.md` says so explicitly |
| Credential "undecryptable" preservation copies | Existing, **unbounded** | 646 copies (588 KB) on this PC from a July 27–28 burst; three writers (`nodeCredentialStore`, `secureSessionStore`, `securityService`) never prune |
| Docker action route | Verified fixed in source | `73563e47` (Phase 8 follow-up) |

## 3. Integration map

```text
 Git commit ──► CI "Desktop Release" (build, Azure Trusted Signing, RC pre-release)
     │                    │
     │                    └─► releases repo + website manifest (SHA-256, data-schema contract)
     │                                         │
     ├─► Release Fabric (verify tiers, cache,   ▼
     │    protected envs, approvals)      updateManager (discover, size+SHA-256,
     │                                     [NEW] Authenticode publisher check,
     └─► build-agent-deb (Agent .deb,       hand off to Windows installer)
          [NEW] source commit + clean tree)
                                          SAUS (future): signed manifest, staging,
 ALSP (future): AnxOS descriptor once        activation journal, rollback — via an
   its registry accepts AnxOS's real         AnxOS adapter after SAUS M2/M3
   adapter set
 AMDP: credential defense only; release policy stays with ADP + RF approvals
```

## 4. Component compatibility (current)

| Component | Version / identity | Compatible with |
| --- | --- | --- |
| Desktop (this branch) | 2.0 Build 210 (release.json), channel "Private Alpha" | Agent protocol 1; checks `minimumAgentVersion` when an Agent reports it |
| Agent `.deb` on Anxlab | 2.0-build210 (pre-release `v2.0-build210-anxlab-maint`, `52dd3967`) | Desktop 209 installed copy reconnected (Phase 8 maintenance) |
| Agent on the OVH VPS | 2.0-build207 `.deb` (memory, 2026-10-30; not re-checked) | Protocol 1 |
| AnxNet | Ships in the Agent since Phase 7.1 | Needs Agent ≥ the Phase 7.1 build for Agent-side AnxNet |
| Mobile companion | Phase 7 web UI served by the desktop/Agent | Same desktop build |
| SAUS / ALSP | Not integrated | — |

## 5. Blockers and owner decisions

| # | Blocker | Why it needs you | Options |
| --- | --- | --- | --- |
| B1 | SAUS has no AnxOS adapter, no transport, no build-number ordering, no production key custody, and lives on unmerged AnxBrowse branches | The SAUS relay schedules AnxOS as M4 after AnxBrowse M2/M3; changing shared code or its home is that project's call | (a) wait for SAUS M2/M3; (b) approve moving `saus-core` to a shared repo and extending ordering to version+build; (c) approve an AnxOS adapter milestone now |
| B2 | "AMDP" in the brief (deployment policy) ≠ AMDP v1 (credential defense, updaters out of scope) | Extending a security contract is an owner decision | (a) keep release policy in ADP + RF protected environments (current, enforced); (b) define an AMDP v2 release-policy scope in Anx-Creds |
| B3 | ALSP registry accepts only the pilot's fixed adapter sets | Changing ALSP is the pilot owner's change | Approve an `adapters` schema that allows "none" / per-project sets, then add `alsp.project.json` here |
| B4 | Production signing for SAUS manifests (Ed25519 key custody) | Signing infrastructure changes need explicit approval | Decide key custody before any signed-manifest client ships |
| B5 | Clean-install tests need a disposable Windows environment | Windows Sandbox / a VM must be enabled by you | Enable Windows Sandbox, or name a disposable VM |
| B6 | Publishing, pushing, RC builds, installer runs on this PC | ADP gates | Separate approvals as always |

## 6. Plan (prioritised, independent of the blockers first)

1. **P9-F/9.3 (now):** verify the Authenticode signature and publisher of a
   downloaded Windows installer before handing it to Windows; refuse an
   unsigned, invalid or foreign-signed installer in packaged builds.
2. **P9-C/9.4 (now):** stamp the Agent `.deb` with its source commit and
   clean-tree state, refuse a dirty tree unless explicitly allowed, and
   accept an explicit commit when built from an exported archive.
3. **P9-F/9.8 (now):** bound the credential "undecryptable" preservation
   copies (keep the newest few per store), without touching current files.
4. **P9-B/9.1 (now):** correct the uninstall publisher metadata to the
   signing identity's name if you confirm the display name to use.
5. **P9-E/9.7:** show the new verification result (signature, publisher,
   checksum) in Settings → Updates, in the existing layout.
6. **Blocked until decisions B1–B5:** SAUS client/adapter, signed manifests,
   channel feeds, AMDP release policy, ALSP registration, clean-install
   verification in a disposable environment.
7. **P9-G/H:** private-alpha documents refreshed from what is verified;
   handoff with evidence and remaining approvals.
