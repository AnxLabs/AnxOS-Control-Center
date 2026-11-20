# Build 215 UI baseline (Build 216-0)

Captured 2026-11-20 13:28:27 from Build 215 code (`13825d70`; the 216 branch adds only docs and scripts) with `scripts/anxhost-ui-baseline-capture.js` (`npm run anxhost:baseline -- <dir>`).
 UTC
## Method

- The real Electron app (`--qa-mode`) with an isolated profile and config, backed by the real Agent test fixture (`scripts/test-helpers/service-managed-agent-fixture.js`: one computer "QA Computer" with one service-managed FiveM server, AnxRP). No installed app, user data, Anxlab or VPS was touched.
- One fresh launch per size. The CSS viewport is set to exactly 900x640, 1280x800 and 1920x1080 (verified per run); each of the 20 `section[data-page]` views is shown through `window.showPage`, left to settle for 1.5 s, then captured.
- **Desktop not interrupted:** in this disposable QA app only, the capture script patches `BrowserWindow` show/focus and gives Electron a virtual off-screen display, so windows open off-screen (x = -32000), unfocused and out of the taskbar. Production code is unchanged. Recorded final window state for each run: `x -32000, y -32000, focused false`.
- **Switch time** = `showPage(name)` until two animation frames later (synchronous render work). It does not include later data loads.
- **Startup** = launch until the renderer bridge is ready, and until the sidebar is laid out (after "Use this device").

Full-resolution PNGs (60) and `baseline-metrics.json`: `A:\AnxLabs\40-Assets\AnxHost-CC\build216-0-baseline\build215-ui\` (kept out of Git for size). Contact sheets in this folder: `build215-baseline-900x640.jpg`, `build215-baseline-1280x800.jpg`, `build215-baseline-1920x1080.jpg`.

## Results

| Size | Screenshots | Renderer ready | Sidebar interactive | Renderer errors | Horizontal overflow |
| --- | --- | --- | --- | --- | --- |
| 900x640 | 20/20 | 2347 ms | 3580 ms | 0 | 0 pages |
| 1280x800 | 20/20 | 2175 ms | 3534 ms | 0 | 0 pages |
| 1920x1080 | 20/20 | 1785 ms | 2768 ms | 0 | 0 pages |

Cold start is from three launches on the development PC under normal load; treat it as representative, not a benchmark. The 216-A budget compares against these numbers (+10% unless the owner approves otherwise).

## Page switch times (ms)

| Page | Shown | 900x640 | 1280x800 | 1920x1080 | Median |
| --- | --- | --- | --- | --- | --- |
| `dashboard` | itself | 11.3 | 9.6 | 41 | 11.3 |
| `amp` | `dashboard` (redirect) | 2.5 | 13 | 24.1 | 13 |
| `playit` | itself | 65.1 | 58.9 | 71 | 65.1 |
| `coolpals` | `dashboard` (redirect) | 17.9 | 16.4 | 67.3 | 17.9 |
| `docker` | itself | 45.6 | 39.4 | 47 | 45.6 |
| `marketplace` | itself | 160.6 | 120.2 | 112.2 | 120.2 |
| `instances` | itself | 104.8 | 137.2 | 77.5 | 104.8 |
| `ssh` | itself | 39.1 | 41 | 43.6 | 41 |
| `files` | itself | 53.5 | 50.6 | 53.4 | 53.4 |
| `console` | itself | 45.4 | 46.1 | 44.8 | 45.4 |
| `backups` | itself | 29.2 | 29.7 | 29.3 | 29.3 |
| `operations` | itself | 9.3 | 9.6 | 18.1 | 9.6 |
| `notifications` | itself | 22.4 | 20.2 | 29.3 | 22.4 |
| `maintenance` | itself | 21.8 | 21.4 | 22.1 | 21.8 |
| `security` | itself | 14 | 31.9 | 38.1 | 31.9 |
| `owner-workspace` | `security` (redirect) | 3 | 5 | 35.1 | 5 |
| `agent-control` | itself | 29.4 | 30.9 | 31.1 | 30.9 |
| `nodes` | itself | 56.2 | 63.5 | 57.8 | 57.8 |
| `network` | itself | 29.8 | 25.5 | 30.1 | 29.8 |
| `settings` | itself | 32.6 | 37.8 | 14.7 | 32.6 |

All 60 switches: median 32.25 ms, max 160.6 ms (`marketplace` and `instances` are the slowest).

## Findings for the redesign

1. **900x640 (the window minimum):** the Build 215 sidebar switches to a top navigation block that fills the viewport; after any Tools page is opened the expanded Tools group covers most of the window, and page content starts below the fold on every page. The A1 shell must keep content visible at the minimum size.
2. **Redirects:** `amp` and `coolpals` show Home, and `owner-workspace` shows Security in this profile (it needs an Owner sign-in). See `../LEGACY_RETIREMENT.md`.
3. **Marketplace** in the main window renders in place when shown with `showPage`; the sidebar "Add Server" click opens the separate window instead (inventory row `CAP-WIN-WIN-window-workspace`).
4. No renderer errors and no horizontal page overflow at any size.

## Existing feature QA evidence (reused, not re-run)

216-0 changes no application code: the app under test is identical to the
Build 215 release (`13825d70` adds only release-record docs and the test-only
commit `9cfcaaaf` on top of the accepted RC4 commit `0f975cd1`). The evidence
recorded in `docs/HANDOFF_BUILD215.md` therefore still applies:

| Check | Result | Where recorded |
| --- | --- | --- |
| `npm run rc:validate` (local, before RC4 push) | 420/420 (`RC_FAIL_FAST=0`) | "Release candidate 4" |
| CI `windows-release.yml` run 44720106371 on `0f975cd1` | static-validation, rc-validation (420/420 on Linux), Linux and Windows passed | "Release candidate 4" |
| Release run 44726313441 (tag `v2.0-build215`) | all five jobs passed | "Published (2026-11-20)" |
| `npm run qa:release` (final gate) | 136 passed, 1 failed: `acceptance-fixes-ui-qa` A2, which fails the same way on the Build 214 baseline (load timing, not a 215 regression); the three later steps passed when run directly | "Final gate (2026-11-19)" |
| `build215-ui-qa` in the installed RC4 | 9/9 | "Release candidate 4" |

Re-run in 216-0 on the 216 branch (application code identical to Build 215),
with every app window kept off-screen and unfocused by
`scripts/test-helpers/offscreen-electron-preload.js`:

| Check | Result |
| --- | --- |
| `npm run qa:feature` (2026-11-20 07:18-07:26) | **PASS, 147 checks** |
| `npm run rc:validate`, `RC_FAIL_FAST=0` (07:03-07:18) | **421/423 PASS**; `agent:package:smoke` and `local-agent:runtime:smoke` fail only because this worktree's `node_modules` is a junction, and both pass in the Build 215 worktree with a real `node_modules` on the same code (details in `docs/HANDOFF_BUILD216.md`) |
