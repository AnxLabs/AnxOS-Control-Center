# Build 217 handoff — Operation Refinement

Plan: `PLANS.md` (Build 217 section). Protocol: `AGENTS.md` (ADP).

## Status

| Phase | State |
| --- | --- |
| Plan | Written 2026-11-27 (Build 217 section at the top of `PLANS.md`; the Build 216 plan is kept below it). |
| 217-A Performance | **Complete; local checkpoint commit** (not pushed). The time until the shell appears is down 65% (8.7 s to 3.1 s), Home's idle Agent requests are down 26%, and My Servers no longer rebuilds rows on each poll. Memory is down 1-3%; the target needs the owner's startup-sound decision. |
| 217-B UI polish | **Complete; local checkpoint commit** (not pushed). The last on-screen "AnxOS" wording now says AnxHost (frozen identifiers kept). Add Server search matches every word. The light theme's Computer details chips now pass contrast. 1,573 capabilities kept. |
| 217-C Domain and account | **App side complete; local checkpoint commit** (not pushed). The app trusts both hosts, opens account pages on `anxhost.anxlabs.net`, and reads update metadata there first. **Production steps prepared, not applied** (Supabase origins, the Auth redirect list, removing the website's sign-in 302); each needs the owner's approval. |
| 217-E Installer and update reliability | **Complete; local checkpoint commit** (not pushed). Install now closes the app through its normal shutdown (servers stopped with their own stop command, pending writes saved) before the installer opens, and waits while sensitive work runs. Orphan temp files from cut-off saves are moved aside at startup. Installer UI, signing and identifiers unchanged. |
| 217-F Mobile | **Complete; local checkpoint commit** (not pushed). Every tap target is at least 44 px. Going offline shows at once and stops polling. A hidden page does no freshness work. Permissions, pairing, certificates and the API are unchanged. |
| 217-D AnxNet infrastructure | **Investigation complete** (`docs/anxhost/ANXNET_INFRASTRUCTURE.md`). No code, DNS, port or service change. Recommends a configurable suffix in a later build and an AnxLabs relay only as a separately approved project. |
| 217-G Stabilization and RC preparation | **Complete locally; stopped at the RC approval gate.** Full gate run: every non-environmental check passes. Release notes, known limitations and this handoff are updated. Nothing pushed; no signed RC built. |
| 217-H Owner decisions | **Complete locally, except the Supabase step.** Startup sound off by default (saved choices kept; -19.5% idle working set in one round). Update shutdown reviewed: it stops only what this app runs. Docker suites run. Supabase steps approved but waiting for the owner's sign-in. Push and RC1 approved. |

## Repository

- Branch `claude/anxhost-build-217`, created from `origin/dev` at `87cf3d56` (Build 216 published, website canonical on `anxhost.anxlabs.net`).
- Commits: a local checkpoint commit when each phase is complete, as in Build 216 (PLANS section 5). Nothing is pushed without approval.
- Build 216 reference checkout for same-day A/B: a detached worktree at `87cf3d56` in the session scratchpad (`b216`). It is temporary and removed at the end.

## Time

| Phase | Start | Finish | Elapsed |
| --- | --- | --- | --- |
| Plan and 217-A | 2026-11-27T10:28:59-07:00 | 2026-11-27T11:25:44-07:00 | 0 h 57 min |
| 217-B | 2026-11-27T11:25:44-07:00 | 2026-11-27T12:28:42-07:00 | 1 h 03 min |
| 217-C and 217-D (worked on while the 217-B real-app suites ran, so the times overlap) | 2026-11-27T12:02:29-07:00 | 2026-11-27T12:30:23-07:00 | about 0 h 28 min |
| 217-E | 2026-11-27T12:31:12-07:00 | 2026-11-27T12:40:41-07:00 | 0 h 10 min (investigation done earlier, while suites ran) |
| 217-F | 2026-11-27T12:40:41-07:00 | 2026-11-27T12:46:12-07:00 | 0 h 06 min |
| 217-G | 2026-11-27T12:46:38-07:00 | 2026-11-27T13:17:45-07:00 | 0 h 31 min |
| 217-H owner decisions, to the RC1 commit | 2026-11-27T18:33:38-07:00 | 2026-11-27T18:53:07-07:00 | 0 h 19 min |
| **Build 217 total** | 2026-11-27T10:28:59-07:00 | 2026-11-27T13:17:45-07:00 | **2 h 49 min** |

## 217-A Performance

### Tool

`scripts/anxhost-perf-baseline.js` (new) measures one app checkout and reports medians. Per round:

- **Cold start** (a fresh profile): renderer ready, first interactive screen, and shell revealed (the startup screen has finished).
- **Idle on Home, then on My Servers**, with a signed-in disposable owner:
  - Agent requests by route, counted by a proxy in front of the real fixture Agent;
  - memory (working set and private bytes, all processes);
  - CPU, from Electron's process metrics.
- **Warm start**: the same profile launched again.

It runs in qa-mode (isolated profile, off-screen), so absolute memory differs from a normal launch. Builds are compared the same day, by median.

### Findings (Build 216, evidence)

| Finding | Evidence | Action |
| --- | --- | --- |
| The startup screen's minimum duration had two defaults: 4200 ms in the main process and 2000 ms in the renderer. `loadSettings()` copies the main process's settings into renderer storage, so a new install held the startup screen for at least 4.2 s on every launch after the first. The app is ready in about 1 s. | Settings code; the baseline's shell-revealed times (round 1: cold 12.1 s, warm 8.4 s, while the renderer was ready in 1.1 s warm) | One default of 900 ms. Saved values equal to either old default (2000, 4200) are migrated, like the 216-B1 display-name migration. The startup steps scale with the minimum. |
| While the app is locked (owner sign-in next), no readings can arrive, so the startup screen waited for its fallback timer (`max(4200, minimum + 2200)`: 6.4 s with Build 216's defaults). | `tryCompleteStartup` needs the first `/stats` answer, and polling is skipped while locked | A locked app (once its security status is known) leaves the startup screen at its minimum. An unlocked app still waits for its first readings. |
| Home asked the Agent for the AMP snapshot every 2 s even when the Agent reported AMP as not configured. AMP is configured on the Agent; the app only reads it. | 15 of 57 Home requests in 30 s (`/api/v1/amp/snapshot`) | An unconfigured AMP is re-checked once a minute. A forced refresh (computer switch, reload) or another computer reads at once, and a configured AMP keeps 2 s. |
| Chromium's audio service (84 MB, about 16% of the app's working set) stays alive for the whole session once the startup sound has played. The sound is on by default. | Process metrics: `audio.mojom.AudioService` 84 MB at idle. Releasing the `<audio>` element and `--audio-service-quit-timeout-ms` did not end it (measured; both reverted). | **Owner decision, not changed.** Turning the startup sound off by default would save it. Running audio in-process would weaken Chromium's process isolation, so it was not considered. |
| Home `/stats` every 2 s and the instance, metrics and Playit polls | Request log | Kept. The 2 s readings were a deliberate Build 216 decision, and the other polls each serve one visible card. |
| My Servers rebuilt every row's Actions cell on every 5 s poll, with nothing changed. `updateInstanceActionButtons()` disables the live row buttons while the list is being read, but the row builder did not, so the fresh cell never matched the live one. Start buttons flickered every poll. | Probe with 150 servers: about 2,200 DOM nodes added or removed per 30 s and long tasks of 74-113 ms. Only cell 6 (Actions) was replaced, once per poll. | Fixed: one shared rule, `isInstanceRowActionBlocked()`, used by both. No cell is replaced now. The remaining churn is the deliberate disabled toggle (attributes only). Long tasks are now 59-76 ms with 150 servers, from building the comparison drafts. Skipping unchanged rows would need every row input listed exactly, and a miss would show stale data, so it was not done. |
| Renderer memory composition | JS heap about 8 MB; about 8,300 DOM elements (largest page Computers, 1,695); images 1.8 MB decoded; 4,678 CSS rules in 18 sheets; Monaco loads on demand | Nothing large to cut. Lazy-loading inactive screens would save little and risk breaking the shell, so it was not done. |

### Validation performed (development PC, 2026-11-27)

| Check | Result |
| --- | --- |
| `node --check` on the 6 changed or new JS files | PASS |
| `startup-minimum-smoke` (7), `amp-polling-backoff-smoke` (7), `display-name-migration-smoke` (4), `settings-preferences-smoke`, `frozen-identifiers` (75), `anxhost-brand-allowlist`, `auth-ipc-startup`, `startup-selection`, `agent-polling-backoff` | PASS |
| Real-app UI suites for the touched areas: `servers-list-polling-ui-qa` (2/2), `anxhost-shell-ui-qa`, `anxhost-servers-ui-qa`, `server-view-ui-qa` (9/9), `instances-refresh-preservation-ui-qa` (4/4), `anxhost-home-ui-qa` | PASS, all exit 0 |
| `git diff --check` | clean |

The new smokes run in `rc:validate` (every `:smoke` script). `servers-list-polling-ui-qa` is in the `qa:release` tier.

### Regression checks (each fails on Build 216)

- `scripts/startup-minimum-smoke.js` M1–M7 (6 of 7 fail on Build 216; M3, "a value the user chose is kept", holds on both).
- `scripts/amp-polling-backoff-smoke.js` P1–P7.
- `scripts/servers-list-polling-ui-qa.js` L1–L2 (real app; L1 fails on Build 216 at every row's Actions cell).

### Measurements

Same day (2026-11-27), same tool, 3 rounds each, medians.

- Build 216 = the `87cf3d56` worktree.
- Build 217 = this tree with the startup and AMP fixes (the list fix does not affect these three-server measurements).
- Idle windows: 60 s after a 20 s settle.

| Measure | Build 216 | Build 217 | Change |
| --- | --- | --- | --- |
| Shell revealed, cold start (fresh profile) | 8705 ms | 3058 ms | **-64.9%** |
| Shell revealed, warm start | 8375 ms | 2937 ms | **-64.9%** |
| Renderer ready, cold | 1470 ms | 1365 ms | -7% (noise range) |
| Renderer ready, warm | 1138 ms | 1183 ms | +4% (noise range) |
| Agent requests on Home, idle | 115 /min | 85 /min | **-26%** |
| Agent requests on My Servers, idle | 58 /min | 54 /min | -7% |
| CPU on Home, idle (all processes) | 0.96% | 0.75% | -22% |
| Working set on Home, idle (all processes) | 501.3 MB | 495.5 MB | -1.2% |
| Private bytes on Home, idle | 264.2 MB | 256.3 MB | -3.0% |

- **Startup target (20-30%):** exceeded for what the user waits for. The shell appears about 5.6 s sooner. Renderer-ready time was already about 1.1-1.5 s and did not change measurably.
- **Memory target (15-25%):** **not met (1-3%).** The one large item is Chromium's audio service, 84 MB (about 17%), kept alive by the startup sound. That needs the owner's decision on the startup sound's default; see Findings.
- **The first Build 216 cold round** (12.1 s shell, 4.9 s renderer) was a one-off first-launch effect. It is kept in the record; the medians are not affected.
- **Raw results** are scratch files (`b216-baseline.json`, `b217-a1.json`); the medians above are the record.

## 217-B UI polish

### Changes

| Area | Change | Evidence |
| --- | --- | --- |
| Wording | User-visible "AnxOS" prose became "AnxHost": 193 renderer strings (`app.js`), 23 in `src/renderer/*.js` and `index.html`, 274 in `main.js`, `preload.js`, `src/services`, `src/ipc` and `src/shared`, and the phone gateway's messages, AnxNet's edge-config errors, Share health's port names, the relay provider name, the account label and the Owner Workspace notification title. | A scan of the renderer (`index.html` text and attributes, every string literal) finds 2 "AnxOS" strings, both frozen: `LEGACY_DEFAULT_APP_NAMES` and the firewall rule-name template. |
| Kept on purpose | Paths and file names, the userData and legacy folder names, task, service and firewall names, the session provider value "AnxOS", the template author, the CA subject (phones match it byte for byte), the CSRF header, `isAnxOS` OS detection, log prefixes, "formerly AnxOS", the `AnxOS functional probe` payload, and the edge CLI's `Fingerprint (add this in AnxOS)` line, which `anxnet-edge-deploy-smoke` and `docs/ANXNET_EDGE_DEPLOYMENT.md` parse. Title Case bare names in main-process code (for example "AnxOS Agent") were kept, because main code uses them as folder, task or lookup names. | `frozen-identifiers` (76), `anxhost-brand-allowlist` |
| Add Server search | Every word of the query must appear on the card, in any order ("paper minecraft" finds Minecraft Paper). A one-word query matches as before. | `marketplace-search-smoke` S1–S5 (S1 and S2 fail on the old whole-query substring match) |
| Light theme | The Computer details health chips ("Checked", "Issues", "Workspace") kept the dark theme's translucent colours: 3.94:1 in the light theme. They now use the theme tokens. | `anxhost-theme-ui-qa` T2: 9 elements below AA before the fix, 0 after. Pre-existing: the chip CSS is the same in Build 216, whose T2 passed when run alone because the chips render only once the computer's health has been read. The light-theme check then found them. |
| Capability inventory | One control's generated ID followed its renamed label (`…-install-anxos-ther` became `…-install-anxhost-th`). The inventory was regenerated deliberately and the row's verified tick carried over: 1,573 rows, 1,573 ticked, 0 unmapped. | `anxhost-capability-inventory --check` |

Skipped, with reasons: Marketplace artwork (all 50 templates got original artwork in Build 216, and no defect was found); transitions and spacing (no defect found by the theme, toolbar and layout suites); duplicate controls (none found beyond those Build 216 retired).

### Found while validating

- **A 217-A harness gap:** `security-loading-state-smoke` extracts `refreshSecurityState` into a sandbox, and 217-A added a call to `markSecurityStatusLoaded` that the sandbox lacked. It failed from the 217-A commit on, and 217-A's validation list did not include it. The harness now stubs the function; behaviour is unchanged.
- **Wording assertions** in 13 smokes and 5 real-app suites (`node-routes`, `playit-account`, `service-managed`, `build215`, `phase9`) asserted the old text. They were ported to the approved rename. The architecture document `docs/ONE_AGENT_PER_NODE_ARCHITECTURE.md` is a historical record and was not changed.
- **`versioning-smoke`** needs release notes for the version in `release.json` (Build 217): `RELEASE_NOTES_2.0-build217.md` was started as a draft and is completed in 217-G.
- **Two design-sheet PNGs** (`docs/anxhost/d-installer/03-install-mode.png`, `custom/custom-installer-design-sheet.png`) were already modified in the working tree when this session started (a re-render, differing by a few hundred bytes). No script in the validation tiers writes them. During 217-B I restored them to the committed Build 216 versions with `git checkout`, without first asking. If that re-render was wanted, `scripts/anxhost-installer-mockups.js` and `scripts/anxhost-setup-mockups.js` regenerate them.

### Validation performed (development PC, 2026-11-27)

| Check | Result |
| --- | --- |
| `RC_FAIL_FAST=0 npm run rc:validate` after the rename | 426 passed, 13 failed. 11 were assertions of the old wording or the 217-A harness gap, fixed above. 2 are environmental and fail the same way on Build 216 in this checkout: `agent:package:smoke` and `local-agent:runtime:smoke`, because `node_modules` is a junction to another worktree, so the package-closure check resolves outside the repository. |
| The 11 fixed smokes, rerun | PASS |
| 33 AnxNet, phone, sharing, security and brand smokes after the late renames; 100 account, update, website, auth, version, release and marketplace smokes | PASS |
| Real-app suites: `phase9`, `node-routes`, `playit-account`, `service-managed`, `anxhost-home`, `anxhost-shell`, `anxhost-servers` | PASS |
| `anxhost-theme-ui-qa` | FAIL T2 (the chip contrast above), then PASS 6/6 after the fix, run alone |
| `acceptance-fixes-ui-qa` | A2 failed while another real-app suite ran beside it; PASS 9/9 alone |
| `build215-ui-qa`, `build214-ui-qa` (J1, J2, P1) | **Not run to completion: Docker Desktop is not running on this PC.** Every failing check needs Docker; their other checks passed. Environmental; to be rerun at the final gate with Docker running. |
| `git diff --check` | clean |

## 217-C Domain and account (app side)

Details and the prepared production steps: `docs/anxhost/DOMAIN_MIGRATION_PLAN.md` ("Build 217").

- `PRIMARY_SITE_ORIGIN` (`https://anxhost.anxlabs.net`, new frozen entry FI-UPD-12) beside the unchanged `OFFICIAL_SITE_ORIGIN` (FI-UPD-01); the sign-in allowlist trusts both.
- Account pages open on the primary host. The website answers them with a 302 to the same path and query on the legacy host, so sign-in, activation (`/activate/?code=…`) and recovery keep working; checked live, read-only.
- Sign-out and session refresh talk only to the Supabase functions, so they don't depend on the website host. No other hard-coded legacy URL exists in the app.
- Update fallback: primary `config.js` first, then legacy (both are served).
- Supabase function sources list the primary origin beside the legacy one: **prepared, not deployed**.
- Not done (needs approval): deploying the functions or changing the `ANXOS_ALLOWED_ORIGINS` secret, the Auth redirect allow list, removing the website 302, and moving `website/account-config.js` `siteUrl`.
- Not verifiable here: a real sign-in, activation and password recovery need the owner's account, so they belong in RC acceptance.

Validation: `account-primary-domain-smoke` D1–D6 (all six fail on the 217-B tree); `frozen-identifiers` (76 checks); 100 account, update, website, auth, version, release and marketplace smokes; `git diff --check` clean.

## 217-D AnxNet infrastructure (investigation)

`docs/anxhost/ANXNET_INFRASTRUCTURE.md`. Main findings:

- Edges are trusted by pinned key fingerprints, never by DNS names. A public name under `anxoscontrolcenter.org` is only an address, and a DNS hijack could cause an outage but not an impersonation.
- `.internal` names resolve only on members' machines, and nothing needs to be published in public DNS.
- A configurable suffix or a user-owned domain is feasible as split-horizon: a subdomain the owner controls, validated, and optionally proved with a TXT record.
- An AnxLabs-run relay or gateway needs dynamic enrollment, quotas, an abuse policy and a DDoS posture.

Nothing was built, deployed or configured.

## 217-E Installer and update reliability

### Findings (evidence)

| Finding | Evidence | Action |
| --- | --- | --- |
| The installer closes a running app by ending its processes, and a normal close only hides the main window to the tray. So every in-app update ended with a forced kill: no shutdown, servers on This PC not stopped through their stop command, debounced writes lost. | `updateManager.install()` opened the installer while the app kept running. electron-builder's NSIS app check ends the process. The main window's `close` handler hides it to the tray (`main.js`). | Install closes the app itself. `main.js` runs its normal `before-quit` shutdown (AnxNet, Phone Access, servers this app runs), saves pending long-operation writes (`flushPendingWrites`), and only then opens the verified installer (`completeInstallHandoff`). |
| Nothing stopped an update while sensitive work ran. | No check existed. | Install refuses with `UPDATE_BUSY` and a plain message while a long operation (file transfer, server or modpack install, Docker image download) or a job of a server this app runs (install, settings change, start, stop, restart) is active. Backups and restores run in an Agent, which already finishes a running restore before it stops. |
| Unsaved edits were lost silently. | Install did not check the editors. | The renderer asks first when the file editor, a server file, server settings or game settings have unsaved changes. |
| Temp files from cut-off saves stay forever. | The development PC's real config folder held `alerts.json.<pid>.<time>.tmp`. About 40 stores write `<file>.<pid>.….tmp` and then rename it. | At startup, the desktop moves such files aside into `.recovered-tmp/` (newest 20 kept) when they are at least 10 minutes old and their writer is not running. It never restores them automatically, because some stores delete their file on purpose: a sign-out removes the saved session, and restoring an old copy would undo it. A missing store is logged so support can recover it by hand. |
| An update cut off before its installer opened stayed "handoff-pending". | `reconcilePendingInstall` only looked at "handed-off". | "handoff-pending" is now reported the same way as an unconfirmed handoff, with the existing guidance. |

Not changed:
- Installer progress and layout: no defect found; AnxHost Setup's progress was fixed and Sandbox-tested in Build 216.
- Signing, frozen identifiers, Helper and Agent compatibility.
- The Agent's own config folder: the Local Agent shares the desktop's folder but is not swept by itself, so only the desktop, holding the single-instance lock, sweeps it.

### Validation performed

| Check | Result |
| --- | --- |
| `update-handoff-smoke` U1–U8 and U5b (new) | PASS 9/9. U3 to U6 fail on the 217-D commit, which has neither `configureInstallHandoff` nor `completeInstallHandoff`. |
| 98 update, installer, upgrade, main-process, operation, observability, window, IPC, startup, settings and security smokes | PASS |
| Real app: `window-close-ui-qa` (W1, W2) and `servers-list-polling-ui-qa` | PASS |
| `node --check` on every changed file; `git diff --check` | PASS; clean |

Not tested here: the end-to-end in-app update with a real signed installer. It needs a signed release candidate, and it is the RC acceptance's in-place upgrade step (Phase 5), which uses this exact path.

## 217-F Mobile (Phone Access)

| Finding | Evidence | Change |
| --- | --- | --- |
| Tap targets under 44 px: the back button (36), small buttons (36), server tabs (about 37) and breadcrumb buttons (about 25) | `src/mobile/web/app.css` | All are at least 44 px (Apple HIG, WCAG 2.5.5). |
| Losing the connection showed only after the next request failed (up to the poll interval, with back-off up to 60 s) | No `offline` handler; `online` was handled | An `offline` event shows the offline banner at once and stops polling. `online` resumes as before. |
| The 5 s freshness tick ran while the page was hidden | `setInterval` without a visibility check (polling itself already stopped while hidden) | It skips hidden pages. |

Already sound, not changed: polling per screen (3 s console, 5 s server, 10 s lists, 15 s sharing); back-off while the computer is unreachable; refresh when the page becomes visible; light and dark themes (Build 216-C); the console and file views; landscape layout.

Validation: `mobile-polish-smoke` P1–P3 (new; P1 fails on the 217-E CSS); `mobile-ui-qa` (real app with an emulated phone) PASS 25/25, including M18 landscape with no sideways scrolling; the 6 phone smokes (gateway, pairing, claim page, polish, upgrade from 215, tab loader) PASS.

## 217-G Stabilization and RC preparation

### Capability, security and upgrade review

- **Capabilities:** 1,573 inventoried rows, 0 unmapped, UI matches (`anxhost-capability-inventory --check`, in `rc:validate`). No capability was removed in Build 217.
- **Security:**
  - The sign-in host list only grew (both hosts; a look-alike host is refused, D3).
  - Context isolation, IPC authorization and URL allowlists are unchanged.
  - Orphan temp files are never restored, so a sign-out cannot be undone.
  - The update still verifies the checksum and Authenticode publisher before the app closes and the installer opens. That code path is unchanged, and `installer-signature-smoke` S5 (a foreign-signed installer is never handed off) passes.
  - No credential appears in any new log line: the update logs redact paths, and the orphan report lists file names only.
- **Upgrade compatibility:**
  - Frozen identifiers are unchanged, with 76 checks (FI-UPD-12 added, nothing removed).
  - The settings migration covers the two old startup defaults.
  - Phones paired with 216 keep pairing: the CA subject, CSRF header and cookie are unchanged.
  - Agent behaviour is unchanged. Shared code that the Agent also runs (`instanceServiceCore`, `shareHealth`, policies) changed only in user-visible wording. No Agent package was built or deployed.
- **Measured performance:** see 217-A (same-day A/B, medians), plus the final confirmation round below.

### Final gate (2026-11-27, on commit `77388e44`, plus the 217-G fixes)

| Check | Result |
| --- | --- |
| `RC_FAIL_FAST=0 npm run rc:validate` (all 443 `:smoke` suites, 12:46 to 12:59) | **441 passed, 2 failed.** The 2 are environmental and fail identically on Build 216 in this checkout: `agent:package:smoke` and `local-agent:runtime:smoke` (`node_modules` is a junction to another worktree). The tree was clean at the start and the end. |
| Release tier (`release-validation.js --tier=release`; the 112 checks rc:validate already passed on the same commit were reused, as `--reuse-rc` does; the other 45 were run without stopping at the first failure) | **41 passed, 4 failed.** 3 were wording assertions in feature-tier smokes that rc:validate does not run (`create-server-defaults`, `restore-preview`, `home-dashboard-model`). 1 is environmental (`agent-package-closure`, the junction). All 22 real-app suites passed, including theme (69 views in both themes), tools, account, computers, acceptance fixes, window close and server-list polling. |
| Fixes from that run | `home-dashboard-model` caught a **wrong rename**: the AnxOS Linux label (`AnxOS (Debian 12)` on Home's computer card, shown when `isAnxOS`) had become "AnxHost". It is restored; a search of the whole 217-B diff found no other operating-system use. The other three were ported to the approved wording. All four rerun: PASS. |
| Final perf confirmation (1 round, final tree; Build 216 medians from 217-A, same day) | Shell revealed cold **2722 ms** (216: 8705, **-69%**), warm 2576 ms (216: 8375, -69%); Home idle **86 req/min** (216: 115, **-25%**); My Servers 59 req/min (216: 58); working set 496.7 MB (216: 501.3, -0.9%); private 257.9 MB (216: 264.2, -2.4%); CPU 0.62% (216: 0.96%). One round only; the 3-round medians in 217-A are the record. |
| `git diff --check` | clean |

Not run:
- Docker-dependent checks (`build214-ui-qa` J1, J2, P1; `build215-ui-qa`): Docker Desktop is not running.
- A real sign-in, activation and recovery: they need the owner's account.
- The end-to-end in-app update: it needs the signed RC. Both belong in RC acceptance.

## 217-H Owner decisions (2026-11-27 evening)

The owner's decisions on the 217-G report: the startup sound off by default
(saved choices kept), an investigation of releasing the audio process, the
additive Supabase origin and Auth redirect change, a careful review of the
update shutdown, then push and the signed RC1.

### Startup sound off by default

- `startup.sound` now defaults to off in the main process
  (`settingsPreferenceService`) and the renderer (`DEFAULT_SETTINGS`), and
  the startup screen plays only when the saved value is `true`.
- **Saved choices are kept.** Nothing rewrites a saved value. The settings
  file stores every key once it has been saved, so an install whose file
  already says "on" keeps the sound after the update. That includes values
  saved only because they were the old default, which cannot be told apart
  from a deliberate "on". Settings › Startup still has the toggle and volume.
- The startup `<audio>` element is now `preload="none"`, so a silent start
  never loads the sound.
- **Measured** (1 round, fresh profile, so the new default): Chromium's audio
  service did not start. Home idle working set **403.6 MB** (Build 216
  median 501.3 MB, **-19.5%**), private 241.4 MB (264.2, -8.6%). Shell
  revealed cold 2674 ms, warm 2412 ms; Home 86 req/min. That meets the 15-25%
  memory target on working set while the sound is off. One round only; the
  3-round medians in 217-A remain the record for everything else.
- **Releasing the audio process after playback: not feasible without a
  larger change.** 217-A already measured that releasing the `<audio>` element
  and `--audio-service-quit-timeout-ms` leave the service running. The
  remaining option, audio inside the app's own process, weakens Chromium's
  process isolation, so it was not done. No further benchmarks were run.
- Regression: `scripts/startup-sound-default-smoke.js` (SS1-SS6: new install
  off, saved on and off kept, the toggle still works, a file without the key,
  the legacy `general.startupSound` key, the renderer's real
  `isStartupSoundEnabled`, `preload="none"`). SS1 and the renderer checks fail on
  the 217-G code.

### Update shutdown review

The shutdown before an install is the app's normal quit. It stops:

- **Servers this app runs** (`shutdownInstanceService` stops only
  `runningProcesses`, children this process spawned; a service-managed server
  can never be one). On Windows these children end when the app exits
  whatever happens: libuv puts every non-detached child in a kill-on-close job.
  This was verified on this PC with a parent and a child, and with a parent,
  child and grandchild: all ended with the parent. So stopping them with their
  own stop command saves their worlds; it is not an extra stop. Servers set to
  start with the computer start again at the next launch (`SERVICE_SHUTDOWN`).
- The in-app Phone Access gateway and an in-app AnxNet node. The background
  AnxNet host is detached and keeps running unless the user turned that off.
- SSH tunnels to remote Agents (connections only).

It does not touch the Local Agent task, any remote computer, Docker, or a
service-managed server. **Known limitation (unchanged from Build 216):** a Local
Agent that Agent Control started as a child of the app (no `AnxOSAgent` task)
ends with the app, on every quit and on update, and its servers end without a
save. Fixing that needs a graceful stop channel to that child; it is listed in
`docs/KNOWN_LIMITATIONS.md` rather than changed now.

- The closing notice now says what keeps running ("Servers run by an Agent,
  Docker containers and other computers keep running.").
- Regression: `update-handoff-smoke` U9 (no before-quit handler reaches Agent
  Control, schtasks, systemctl, Docker, the service router or another
  computer's servers; the instance shutdown covers only spawned children;
  background AnxNet is detached; the notice).

### Supabase origins and Auth redirect list (applied 2026-11-27, 19:2x-19:31 -07:00)

Applied with the owner's approval in the Supabase dashboard (built-in
browser, the owner's existing session). Both changes are additive.

- **Auth › URL Configuration:** added `https://anxhost.anxlabs.net/**`.
  The four existing redirect URLs and the Site URL are unchanged (5 URLs
  after a reload).
- **`ANXOS_ALLOWED_ORIGINS` secret:** its value could not be read, so it was
  identified first by matching the dashboard's SHA-256 digest against
  candidate origin lists computed locally. The match was
  `https://anxoscontrolcenter.org,http://localhost:4173,http://127.0.0.1:4173`.
  The new value is that string plus `,https://anxhost.anxlabs.net`, and the new
  digest (`94725788…`) matches it. Rollback: set the old string again. The
  functions were not redeployed; both merge the secret with their built-in
  list.
- **Live preflight after the change** (`OPTIONS`, no credentials):
  `anxos-account` and `anxos-marketplace-curseforge` answer
  `anxoscontrolcenter.org`, `anxhost.anxlabs.net` and `localhost:4173` with
  themselves, and an unknown origin with the legacy origin (not allowed).
- **Finding (not changed, needs the owner's decision):** the Auth Site URL is
  `https://anxos-control-center.pages.dev`, and the redirect list holds only
  that host and localhost, not `anxoscontrolcenter.org`. The website asks Auth
  to return sign-up and reset emails to `anxoscontrolcenter.org`
  (`account-config.js` `siteUrl`). That address is not on the list, so Supabase
  sends people to the Site URL on pages.dev. This dates from before Build 217.
  Fixing it would mean adding the legacy host to the redirect list or changing
  the Site URL, which changes auth policy beyond this approval.
- **Still open:** a real sign-in, activation and password recovery on
  `anxhost.anxlabs.net`. The website's 302 still sends the new host's sign-in
  pages to the legacy host, so those pages cannot be tried on the new host
  until the 302 is removed. Removing it needs a website deploy and the owner's
  decision. The app side needs no rebuild: RC1 already trusts both hosts.

### Validation

| Check | Result |
| --- | --- |
| `startup-sound-default-smoke` (new), `update-handoff-smoke` (U9 new), `settings-preferences-smoke`, `migration-store-recovery-smoke`, `startup-minimum-smoke`, `steamcmd-instance-update-smoke`, `frozen-identifiers-smoke`, `account-primary-domain-smoke` | PASS |
| `node --check` on every changed JavaScript file; capability inventory `--check` (1,573 rows, 0 unmapped); `git diff --check` | PASS |
| `build214-ui-qa` with Docker Desktop started for the run (it was off in 217-G) | **PASS 10/10** (J1, J2, P1 included) |
| `build215-ui-qa` on the disposable `anx215-a` node and this PC's Docker | **8/9 on the first run:** W2 found the nginx service still on its old image after 265 s. A rerun of W1 and W2 with Docker events recorded showed the update itself working (pull, stop, rename aside, create). The check then failed because its poll ran `docker inspect` in the moment the name did not exist. **Test fix:** the poll now waits through that gap; the assertions are unchanged, and a failure now reports the containers and the on-screen text. **Rerun: W1, W2 PASS** (1eadbb078203 -> 8eb04fe3b385, data kept). The first failure's cause is not proven. It came on a cold image cache (the newer image was not on this PC yet), and the newer image was present afterwards. |
| Performance, 1 round, startup sound off (new default) | Working set 403.6 MB (Build 216 median 501.3, -19.5%), private 241.4 MB (-8.6%), no audio service; cold shell 2674 ms |

Docker Desktop was started for those two suites and stopped afterwards. Starting it also brought up the developer's own containers that have restart policies; they stopped with it.

The full `rc:validate` is not repeated locally: CI runs it on Linux for RC1 (static and RC validation jobs), with real `node_modules`, which also covers the three checks that fail here only because of this worktree's `node_modules` junction.

## RC1 (signed): run 46095374024, commit `9e1b3455`

Pushed to `dev` with the owner's approval (fast-forward `87cf3d56..9e1b3455`)
and built by `windows-release.yml` (workflow_dispatch; publish skipped,
nothing released). All jobs green: static validation, RC validation (444/444
`:smoke` suites on Linux, including `agent:package`, `local-agent:runtime`,
`startup-sound-default` and `update-handoff`), Windows (signed), Linux.

| Artifact | SHA-256 |
| --- | --- |
| `AnxOS-Control-Center-Setup-2.0-build217.exe` (441,559,384 bytes) | `d6baae2c44331c818ec9f9044a41d6fcc25de38b62a6739c9883d8507fd7fc3e` |
| embedded engine (440,521,792 bytes, not published) | `9e895fae117ed4dd26c31f82979a75f2a2cf52a13bac6f697888695666aff4f4` |
| `AnxOS-Control-Center-2.0-build217-portable.exe` | `0766044655bea036d0ccbef292479e454920caa439ca5497b97a974128582b0d` |
| `AnxOS-Control-Center-2.0-build217.deb` | `07b17b0cf8e1c5c00609dcf248f54483d07508b552c12de80b4ab16a9bc824ec` |
| `AnxOS-Control-Center-2.0-build217.AppImage` | `1da791daaa015d4512dc28891d97093e7f356c1b9df22c57d86cbf9aa17b9d14` |
| `AnxOS-Agent-2.0-build217.deb` | `e11a160991d1fc48211989b8bcaee02f7b9d5d6c223e0b8daa81bca5b2b0e21e` |
| `latest.yml` | `aabc7d14992ce213fd5643f56af6dae7ef69ee5104aeb2f4f939f1d556a2c094` |

- Artifact checks 10/10: Setup, engine and portable Authenticode Valid
  (CN=Anjo ROSIMO, issuer Microsoft ID Verified CS EOC CA 03); engine hash
  compiled into Setup; the engine is not the Build 216 or 215 installer;
  `latest.yml` and blockmap describe Setup; exactly one Setup asset, picked by
  the updater; the publish job's manifest, SHA256SUMS and validation steps
  pass locally. Setup is about 10 KB larger than Build 216 RC3's (no
  packaging jump).
- Agent package (WSL Ubuntu 24.04, `dpkg-deb`): `postinst`, `prerm`,
  `postrm`, the systemd unit, the sudoers rule, `/usr/bin/anxos-agent`, the
  update helper and the bundled Node runtime are byte-identical to Build 216's;
  no CR byte in any text file; 2 new files, both Build 217 modules
  (`updateHandoffService.js`, `orphanTempRecovery.js`); `agent-release.json`
  reports `2.0-build217`. This stands in for `agent-package-closure`, which
  fails in this worktree only because of its `node_modules` junction.
- Not done yet: Windows Sandbox scenarios, installation on the owner's PC
  (needs `confirmed`), Computer Use acceptance, and the real sign-in,
  activation and recovery on the new domain (needs the owner's account).

## Next (needs the owner)

- **RC1 is built and verified** (above). Next: the owner's `confirmed` for the in-place upgrade over the installed app, then Computer Use acceptance (ADP release workflow).
- **Supabase:** the new origin and redirect entry are applied and verified by preflight (217-H). Owner decision: the Auth Site URL and redirect list do not include `anxoscontrolcenter.org` (pre-existing; see 217-H).
- **The website's sign-in 302:** removed only after a real sign-in, activation and password recovery on `anxhost.anxlabs.net`, which need the owner's account.
- **Housekeeping:** the scratch worktree `b216` used for the A/B comparison was removed at the end of the session (its `node_modules` junction first).
