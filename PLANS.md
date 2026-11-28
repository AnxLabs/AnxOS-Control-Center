# PLANS.md — AnxHost CC

This file holds the plan of the build in progress first, then the plans of
earlier builds, kept unchanged as the record.

- **Build 217: Operation Refinement** (published 2026-11-27 as `v2.0-build217` from RC1 `9e1b3455`, below)
- **Build 216: AnxHost CC Rebirth** (complete; published 2026-11-27, see
  "Build 216" further down)

---

# Build 217: Operation Refinement

| Field | Value |
| --- | --- |
| Product | **AnxHost Control Center v2.0 Build 217** |
| Status | Plan written 2026-11-27 from the owner's Build 217 brief. Phases 217-A to 217-G done locally (checkpoint commits). 217-H (owner decisions: startup sound off by default, update shutdown review, Docker suites) done; the approved Supabase steps wait for the owner's sign-in. Push and signed RC1 approved; stop at the RC installation gate. Record: `docs/HANDOFF_BUILD217.md`. |
| Baseline | `origin/dev` at `87cf3d56`. Build 216 was published from `1212d772` (`v2.0-build216`), and the website has been canonical on `anxhost.anxlabs.net` since 2026-11-27. |
| Development branch | `claude/anxhost-build-217`, created from `87cf3d56` |
| Governing protocol | `AGENTS.md` (ADP) |
| Handoff | `docs/HANDOFF_BUILD217.md` |
| Motto | 216 made it beautiful; 217 makes it fast. |

## 1. Objective

Refine Build 216 rather than redesign it:

- Make it measurably faster and lighter.
- Polish the UI.
- Move the app onto the new domain.
- Make updates safer.
- Polish the phone app.
- Investigate optional AnxNet infrastructure on the legacy domain.

Every one of the 1,573 mapped capabilities stays (the capability inventory
check stays green).

### Out of scope

- Build 218 and later, AI hosting, native architecture, a full update
  framework (SAUS).
- Rebuilding the installer architecture.
- Production changes without separate approval:
  - Supabase, authentication policy, DNS, public gateways, new public ports,
    paid infrastructure
  - Agent upgrades on Anxlab or the VPS
  - pushes, signed RCs, deployment, publication

## 2. Sequence

One active writer. Phases run in this order. Each one is recorded in the
handoff with its start and finish times, elapsed time, commits, tests and
blockers.

```
217-A Performance -> 217-B UI polish -> 217-C Domain and account
  -> 217-E Installer and update reliability -> 217-F Mobile
  -> 217-D AnxNet infrastructure (investigation and review)
  -> 217-G Stabilization and RC preparation (stop at the RC approval gate)
```

217-A goes first: its baseline has to be measured on unchanged Build 216
code. 217-D is mostly investigation and review, so it runs late; it never
blocks the rest. If any phase is blocked by something outside the
repository, the safe work continues.

## 3. Phases and finish lines

### 217-A — Performance

1. **Baseline.** A lightweight Build 216 baseline is recorded with one
   repeatable tool (`scripts/anxhost-perf-baseline.js`):
   - cold start and warm start (renderer ready, sidebar ready);
   - idle memory and CPU after a settle period;
   - Agent and API requests per minute while idle on Home and on My Servers.

   The app runs off-screen with an isolated profile and the fixture Agent.
2. **Bottlenecks.** Real bottlenecks are found from that evidence (profiles,
   request logs), not guessed:
   - duplicate Agent polling and API requests;
   - work for hidden screens;
   - large server, Docker and Marketplace lists;
   - lazy loading of inactive screens where that is safe.
3. **Fixes.** Each fix has a check that fails on the old code, and no
   capability is lost.
4. **Comparison.** A same-day A/B against Build 216, by median of
   alternating rounds. Targets: 20–30% faster startup and 15–25% lower idle
   memory where achievable. These are targets, not requirements; results are
   reported as measured. No endless benchmarks.

### 217-B — UI and experience polish

- Refine spacing, typography, transitions and responsive layouts, using the
  approved tokens and branding.
- Remove duplicate controls while keeping every capability reachable.
- Improve dialogs, menus, loading states and progress feedback.
- Fix Dark, Light and System theme inconsistencies.
- Marketplace: artwork presentation, search and filters.
- Finish the user-visible "AnxOS" wording. Use the allowlist; frozen
  identifiers stay (Build 216 PLANS, section 6).
- Finish line: the brand allowlist check has no user-visible "AnxOS" left
  outside the frozen and "formerly" uses. The theme checks pass in all three
  themes. The touched UI suites pass. Capabilities stay 1,573 of 1,573.

### 217-C — Domain and account integration

- `anxhost.anxlabs.net` becomes the primary site in the app:
  - sign-in and activation links;
  - the account and device-login pages;
  - the website base URL;
  - the update fallback (new origin first, then legacy).
- The trusted host list grows; nothing is removed. A new frozen entry records
  the new host, and FI-UPD-01 (`anxoscontrolcenter.org`) stays.
- Existing accounts, remembered sessions (216-E) and older clients keep
  working. Legacy sign-in, download and update endpoints stay served.
- Prepare, but do not apply:
  - the Supabase change: add `https://anxhost.anxlabs.net` to
    `ANXOS_ALLOWED_ORIGINS`, the functions' built-in lists and the auth
    redirect URLs;
  - the website change: serve sign-in on the new host and remove the worker's
    sign-in 302s once Supabase allows the origin.
- Verify sign-in, sign-out, recovery and device activation against a local
  stand-in, and against production after the approved change.
- **Approval:** Supabase and authentication-policy changes, and the website
  change that moves sign-in.

### 217-D — AnxNet infrastructure (investigation)

Investigate optional AnxNet services under the legacy domain:

- `net.anxoscontrolcenter.org`: a private DNS namespace;
- `relay.anxoscontrolcenter.org`: a relay;
- `edge.anxoscontrolcenter.org`: a gateway.

The design must:

- keep `.internal` names working;
- support a configurable DNS suffix and user-owned domains where practical;
- keep private device records out of public DNS;
- keep encryption, enrollment, network isolation and owner authorization;
- reuse the existing edge (`src/anxnet/edge.js`).

Deliverable: a design and a security and abuse review in
`docs/anxhost/ANXNET_INFRASTRUCTURE.md`. Code only where it is safe and
local, for example a configurable suffix with `.internal` as the default.

**Approval:** any DNS change, public port, public gateway, deployment or paid
infrastructure.

### 217-E — Installer and update reliability

On the existing Rust AnxHost Setup and NSIS engine:

- Ask the running app to quit gracefully before the engine runs. The app
  flushes pending state and configuration saves and refuses to quit during a
  sensitive operation (for example a restore or a SteamCMD update) unless the
  user confirms.
- Detect and recover verified orphan `*.tmp` files at startup (the RC3
  acceptance finding).
- Improve recovery from an interrupted upgrade, and polish the remaining
  progress and layout issues.
- Keep signing, frozen identifiers, Helper and Agent compatibility. No new
  installer architecture and no SAUS.

### 217-F — Mobile experience

Polish the Phone Access PWA:

- touch targets and navigation;
- console and file management;
- loading, reconnect and offline states;
- Dark and Light consistency;
- portrait and landscape layouts;
- battery-efficient polling: back off when hidden or offline.

Permissions, pairing, certificates and the gateway API contracts stay
unchanged.

### 217-G — Stabilization and RC preparation

- Verify capability preservation (1,573 of 1,573), security boundaries,
  upgrade compatibility from Build 216, and the measured performance results.
- Fix genuine regressions.
- Update the release notes and known limitations.
- Write `docs/HANDOFF_BUILD217.md`.
- Run the full release gate (`qa:release`, `rc:validate`, `qa:website`).
- Stop at the RC approval gate.

## 4. Test strategy

- Focused checks during development:
  - `node --check` on changed files;
  - the smokes and UI suites for touched areas;
  - `frozen-identifiers`;
  - `git diff --check`.
- Valid earlier evidence is reused and cited by commit.
- The full release validation runs once, at 217-G.
- Never weaken, skip or loosen a test, or raise a time limit, to pass. A test
  is ported only when an approved requirement changed, and the handoff says so.
- Performance is judged by same-day alternating rounds compared by median
  (Build 216 lesson), never by means of a few runs or numbers from another day.

## 5. Approval boundaries

The ADP Approval Matrix applies, plus:

| Action | Approval |
| --- | --- |
| Commits | A local checkpoint commit when a phase is complete, as in Build 216 (the owner's campaign instruction of 2026-11-24, which the Build 217 brief keeps: "follow existing commit approvals"). Never pushed without approval. |
| Every push | Explicit, each time |
| Supabase, authentication policy, DNS, public ports, gateways, paid infrastructure | Separate production approval |
| Agent upgrades on production nodes | Separate approval |
| Changes to GitHub workflows or signing configuration | Explicit |
| Deleting files, legacy code or data | Explicit, naming the targets |
| Signed RC build, installing it, publication | ADP release workflow (`confirmed`, `done`, `🚀 publish`) |

## 6. Decision log

| Date | Decision |
| --- | --- |
| 2026-11-27 | Build 217 "Operation Refinement" from the owner's brief: phases 217-A to 217-G, solo, no Ultracode, no `/goal`; refine rather than redesign; production changes separately approved. |
| 2026-11-27 | 217-A: the startup sound's default (84 MB audio service, the bulk of the memory target) is left to the owner; nothing changed. |
| 2026-11-27 | 217-C: the app opens account pages on `anxhost.anxlabs.net` and trusts both hosts (FI-UPD-12); the website's sign-in 302, Supabase origins and the Auth redirect list stay as they are until approved. |
| 2026-11-27 | 217-E: in-app Install closes the app through its normal shutdown and opens the installer last; orphan temp files are moved aside, never restored (sign-out deletes session files). AnxHost Setup itself unchanged. |
| 2026-11-27 | 217-D: investigation only; a configurable AnxNet suffix is a later-build feature, and an AnxLabs relay is a separately approved project. |

---

# Build 216: AnxHost CC Rebirth (complete)


| Field | Value |
| --- | --- |
| Product | **AnxHost Control Center v2.0 Build 216** (short name **AnxHost CC**), formerly AnxOS Control Center |
| Status | Plan approved by the owner, 2026-11-20. Development not started. |
| Baseline | `origin/dev` at `13825d70` (Build 215 published, `v2.0-build215`) |
| Development branch | `claude/anxhost-build-216`, created from the latest verified `origin/dev` at the start of 216-0 |
| Planning branch | `claude/anxhost-build-216-planning-acfbb9` (kept; not used for development) |
| Governing protocol | `AGENTS.md` (AnxOS Development Protocol, ADP) |
| Handoff | `docs/HANDOFF_BUILD216.md` (created at the start of 216-0) |
| Next milestones | Build 217: UI polish and performance. Build 220: v2.1. |

## 1. Objective

Give AnxOS Control Center a completely new look and experience as
**AnxHost Control Center**, while losing none of its capabilities.

- Same power: every game server, all 50 Marketplace entries, Docker and
  Compose, Agents and fleet, AnxNet and sharing, Files, SSH and terminals,
  backups and restore, permissions, credentials and Phone Access keep working.
- New identity: the AnxHost CC name, logo, design language, installer and
  website.
- Better experience: a new desktop shell, a cleaner navigation, the
  Marketplace and Create Server inside the main window, real artwork, one
  status and progress system, a light theme, and a redesigned phone UI.
- Safe upgrade: Build 215 users upgrade in place and keep their settings,
  identities, sessions, Agents, paired phones and data.

### What stays

- The plain JavaScript renderer with script tags. No framework and no bundler.
- `preload.js` (39 namespaces, 435 methods), every IPC registrar in
  `src/ipc`, `src/services`, `src/shared`, the Agent and the phone gateway API.
- User data in `%APPDATA%\AnxHub`.
- Authorization and trust enforcement in the main process and the Agent.
  Hiding something in the renderer is presentation, never a security boundary.
- The standalone AnxOS operating system is not affected in any way.

### Out of scope

- Ollama, AI server hosting and the AI Model Catalog (later builds).
- New Docker or Agent features. In particular, **no manual Docker image
  rollback**: the automatic rollback when an update fails is kept and shown
  better (see Future improvements).
- A backend rewrite, or a wholesale refactor of `app.js`.
- Updating the production Anxlab and VPS Agents (separate authorized
  maintenance).
- Buying a domain, changing DNS, Supabase or production infrastructure, and
  renaming or moving GitHub repositories. Domain migration is a separately
  approved production step.
- An Electron or other web-runtime installer. (A standalone Rust installer
  was approved on 2026-11-26; see 216-D.)

## 2. Development sequence

Phases run strictly one after another, with **one active code editor**. Each
phase (or each 216-A wave) is started by its own focused `/goal`.

```
216-0 Foundation and capability inventory
  -> 216-A Desktop UI Rebirth (waves A1 ... A10)
  -> 216-E Secure Session Persistence
  -> 216-D Custom Installer (AnxHost Setup, reopened 2026-11-26)
  -> 216-C Phone Access Rebirth
  -> 216-B Website and Branding
  -> 216-F Integration and Preservation
  -> 216-G Stabilization and Release Candidates
```

The in-app rename (216-B1) is done inside wave A1, because the new shell
carries the new name. The rest of 216-B follows 216-C.

A phase is complete only when every finish line below is met, its handoff
entry is written, and the owner has reviewed it.

## 3. Phases and finish lines

### 216-0 — Foundation and capability inventory

No user-visible change ships in this phase.

**Work**

1. Create `claude/anxhost-build-216` from the latest verified `origin/dev`
   and bring this plan onto it (approved commit).
2. **Capability inventory**, `docs/anxhost/CAPABILITY_INVENTORY.md`: one row
   per page, sub-section, tab, dialog and action, with an ID (`CAP-<AREA>-<n>`),
   current location, destination in 216, the preload method(s) it uses, the
   tests that cover it, and its 216-A wave.
3. **Preservation checklist and page acceptance template**, generated from
   the inventory (`docs/anxhost/PAGE_ACCEPTANCE.md`).
4. **Frozen identifiers**, `docs/anxhost/FROZEN_IDENTIFIERS.md` (section 6),
   guarded by a new `frozen-identifiers` smoke.
5. **Product name constant**, `src/shared/productBrand.js` ("AnxHost Control
   Center", "AnxHost CC", "formerly AnxOS Control Center"). Not yet used by
   visible UI.
6. **Design tokens**: one new token file with dark (primary) and light values
   for colour, type, spacing, radius, elevation, motion and status.
7. **Test identifier contract**: a `data-testid` convention plus a hook check
   that fails when an inventoried hook disappears.
8. **UI patterns**, `docs/anxhost/UI_PATTERNS.md`, shown on a QA-mode-only
   gallery surface: shell, title bar, sidebar, page header, card, table,
   status pill, progress tray and step list, empty, loading, error and
   disabled states, dialog, wizard, toast.
9. **Logo and icon proposals** (section 5), shown to the owner for approval.
   Existing application assets are not replaced in 216-0.
10. **Expo legacy pairing investigation**: dependencies, entry points and how
    `mobilePairingService` rotates a node's Agent token. Findings go into the
    inventory; removal from normal UI happens in A5.
11. **Legacy pages investigation**: what `amp`, `coolpals` and the `minecraft`
    redirect still provide, and where each useful function lives in 216.
12. **Build 215 baseline evidence**: screenshots of all 20 pages at 900x640,
    1280x800 and 1920x1080; cold start to interactive and page-switch
    timings; the `qa:feature` result.

**Finish lines**

- Every one of the 20 pages, the global surfaces and the phone screens has
  inventory rows; **0 unmapped rows**, and every row has a destination and a
  wave.
- `frozen-identifiers` smoke passes, and fails when one identifier is changed
  on purpose (shown once, then reverted).
- Token file contains dark and light values for every token; the hook check
  passes on the current UI.
- Build 215 baseline screenshots (60), timings and `qa:feature` result are
  recorded in the handoff.
- Logo SVGs and sizes delivered (section 5), and **owner approval** of the
  logo, the sidebar information architecture and the UI patterns.
- `node --check` on new JS, `git diff --check` clean.

### 216-A — Desktop UI Rebirth

Every wave: keeps all its inventory rows working; ports its UI tests in the
same change; uses the new tokens and patterns only; leaves backend and IPC
unchanged. Business logic is moved out of `app.js` into `src/shared` only
when that specific page needs it, with a smoke for each moved function.

| Wave | Scope |
| --- | --- |
| **A1 Shell** | New custom title bar, sidebar and information architecture, page host, status system, operation tray, toasts, global search, command palette, Assistant panel. Startup splash, security gate, local setup gate, onboarding welcome and wizard. Theme mechanism (dark only for now). In-app rename (216-B1). |
| **A2 Home** | Dashboard sections (attention, servers, computers, setup) and Customize Home. |
| **A3 My Servers** | Server list, All computers table, Docker services in workloads, server view with all 9 tabs (overview, console, files, add-ons, backups, settings, players, performance, network), FiveM setup card, service operations. |
| **A4 Add Server (flagship)** | Marketplace and Create Server **inside the main window**. Retire the separate Marketplace and Create Server windows and the `surface=` branches. Keep search, categories, favorites, Modrinth and CurseForge providers, package details, install plan, dependency flow, manual download recovery, catalog import and export, and every advanced option. Artwork for every entry (section 5). |
| **A5 Computers** | Fleet, node details drawer, Add Computer, AnxNet panel, Agent Control (all 15 sections). Expo "Pair Mobile Device" removed from normal UI, based on the 216-0 investigation. |
| **A6 Docker** | Containers, images, networks, volumes, Compose, cleanup, safe image update. The existing automatic rollback when an update fails is shown as clear step-by-step progress. |
| **A7 Network** | Sharing (playit and public access) and Network and addresses, endpoint modal and picker, as two tabs of one page. Presentation only; no functional merge. |
| **A8 Files, Terminal, Backups** | Files and the Monaco editor; Add Storage moved into the main window; SSH (xterm) and multi-server consoles under Terminal; Backups and restore preview. |
| **A9 Activity, Security, Settings, Workspace** | Activity and task details, Maintenance, Security (all 19 sections, including the desktop Phone Access panel), Settings (11 categories and search), Anx Workspace (owner only). |
| **A10 Finish** | Retire legacy `amp`, `coolpals` and `minecraft` pages once their useful functions are confirmed elsewhere (deletion approval). Remove old CSS layers and `data-ui-generation="v1.9"` selectors that no longer match anything. Add the **light theme** from token values. |

**Finish lines per wave**

- 100% of the wave's inventory rows checked in `CAPABILITY_INVENTORY.md`.
- All ported and affected tests pass (exact commands in the handoff).
- Screenshots at 900x640, 1280x800 and 1920x1080 show no clipping, overflow,
  overlap or unreadable text.
- Cold start and page-switch timings within the 216-0 baseline **+10%**,
  unless the owner approves a higher figure.
- `node --check` on changed JS, `git diff --check` clean.

**Finish lines for all of 216-A**

- **0** BrowserWindows for Marketplace or Create Server; Add Storage opens in
  the main window.
- **50/50** Marketplace entries have bundled art with an offline fallback;
  each of the 10 Minecraft-family entries (Vanilla, Paper, Purpur, Fabric,
  Forge, NeoForge, Bedrock, and the Velocity, Waterfall and BungeeCord
  proxies) has a distinct identity.
- **0** remote image hotlinks added; the CSP `img-src` is unchanged.
- **100%** of art files have source and licence recorded in
  `docs/anxhost/MARKETPLACE_ART_SOURCES.md`.
- Light theme uses token values only: **0** per-component light overrides.
- Every page reachable from the new navigation; all 20 inventory pages
  accounted for (kept, merged as tabs, or retired with approval).

### 216-E — Secure Session Persistence

Builds on the existing remembered Local Owner session (`session.dat`,
`securityService`). The trusted-device policy is finalized in a written
security review, approved by the owner **before implementation**.

**Required behaviour**

- A valid Local Owner session is restored automatically after restarts and
  upgrades on a trusted device.
- Stored only through OS-backed secure storage (`safeStorage`). **No
  persistence when secure storage is unavailable**; the non-secret fallback
  key is never used for this.
- Bound to the device ID; a new token on every restore; absolute expiry
  (30 days unless the review decides otherwise).
- The idle-lock setting is **enforced** (today it is shown but not applied).
- Explicit logout, manual lock and revoked sessions always require the
  password again.
- A clear "Trust this device" preference with an opt-out.
- Account sign-in never unlocks Local Owner credentials. All 61
  `requireLocalOwnerAuthenticated` sites stay unchanged.

**Finish lines**

- Security review approved by the owner and recorded in the handoff.
- Automated tests prove restore **without** a prompt after restart and after
  upgrade on a trusted device.
- Automated tests prove a prompt **is** required after: logout, manual lock,
  revocation, expiry, idle timeout, device ID mismatch, opt-out, and missing
  secure storage.
- Token changes on every restore (test).
- Existing auth smokes pass (`account-session-restore`,
  `persistent-session-store`, `secure-session-store`, `local-owner-auth`,
  `auth-recovery`, `bootstrap-auth-order`, `auth-ipc-startup`, permission
  matrix).

### 216-D — Custom Installer (AnxHost Setup)

**Approved architecture (2026-11-26, supersedes "polished NSIS").** The
published `AnxOS-Control-Center-Setup-<version>.exe` is **AnxHost Setup**, a
standalone Rust program (`windows/setup`: tao + wry on Microsoft Edge
WebView2, no Electron) with the approved 10-screen design
(`docs/anxhost/d-installer/custom/`, proposal in
`docs/anxhost/d-installer/CUSTOM_INSTALLER_PROPOSAL.md`). It carries the
signed electron-builder NSIS installer as its **install engine**, appended
after the program and run silently underneath. No NSIS page is shown during a
normal installation.

- **Engine integrity**: before it runs, the engine is copied to a temporary
  folder, held open against writes, and must match the SHA-256 compiled into
  Setup at build time. On signed builds it must also carry a valid Authenticode
  signature from the pinned publisher ("Anjo ROSIMO", issuer
  "Microsoft ID Verified CS…"), the same pin the in-app updater uses.
- **Honest progress**: installer.nsh writes status lines
  (`/ANXSTATUS=<file>`): start, files extracted, registered, Helper begin and
  result, done. The bar measures real bytes extracted and copied against the
  app's packaged size. Phases without a measurable size show their step and an
  indeterminate bar. Nothing is simulated or delayed.
- **UAC**: Setup runs as the invoking user; the engine and the Helper keep
  their own legitimate elevation prompts. Nothing is bypassed.
- **Silent and updates**: `Setup /S` passes `/S`, `/D=`, `/NOHELPER`,
  `/allusers`, `/currentuser`, `--updated` and `--force-run` to the engine and
  returns its exit code. The in-app updater still picks the only
  `/setup.*\.exe$/i` asset (now Setup) and checks its SHA-256 and publisher.
  The engine is written to `dist/engine/` as
  `AnxOS-Control-Center-Engine-<version>.exe` and is never published; its name
  matches none of the updater's installer rules.
  `latest.yml` and the blockmap are rebuilt for Setup.
- **Uninstall**: the uninstall entry still points at the NSIS uninstaller. An
  interactive uninstall hands off to the copy of Setup in
  `resources\AnxHost Setup.exe --uninstall`, which runs the uninstaller
  silently from a temporary copy. Silent and `--updated` uninstalls never hand
  off. Data in `%APPDATA%\AnxHub` is kept.
- **WebView2 unavailable**: a Windows message explains the fallback, then the
  standard NSIS wizard runs (installer or uninstaller with `/ANXNOHANDOFF`).
- **Recovery**: a failed or interrupted install leaves the previous build in
  place (the engine's own rollback), shows the error with Try again and Copy
  details, and never reports success without the engine's `done` line and exit
  code 0.
- **Signing and CI**: the Windows job installs a Rust toolchain (Cargo cache
  on `windows/setup/Cargo.lock`). Setup and its uninstall copy are signed
  with Azure Trusted Signing under the existing publisher identity, and
  `verify-windows-signatures` covers `AnxHost Setup.exe`.
  `validate-release-artifacts` requires exactly one setup asset carrying the
  AnxHost Setup marker and an engine, and no published engine.

**Must be preserved**: `appId` and the registry GUID derived from it, the
install folder and executable names, upgrade detection, `%APPDATA%\AnxHub`,
the Helper scheduled task flow and its Smart App Control and UAC handling, the
`/NOHELPER` and `--updated` switches, Azure Trusted Signing, signing of every
NSIS plugin, the publisher pin, and Build 215's updater choosing the 216 Setup.

**Finish lines**

- Owner approval of the installer design (approved 2026-11-26: 10 screens).
- `cargo test` in `windows/setup`, `anxhost-setup-contract`,
  `local-agent-installer`, `installer-signature`, `build-signing`,
  `windows-signing-coverage` and `validate-release-artifacts --fixture` pass.
- From the signed CI build, in Windows Sandbox with Smart App Control on:
  fresh install, in-place upgrade from a real Build 215 install, update,
  repair, uninstall, silent install and the WebView2 fallback all pass.
- **100%** of installed binaries, Setup and NSIS plugins validly signed; **0**
  Code Integrity blocks.
- The Build 215 updater logic selects the 216 Setup (smoke against the 216
  asset list).
- The Helper task survives the upgrade; existing data is kept.

### 216-C — Phone Access Rebirth

Complete redesign of the phone PWA (`src/mobile/web`) with the shared design
language. The desktop Phone Access panel is redesigned in A9.

**Must be preserved**: the phone API (36 routes in `src/mobile/api.js`) and
the gateway's pairing endpoint, pairing by QR code, roles
(Viewer, Operator, Owner), the session cookie, CSRF header, local CA files and
subject, console, file transfers, add-ons, backups, sharing and monitoring.
The manifest and title become AnxHost; the service-worker cache moves to
`anxos-shell-v3` so phones load the new shell.

**Finish lines**

- All 9 screens (Pairing, Unpaired, Home, Servers, Computers, Computer,
  Server, Sharing, More) and all 6 server tabs (Overview, Console, Files,
  Add-ons, Backups, Settings) redesigned.
- `mobile-gateway`, `mobile-pairing`, `mobile-ui-qa` and
  `responsive-mobile-ui-qa` pass.
- No overflow or clipping at 360, 390 and 430 px wide and in landscape, in
  dark and light.
- A phone paired on Build 215 stays paired and works after the upgrade (test
  with a 215-format device record).

### 216-B — Website and Branding

| Part | Scope |
| --- | --- |
| **B1 In-app rename** (inside A1) | Visible strings only, driven by an allowlist. Window titles, tray, notifications, dialogs, installer text, phone title. Migration of the saved `app.displayName`: rewritten only when it still equals the old default, tested with a saved 215 record. |
| **B2 Website** | Redesign on the existing Cloudflare Pages project and domain with the new name and look, "formerly AnxOS Control Center", and every previous release note and download kept. |
| **B3 Domain migration plan** | Written plan only: selection criteria, DNS, adding the new host to the app's sign-in host list and Supabase `ANXOS_ALLOWED_ORIGINS` (additive), 301 redirects, canonical host, sitemap, IndexNow, and keeping `anxoscontrolcenter.org` working permanently for existing users, update fallbacks and sign-in. Execution is a separately approved production step. |
| **B4 GitHub** | Branded READMEs and release text. No repository renames or moves until compatibility is proven and approved. |

**Finish lines**

- **0** user-visible "AnxOS Control Center" in the app and website outside
  "formerly" wording and release history (brand allowlist smoke).
- Every frozen identifier unchanged (`frozen-identifiers` smoke).
- Display-name migration smoke passes with a polluted 215 record.
- Website smokes and `qa:website` pass; all old release notes and download
  links still resolve.
- B3 plan approved by the owner.

### 216-F — Integration and Preservation

**Finish lines**

- **100%** of `CAPABILITY_INVENTORY.md` rows verified on the development
  build.
- An isolated QA environment seeded with Build 215-format stores upgrades with
  **0** lost settings, credentials, nodes, SSH profiles, backups, favorites
  or paired phones.
- A 216 desktop operates a fleet of 215 Agents (mixed-version test).
- Backups and restore, AnxNet and sharing, Docker update with automatic
  rollback, and Phone Access verified end to end.
- `qa:feature` passes in full.

### 216-G — Stabilization and Release Candidates

Follows the ADP Release Candidate Acceptance Workflow exactly: `qa:release`,
`rc:validate` and `qa:website`; a signed RC built by the existing GitHub
Actions workflow; signature and SHA-256 verified; the report and the exact
installation question; in-place upgrade from Build 215 with Computer Use only
after `confirmed`; full acceptance; final status `🟢 READY FOR PUBLICATION` or
`🔴 RELEASE BLOCKED`; publication only after `🚀 publish`.

**Finish lines**: every item of the ADP Release Checklist checked, and the
upgraded installation shows AnxHost Control Center v2.0 Build 216 with all
data, sessions on a trusted device, Agents and paired phones intact.

## 4. Screen inventory (starting point; 216-0 completes it)

### Desktop pages (20 today)

| Today (`data-page`) | Today's place | Build 216 destination | Wave |
| --- | --- | --- | --- |
| `dashboard` | Home | Home | A2 |
| `instances` | My Servers | My Servers | A3 |
| `marketplace` + separate windows | Add Server | Add Server, in the main window | A4 |
| `nodes` | Computers | Computers: Overview and AnxNet | A5 |
| `agent-control` | Tools | Computers: Agent Control | A5 |
| `docker` | Tools | Docker | A6 |
| `playit` | Sharing | Network: Sharing | A7 |
| `network` | Tools | Network: Addresses and endpoints | A7 |
| `files` + Add Storage window | Tools | Files, Add Storage in the main window | A8 |
| `ssh` | Tools | Terminal: SSH | A8 |
| `console` | Tools | Terminal: Server consoles | A8 |
| `backups` | More | Backups | A8 |
| `notifications`, `operations` | More | Activity: Notifications and Tasks | A9 |
| `maintenance` | Tools | Activity: Maintenance | A9 |
| `security` | More | Security (including Phone Access) | A9 |
| `settings` | Pinned | Settings | A9 |
| `owner-workspace` | Owner section | Anx Workspace (owner only) | A9 |
| `amp`, `coolpals`, `minecraft` redirect | Hidden legacy | Retired after verification | A10 |

### Proposed sidebar (owner approval in 216-0)

- **Run**: Home, My Servers, Add Server
- **Infrastructure**: Computers, Docker, Network
- **Tools**: Files, Terminal, Backups
- **Footer**: Activity, Security, Settings, Anx Workspace (owner only)

### Global surfaces

Startup splash, security gate, local setup gate, onboarding welcome and
wizard, custom title bar, global search (Ctrl+K), command palette
(Ctrl+Shift+P), Assistant panel, update and developer update dialogs,
contextual help, FiveM setup, node modal and details drawer, endpoint modal
and picker, node picker popover, the 26 dialogs built in `app.js`
(confirmations, install plan), toasts, and the startup diagnostic window
(kept, minimal restyle).

### Phone

Pairing, Unpaired, Home, Servers, Computers, Computer, Server (Overview,
Console, Files, Add-ons, Backups, Settings), Sharing, More. Bottom tabs: Home,
Servers, Computers, Sharing, More. Desktop side: Security, Phone Access panel.

## 5. Visual design principles

- **Dark first.** Near-black violet base, purple gradient accent, off-white
  text. The dark theme is the primary identity. The light theme is optional,
  built from the same tokens, and never compromises the dark design.
- **Hexagon and node motif**, used sparingly. Status glyphs are node dots.
- **One status system**: Running, Starting, Stopping, Degraded, Offline and
  Updating each have one colour, one shape and one label, on desktop and phone.
- **One progress pattern**: the operation tray plus step lists for long
  operations.
- **Every view has states**: empty, loading, error and disabled.
- **Desktop density** for power users, with progressive disclosure. Advanced
  options are never removed.
- **Local assets only**: fonts bundled under an open licence (OFL); no remote
  fonts or images.
- **Accessibility**: WCAG AA contrast in both themes, full keyboard
  navigation, visible focus, nothing conveyed by colour alone.

### Logo and icon standard (216-0 deliverables)

Reference: the approved-direction concept in
`A:\AnxLabs\40-Assets\Brand\anxhost-logo\` (raster crops and interim dark
variants made during planning).

- SVG mark (hexagon, AH monogram, server rack, orbit and nodes) and SVG
  wordmark ("AnxHost" with the "Control Center" tagline).
- Dark-background and light-background variants of the mark, wordmark and
  horizontal lockup.
- Simplified mark for 16 to 32 px (hexagon and monogram only, no rack detail).
- App icon `.ico` and PNG set (16, 24, 32, 48, 64, 128, 256, 512, 1024),
  taskbar, tray (16, 20, 24, 32 at 100 to 200% scaling), favicon (16, 32,
  SVG) and phone touch icons (180, 192, 512).
- Written rules: clear space, minimum sizes, colour values, do and don't.
- Proposals are shown to the owner for approval **before** any existing
  application, installer, phone or website asset is replaced.

### Marketplace artwork rules

- Every game, Minecraft variant, loader, application and service gets
  recognizable art or an icon, bundled locally with an offline fallback.
- Official assets only where their use is permitted, with the permission
  documented; otherwise original or properly licensed artwork.
- Source and licence recorded for every file in
  `docs/anxhost/MARKETPLACE_ART_SOURCES.md`.

## 6. Compatibility rules

### Frozen identifiers (not changed in Build 216)

| Area | Identifier |
| --- | --- |
| Installer and app | `appId` `com.anxos.controlcenter`; package name `anxos-control-center`; Linux executable and deb names; Windows exe name `AnxOS Control Center.exe` |
| User data | `%APPDATA%\AnxHub` and `%LOCALAPPDATA%\AnxHub` (`APP_DATA_NAME`); `ANXOS_*` and `ANXHUB_*` environment variables; renderer `anxos.*` localStorage keys; preload aliases `anx`, `anxhub`, `anxos`, `electronAPI` |
| Windows Helper | Scheduled task `AnxOSAgent` (legacy `AnxOS Agent`) |
| Agent | Package, service, user, groups (`anxos-control`, `anxos-update`) and paths `anxos-agent`; release asset `AnxOS-Agent-<build>.deb`; `~/.config/anxos-control-center` |
| Wire and labels | Docker labels `anxos.*`; headers `x-anxos-*`, `X-AnxOS-*`, `x-anxhub-*`; pairing payload types `anxos-agent-pairing`, `anxos-agent-temporary-pairing` |
| Phone | Cookie `__Host-anxos-session`, CSRF header `X-AnxOS-CSRF`, CA files `anxos-local-ca.*` and the CA subject |
| Services | Supabase project and the `anxos-account` and `anxos-marketplace-curseforge` functions; Releases repo `AnxLabs/AnxOS-Control-Center-Releases`; `anxoscontrolcenter.org`; signing publisher "Anjo ROSIMO" |

### Rules

- Renaming goes through an **allowlist of user-visible strings**. Never
  replace "AnxOS" everywhere.
- Host lists only grow: a new domain is added beside the old one; nothing is
  removed in 216.
- Release assets: exactly one asset matches `/setup.*\.exe$/i`, and it is the
  signed AnxHost Setup carrying the signed NSIS engine. `update-manifest.json` stays at its Build 215 URL.
- Release history, old downloads and GitHub history stay available.
- Version stays `2.0`; tag `v2.0-build216`; channel unchanged unless the owner
  decides otherwise.

## 7. Test and validation strategy

- **Per wave (focused)**: `node --check` on changed JS; the smokes and
  Playwright suites for the touched pages (ported in the same change);
  `frozen-identifiers`; `git diff --check`. Valid earlier evidence is reused
  and cited by commit rather than re-run.
- **Integration gates** (end of 216-A, end of 216-C, 216-F): `qa:feature` in
  full.
- **Release gate** (216-G): `qa:release`, `rc:validate`, `qa:website`, plus
  the ADP RC workflow.
- **Porting rules**: selector suites move to `data-testid`; smokes that cut
  functions out of `app.js` are rewritten only when that page moves the logic
  to `src/shared`; renderer text-assert smokes are replaced with equivalent
  checks, and every retirement is listed with its replacement in the handoff.
- **Never** weaken, delete, skip or loosen a test, or raise a time limit, to
  make the new UI pass, without explicit owner approval. Timing-sensitive
  tests are judged one at a time.
- **New tests**: frozen identifiers; brand allowlist; display-name migration;
  every 216-E session case; art manifest (bundled file and licence for every
  entry); token use in new CSS; screenshot QA at three sizes in both themes;
  updater asset selection; upgrade from 215-format stores; paired phone after
  upgrade.

## 8. Approval boundaries

The ADP Approval Matrix applies throughout. In addition, each of these needs
explicit owner approval in Build 216:

| Action | Approval |
| --- | --- |
| Every commit; every push | Explicit, each time |
| Changes to GitHub workflows or signing configuration | Explicit |
| 216-E trusted-device policy and security review | Before implementation |
| Logo, sidebar information architecture, UI patterns, installer design | Before replacing assets or building on them |
| Deleting legacy pages, old CSS, separate window code, the repo-root `functions/` directory, or Expo pairing UI paths | Explicit, naming the targets |
| Domain purchase, DNS, Supabase settings, repository rename or move, production nodes | Separate approved production step (not part of 216 development) |
| Launching the signed RC installer | Exact reply `confirmed` |
| Continuing after a manual sensitive step | Exact reply `done` |
| Publishing | Exact reply `🚀 publish` |

## 9. Handoff requirements

Each `/goal` ends by updating `docs/HANDOFF_BUILD216.md` with:

- Phase and wave status table.
- Inventory progress (rows verified / total).
- Start, finish and elapsed time (section 10).
- Commits (hash and subject).
- Exact commands run and their results; recommended but unrun checks listed
  separately.
- Tests ported or replaced, with reasons.
- Screenshot locations.
- Root causes for any bug fixed.
- Remaining risks and open decisions.
- The next step and the approval it needs.

Verified new lessons are added to the `AGENTS.md` Lessons Learned section.

## 10. Time reporting

Every `/goal` records:

| Field | Rule |
| --- | --- |
| Start | Local ISO 8601 time with UTC offset, read from the system clock when the goal starts |
| Finish | Same format, when the goal's report is delivered |
| Elapsed | Finish minus start, plus time spent waiting for approvals |
| Commits | Hash and subject of each approved commit |
| Tests | Affected tests: passed, failed, ported |
| Report | ADP format: Summary, Files Modified, Validation Performed, Remaining Risks, Recommended Next Action |

## 11. Future improvements (not authorized for 216)

- Manual Docker image rollback after a successful update (the previous image
  ID is already recorded as the `anxos.previous-image` label).
- Carrying out the new domain migration (after the B3 plan is approved).
- Further UI polish and performance (Build 217).

## 12. Decision log

| Date | Decision |
| --- | --- |
| 2026-11-20 | Full UI rebirth on the existing plain JS renderer; no framework or bundler; backend, IPC and user data unchanged. |
| 2026-11-20 | Marketplace and Create Server move into the main window (flagship of 216-A). |
| 2026-11-20 | Visible name AnxHost Control Center / AnxHost CC; internal identifiers frozen where needed for upgrades; saved display name migrated. |
| 2026-11-20 | New domain planned but not chosen; `anxoscontrolcenter.org` and the Releases repo stay; no production changes in 216 development. |
| 2026-11-20 | Installer: polished signed NSIS first; no Tauri or Rust; wrapper only reconsidered later. |
| 2026-11-20 | Session persistence on trusted devices with OS secure storage, device binding, rotation, expiry and enforced idle lock; policy finalized in a security review first. |
| 2026-11-20 | Marketplace art for every entry; distinct Minecraft variant identities; local assets with recorded licences. |
| 2026-11-20 | Light theme yes, dark first, tokens only. |
| 2026-11-20 | Legacy pages and Expo pairing UI retired only after investigation. |
| 2026-11-20 | Docker: keep automatic rollback on failure; no manual rollback in 216. Production Agent updates stay separate. |
| 2026-11-20 | Version v2.0 Build 216 (v2.1 is Build 220). Development branch `claude/anxhost-build-216` from `origin/dev`. |
| 2026-11-20 | Logo SVGs drafted in 216-0 and approved before any asset replacement. |
| 2026-11-20 | 216-0 owner approvals: navigation (Run / Infrastructure / Tools, footer, icon rail below 1100 px; every existing capability must stay reachable); UI foundation (dark-first violet and charcoal, optional light theme, **eight** status states adding Error and Stopped, WCAG AA contrast and keyboard navigation); **system fonts by default**, superseding "fonts bundled under an open licence" in section 5. |
| 2026-11-20 | Logo: split strategy approved. Option A for large branding (splash, About, website hero, installer welcome), Option B for the title bar, icons from 48 px, phone icons and social previews, the simplified mark (hexagon and rack) for taskbar, tray and favicon at 16-32 px. Icon-size marks carry a contrast rim. See `docs/anxhost/brand/LOGO_STANDARD.md`. |
| 2026-11-26 | Installer reopened and approved: standalone Rust AnxHost Setup (tao + wry, WebView2) with the 10-screen design, the signed NSIS installer as a verified silent engine, Azure Trusted Signing for Setup, CI Rust toolchain, and updated release asset checks. Supersedes the 2026-11-20 "no Tauri or Rust" decision. |
