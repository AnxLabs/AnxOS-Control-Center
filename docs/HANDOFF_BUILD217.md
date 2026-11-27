# Build 217 handoff — Operation Refinement

Plan: `PLANS.md` (Build 217 section). Protocol: `AGENTS.md` (ADP).

## Status

| Phase | State |
| --- | --- |
| Plan | Written 2026-11-27 (Build 217 section at the top of `PLANS.md`; the Build 216 plan is kept below it). |
| 217-A Performance | **Complete; local checkpoint commit** (not pushed). The time until the shell appears is down 65% (8.7 s to 3.1 s), Home's idle Agent requests are down 26%, and My Servers no longer rebuilds rows on each poll. Memory is down 1-3%; the target needs the owner's startup-sound decision. |
| 217-B UI polish | Not started |
| 217-C Domain and account | Not started |
| 217-E Installer and update reliability | Not started |
| 217-F Mobile | Not started |
| 217-D AnxNet infrastructure | Not started |
| 217-G Stabilization and RC preparation | Not started |

## Repository

- Branch `claude/anxhost-build-217`, created from `origin/dev` at `87cf3d56` (Build 216 published, website canonical on `anxhost.anxlabs.net`).
- Commits: a local checkpoint commit when each phase is complete, as in Build 216 (PLANS section 5). Nothing is pushed without approval.
- Build 216 reference checkout for same-day A/B: a detached worktree at `87cf3d56` in the session scratchpad (`b216`). It is temporary and removed at the end.

## Time

| Phase | Start | Finish | Elapsed |
| --- | --- | --- | --- |
| Plan and 217-A | 2026-11-27T10:28:59-07:00 | 2026-11-27T11:25:44-07:00 | 0 h 57 min |

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
