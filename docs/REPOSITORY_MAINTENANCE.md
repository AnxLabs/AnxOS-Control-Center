# Repository Map & Cleanup Audit

**Audit date:** 2026-11-06  
**Repository:** `AnxLabs/AnxOS-Control-Center`  
**Source audited:** GitHub `dev` @ `8419364bdbfee19bb7e0cd91f281575367e95ebf`  
**Scope:** repository organization and candidate cleanup; no application or runtime behavior changed

This document is a **time-stamped audit**, not a release approval or an authorization to delete history. Before any cleanup is merged, compare it to the latest Git tree, read the active development relay, and confirm no other agent is editing the same workspace.

## Where things live

| Area | Purpose | Treatment |
| --- | --- | --- |
| `main.js`, `preload.js`, `app.js`, `index.html`, `styles.css` | Electron process, context-isolated bridge, renderer and styling | Product source — keep |
| `src/`, `agent/`, `backend/`, `config/` | Runtime services, standalone Agent, account handlers and templates | Product source — keep |
| `scripts/`, `test-helpers/` | QA, smoke harnesses, release tooling and test helpers | Inspect callers before pruning |
| `packaging/`, `windows/`, `tools/`, `assets/` | Installers, system scripts, telemetry and required branded assets | Preserve until package-path verification |
| `website/`, `functions/`, `supabase/` | Website, download routes and associated cloud/account functions | Different URL/runtime entry points may use identical files |
| `docs/` | Architecture, gates, evidence, campaigns and historical releases | Keep provenance; archive by role |
| `.github/workflows/` | Windows release, explicit promotion and website deployment | Release-critical; preserve |
| `release.json`, `package.json`, `package-lock.json` | Version/channel identity, commands and dependency lock | Do not modify for housekeeping |
| `AGENTS.md`, `.agent/` | Development and agent operating standards | Active instructions; preserve |

**Current product identity:** `release.json` identifies v2.0 Build 210 as **Private Alpha**. Source-only cleanup does not change release status, publication, signing or update channels.

## Baseline inventory

At the audited `dev` tip:

- **966 tracked files** across the tree; **51 top-level entries**.
- **424 tracked files** under `scripts/`, including **422 JavaScript files**.
- **414 npm script commands** in `package.json`. The command text directly references **398 of those 422 JavaScript files**.
- **24 remaining JavaScript files are not directly named in npm script command text**. This is *not* evidence they are unused: entry points, CI, nested helpers and dynamic runners can invoke them.
- **133 tracked files under `docs/`**, including **25 under `docs/v2/`**.

Do not purge older smoke tests solely because they are numerous or not referenced by one npm command. Trace calls from scripts, GitHub Actions, release automation and cross-package imports before claiming anything is dead.

## Release notes / Phase 1

Merged [PR #49](https://github.com/AnxLabs/AnxOS-Control-Center/pull/49) archived **12 old root-level release notes** under `docs/releases/` as unchanged Git blobs. Its final diff included twelve **renames** and one compatibility fix to the historical notes backfill script; no application source was modified.

- Keep **`RELEASE_NOTES_2.0-build210.md`** at the root: `scripts/versioning-smoke.js`, `scripts/sync-website-release.js` and `.github/workflows/windows-release.yml` read a matching current root notes file.
- `docs/releases/` is an archive, not a replacement for the active release metadata contract.
- Historical tags and GitHub releases remain untouched.
- The current-notes root lookup in the tagged-release workflow was reviewed before PR #49 merged. Its historical backfill helper was updated to check the archive first. No fresh CI or packaged release test was performed in this audit.

## Identical blobs: do not blindly deduplicate

The tree contains eight sets of exactly matching Git blob contents:

| Matching files | Why they are not deletion-ready |
| --- | --- |
| `assets/icons/png/512x512.png`, `src/assets/anxos-logo.png`, `website/assets/anxos-logo.png` | Different application, source and website paths |
| `assets/icons/png/256x256.png`, `website/assets/apple-touch-icon.png` | Installer/icon assets versus browser icon paths |
| `website/account.html`, `website/account/index.html` | May serve different direct URLs / static-host routing |
| `website/activate.html`, `website/activate/index.html` | Same URL compatibility risk |
| `website/forgot-password.html`, `website/forgot-password/index.html` | Authentication/deep-link compatibility risk |
| `website/profile.html`, `website/profile/index.html` | Profile navigation compatibility risk |
| `website/reset-password.html`, `website/reset-password/index.html` | Password recovery link compatibility risk |
| `website/changelog/index.html`, `website/release/index.html` | May intentionally serve two public routes |

**Finding:** identical content is confirmed, but safe removal is **not** confirmed. De-duplication needs path consumers, rewrites, deployment output and redirect tests. Do not add redirects or alter auth URLs without separate review.

## Branch hygiene (remote only)

Compared with `dev` at the audit tip:

| Branch | Ahead of dev | Behind dev | Suggested disposition |
| --- | ---: | ---: | --- |
| `aim/aim-1-infrastructure-inventory` | 0 | 153 | Candidate for retirement |
| `claude/hermetic-feature-tier` | 0 | 168 | Candidate for retirement |
| `docs/aim-0-signoff` | 0 | 62 | Candidate for retirement |
| `test/stabilization-qa-welcome-order` | 0 | 166 | Candidate for retirement |
| `cursor/updater-channel-safety-dcd2` | 4 | 0 | **Keep — active draft PR #48** |
| `chore/archive-old-release-notes-20261106` | 1 at initial audit | 0 at initial audit | **PR #49 merged — branch retirement still needs a worktree/dependency check** |
| `dev` | 0 | 0 | **Keep — default branch** |

Four branches have no unique commits versus `dev`, but local-worktree use, external automations, and human references have **not** been ruled out. The AnxPC Bridge was unreachable during this audit. Do not delete those branches until local state and external references are checked and AJ explicitly approves deletion.

**Draft [PR #48](https://github.com/AnxLabs/AnxOS-Control-Center/pull/48)** is security-sensitive updater/channel work. Its current head was not covered by an older Sentinel review; preserve it and require current-head review before merge.

## Historical docs and possible clutter

- Build-numbered acceptance reports, private-alpha readiness checks, release reports and V2 campaign logs are **historical evidence**. Do not delete based on age or because a newer result exists.
- `docs/DOCUMENTATION_INDEX.md` distinguishes current references from historical reports. Code and latest valid Git handoff override stale notes about unfinished implementation.
- Large files such as `scripts/marketplace-smoke.js` and `docs/v2/V2_CAMPAIGN_LOG.md` are not necessarily generated artifacts; preserve their provenance.
- The `.gitignore` already excludes `node_modules/`, `dist/`, `artifacts/`, `release-artifacts/`, runtime/instance data, local environments and credential-bearing config files. Do not use broad new ignore rules to hide legitimate sources.

## Safe cleanup process

1. Read current Git state, branch/worktree ownership, `AGENTS.md`, release scripts and relay before editing.
2. Verify each proposed removal has **zero** references from code, package scripts, CI, deployment routes, tags and docs — a missing direct npm command is not enough.
3. Put source-cleanup changes in a dedicated branch and a small reviewable PR; preserve original history and path provenance.
4. Run the **smallest relevant** link, test, website-route or release-contract checks. Do not rerun the whole suite just because the maintainer changed.
5. Merge only with AJ approval. Never clean by modifying a public release, tag, default branch, production env or server.

## Status at this audit

- **Confirmed content moves:** 12 old release notes archived by merged PR #49; historical backfill lookup updated.
- **Proposed in this phase:** navigation/documentation hygiene and a source-attributed cleanup inventory.
- **No verified dead source scripts or removable duplicated website assets.**
- **No remote branch deletion or release-operation authorization.**
