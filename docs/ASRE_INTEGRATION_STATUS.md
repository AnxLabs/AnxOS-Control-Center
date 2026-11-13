# ASRE integration status for AnxOS Control Center

Date: 2026-11-13. Source: read-only inspection recorded in
`docs/PHASE9_AUDIT.md` §1 (AnxBrowse `main` `91ae531` and its
`isolation-test-environments` / `amdp-reports` / ALSP pilot branches,
Release Fabric `main` `20a3db5`, Anx-Creds `docs/AMDP.md`). Nothing outside
this repository was changed. Owner direction (2026-11-13): do not force
incompatible integrations, do not rebuild shared services inside AnxOS, and
keep the credential-defense AMDP separate from any deployment-policy system
unless its owners extend its scope.

## Summary

| Part | Verified today | Usable by AnxOS now? |
| --- | --- | --- |
| Release Fabric | Local release orchestrator; already has an AnxOS config (in the RF repo) that runs this repo's validation tiers with caching and gates `github-prerelease` / `public-stable` behind approvals | Yes, as a verification runner. It does not build or sign the desktop installers (the GitHub "Desktop Release" workflow does) |
| SAUS | Rust library: Ed25519 signed manifests with pinned keys, bounded staging, activation journal, health acknowledgement, rollback, replay floor | No: no transport, no installer, no AnxOS adapter, three-number versions only, on unmerged AnxBrowse branches |
| ALSP | Descriptor/adapter glue (`anxlabs-shared-project/v1`), dependency ordering, Git/relay discovery | No: the registry only accepts two fixed adapter sets that name a SAUS update adapter AnxOS lacks |
| AMDP | **AnxLabs Mutual Defense Protocol v1**: credential and compromise containment between Anx-Creds, its Sentinel service and AnxBrowse | Not applicable to releases: its contract puts updaters out of scope. It is not a deployment-policy system |

## What AnxOS uses instead (and keeps)

These are the release controls that exist and are enforced today; Phase 9
strengthened them without creating a parallel shared service:

- **Deployment and release policy:** the ADP approval matrix (AGENTS.md),
  GitHub tag-only publishing in `windows-release.yml`, the separate
  `promote-release.yml` step, and Release Fabric's protected environments
  and typed approval phrases.
- **Update authenticity:** HTTPS release metadata with SHA-256 and size, now
  plus an Authenticode publisher check of the installer before it is opened
  (`src/shared/installerSignature.js`, pinned certificate identity).
- **Artifact integrity at build time:** Azure Trusted Signing in CI and the
  release gate `scripts/verify-windows-signatures.js`, now covering every
  `.exe`, `.dll`, `.node`, `.ps1` and NSIS plugin.
- **Provenance:** Agent `.deb` packages record their source commit and tree
  state; desktop builds record the commit in `release-build.json`.

## Missing contracts and the shared-project changes they need

### SAUS (owner: the SAUS/AnxBrowse relay)

| Missing | Why AnxOS needs it | Change needed in SAUS |
| --- | --- | --- |
| A home outside AnxBrowse's branches | AnxOS cannot depend on an unmerged branch of another product | Move `saus-core` to a shared repository or merge it to AnxBrowse `main` with a stable path |
| Version + build ordering | AnxOS releases are `2.0` Build `210`; SAUS policy accepts `major.minor.patch` only | Add an explicit ordering extension (the SAUS architecture doc already calls for this before AnxOS reuse) |
| Transport | SAUS reads only local fixture files | SAUS M5: a fetch-only transport (static HTTPS feed) that cannot choose commands, roots or keys |
| A Windows installer adapter | AnxOS updates are NSIS installers handed to Windows, with an elevated Agent task | SAUS M4 "Control Center adapter": stage the signed installer, keep the existing handoff, report health; must not replace the Authenticode check |
| Production key custody | Signed manifests need an owner-held Ed25519 key | Owner decision and key-management design; no key exists today |
| Agent updates | Agents update by `apt-get install` of a `.deb` (Linux) or desktop push (checkout installs) | Out of SAUS scope today; would need a separate, approval-gated adapter |

### ALSP (owner: the ALSP pilot relay)

| Missing | Change needed in ALSP |
| --- | --- |
| A descriptor AnxOS can truthfully file | Let `adapters` list only the contracts a project actually has (for AnxOS today: `checks: rfab-check/v1`, no `updates`, no `security`) instead of requiring one of two fixed sets |
| Component compatibility data | A field for component versions and required minimums (desktop ↔ Agent protocol 1, Agent ≥ the Phase 7.1 build for AnxNet) so ALSP can report ordering such as "update the Agent first" |
| A merged home | Merge the pilot or move `shared/alsp` with SAUS |

Once ALSP accepts it, AnxOS would add an `alsp.project.json` (disabled by
default) pointing at `AGENTS.md`/the Phase handoffs as its relay.

### AMDP (owner: Anx-Creds)

No change is requested. AMDP v1 stays a credential-defense protocol. If
AnxLabs wants a shared **deployment-policy** system, it should be a new
contract (or an explicit AMDP v2 scope decided by Anx-Creds' owners) with:
environments (development, test, private-alpha staging, production),
decisions (allowed / blocked / approval required, with reasons), evidence
inputs (signature, provenance, test results), owner-only approval, and
fail-closed behaviour when evidence is missing. Until then AnxOS keeps the
policy controls listed above.

### Release Fabric (owner: Release Fabric)

| Missing | Change needed |
| --- | --- |
| Building and signing the Windows artifacts | Optional: an RF task that runs `npm run dist:win` on a Windows runner with the Azure Trusted Signing environment, then `verify-windows-signatures.js`. Today the GitHub workflow does this and remains authoritative |
| Agent `.deb` build | An RF task wrapping `node scripts/build-agent-deb.js --download-node`, which now refuses dirty or unknown source and records provenance |
| Provenance link | Record RF run IDs next to `release-build.json` / `agent-release.json` |

## Decisions for the owner

1. Where SAUS and ALSP should live once they leave the AnxBrowse branches.
2. Whether to schedule the SAUS AnxOS adapter (M4) and who holds the
   manifest signing key.
3. Whether a deployment-policy system is wanted, and whether it is AMDP v2
   (Anx-Creds' owners) or a new shared contract.
