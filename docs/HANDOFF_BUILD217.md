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
| 217-F Mobile | Not started |
| 217-D AnxNet infrastructure | **Investigation complete** (`docs/anxhost/ANXNET_INFRASTRUCTURE.md`). No code, DNS, port or service change. Recommends a configurable suffix in a later build and an AnxLabs relay only as a separately approved project. |
| 217-G Stabilization and RC preparation | Not started |

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
