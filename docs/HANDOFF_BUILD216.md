# Build 216 handoff: AnxHost CC rebirth

Plan: `PLANS.md` (approved, commit `9aadaead`). Protocol: `AGENTS.md` (ADP).

## Status

| Phase | State |
| --- | --- |
| **216-0 Foundation and capability inventory** | **Complete and approved by the owner (2026-11-20)**: logo (split strategy), navigation and UI foundation approved; committed on `claude/anxhost-build-216` with owner approval as `docs(anxhost): Build 216-0 foundation, inventory and proposals` (hash in the owner report; not pushed). |
| **216-A1 Desktop Shell Rebirth** | **Complete; committed with the owner's approval** as `fc2b47ec` `feat(anxhost): Build 216-A1 desktop shell rebirth` (not pushed). See "216-A1 Desktop Shell Rebirth" below. |
| **216-A2 Home and Customize Home** | **Complete; local checkpoint commit** under the owner's campaign instruction of 2026-11-24 (not pushed). See "216-A2 Home and Customize Home" below. |
| **216-A3 My Servers and server page** | **Complete; local checkpoint commit** (not pushed). See "216-A3 My Servers and the server page" below. |
| **216-A4 Add Server** | **Complete; local checkpoint commit** (not pushed). Marketplace and Create Server in the main window; original art for all 50 templates. See "216-A4 Add Server" below. |
| **216-A5 Computers and Agent Control** | **Complete; local checkpoint commit** (not pushed). See "216-A5" below. |
| 216-A6 Docker, A7 Network, A8 Files and Terminal | In progress (see "Next step") |
| 216-A4 … 216-G | Not started |

## 216-0 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-20T06:18:33-07:00 (system clock, start of the goal) |
| Finish | 2026-11-20T07:27:32-07:00 (system clock, after the last check; only this report was written afterwards) |
| Elapsed | 1 h 08 min 59 s, including 23 min of `rc:validate` and `qa:feature` runs; no time waiting for approvals |
| Commits | None during the goal. Branch created at the approved planning commit `9aadaead`. |
| Owner review and approval session | Owner review of the logo sheet, then the approvals, the icon contrast fix, its smoke, the records and the commit. From the first review artefact (2026-11-20T11:24:35-07:00, file time) to the final checks (11:38:45-07:00), then the commit. Time between 07:27 and 11:24 was waiting for the owner's review. |
| Commit | `docs(anxhost): Build 216-0 foundation, inventory and proposals`, approved by the owner; the single 216-0 commit. Not pushed. |

## Repository and Git state

- Repository confirmed: `AnxLabs/AnxOS-Control-Center` (`origin`
  `https://github.com/AnxLabs/AnxOS-Control-Center.git`), the Electron desktop
  app, **not** the standalone AnxOS operating system.
- `git fetch origin`: `origin/dev` = `13825d70` (Build 215 publication), the
  parent of the approved planning commit `9aadaead`.
- Created `claude/anxhost-build-216` **at** `9aadaead` (`git switch -c`): the
  plan was carried over with no new commit and nothing rewritten. The
  planning branch `claude/anxhost-build-216-planning-acfbb9` is kept at
  `9aadaead`. Worktree: `.claude/worktrees/anxhost-build-216-planning-acfbb9`.
- Nothing pushed, merged, tagged, released or deployed. No version change
  (`release.json` still 2.0 Build 215). No production asset or application
  code changed (`git diff` is empty for `app.js`, `index.html`, `main.js`,
  `preload.js`, `styles.css`, `src/ipc`, `src/services`, `src/mobile`, `agent`).
- `node_modules` is a directory junction to the Build 215 worktree's
  `node_modules` (`anxnet-orbit-relay-f3a366`, same commit, identical
  `package.json` and `package-lock.json`); git-ignored. Nothing downloaded.
- Working tree: `M package.json` plus the new untracked files below.

## Finish lines (PLANS.md 216-0 and the goal)

| # | Finish line | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Inventory every desktop and phone capability: page, tab, dialog, action, IPC call, test, 216 destination; 0 unmapped | **Met: 1,593 rows, 0 unmapped.** The 47 IPC methods without a direct call are classified by evidence (see below) | `docs/anxhost/CAPABILITY_INVENTORY.md`, `capability-inventory.json`; `anxhost-capability-inventory:smoke` PASS (also inside `rc:validate`) |
| 2 | Frozen identifiers documented; a regression check catches a deliberate change; mutation reverted | **Met: 75 checks**; 3 identifier mutations caught and reverted | `docs/anxhost/FROZEN_IDENTIFIERS.md`; `frozen-identifiers:smoke` PASS; mutation table below |
| 3 | Dark and light tokens, UI patterns, stable `data-testid` conventions; plain JS, IPC and security unchanged | **Met (design awaiting approval)**: 160 tokens, 8-state status system, pattern set and gallery in both themes, WCAG contrast 42/42. The testid convention is **enforced**: shared rules in `test-helpers/testid-convention.js`, applied to every UI source by `anxhost-testid-convention:smoke` (28 testids valid; mutation caught) | `src/renderer/anxhost/`, `docs/anxhost/UI_PATTERNS.md`, `NAVIGATION_PROPOSAL.md`, `gallery/` |
| 4 | SVG logo and wordmark options, dark and light, simplified 16-32 px icon, app/tray/favicon sizes; no production asset replaced | **Met (awaiting approval)**: 12 SVGs, 23 PNG sizes, review sheet, 1 `.ico` | `docs/anxhost/brand/` (`anxhost-brand-proposals.png`, `LOGO_STANDARD.md`) |
| 5 | Build 215 UI baseline at 3 sizes for 20 pages, startup and page-switch timings, existing feature QA evidence; blocked captures reported; desktop not interrupted | **Met: 60/60 screenshots, 0 blocked**; timings recorded; **`qa:feature` re-run: 147/147 PASS**; `rc:validate` re-run: 421/423 (2 environmental failures, proven below) | `docs/anxhost/baseline/BASELINE_215.md`; full PNGs in `A:\AnxLabs\40-Assets\AnxHost-CC\build216-0-baseline\build215-ui\` |
| 6 | Legacy AMP, Coolpals, Minecraft redirect and Expo pairing investigated; retirement plan; nothing deleted | **Met**; nothing deleted | `docs/anxhost/LEGACY_RETIREMENT.md` |
| — | Product-name constant (PLANS.md 216-0 item 5) | Added, not used by the UI yet | `src/shared/productBrand.js` |
| — | Owner approval of logo, navigation and UI patterns | **Met (2026-11-20)**: split logo strategy, navigation and UI foundation approved; icon contrast fixed and guarded by `anxhost-brand-assets:smoke` | "Owner approvals (2026-11-20)" below |

## Capability counts

| Measure | Count |
| --- | --- |
| Rows total / desktop / phone | 1,593 / 1,535 / 58 |
| Unmapped | **0** |
| By kind | action 375, ipc 446, input 314, control 186, tab 81, template 50, phone-api 36, dialog 27, nav 22, page 20, phone-screen 11, phone-tab 11, shortcut 10, window 4 |
| By wave | A1 159, A2 26, A3 222, A4 130, A5 263, A6 116, A7 77, A8 147, A9 384, A10 11, C 58 |
| With a stable hook / without (need `data-testid` in 216-A) | 1,564 / 29 |
| Referenced by at least one existing test script | 965 |
| Marketplace templates | 50/50 (wave A4, each needs bundled art) |
| Phone | 5 bottom tabs, 6 server tabs, 11 render functions, 36 API routes |

**IPC (446 preload methods).** A UI caller was found for 399: exact path 212,
by method name 142, by method name near its namespace 45. The other 47 have
no direct call; each is classified by the evidence in the renderer
(inventory "IPC notes"):

| Evidence | Count | Meaning for 216-A |
| --- | --- | --- |
| Feature-detected with `typeof` | 15 | The UI checks the method exists (e.g. `instances.getFiveMReadiness`, `docker.listContainers`); confirm the guarded flow in its wave |
| Referenced without a direct call | 13 | Window plumbing and callbacks (`anxWindow.onNavigate`, `focusMain`, `nodes.onAgentUpdateProgress`, …) |
| Method name built at runtime | 3 | Docker `${actionName}Container` (`app.js:34000`): start, stop, restart |
| No reference in the renderer | 16 | Candidates unused by today's UI (e.g. `account.listDevices`, `nodes.healthAll`, `docker.connectNetwork`, `ownerWorkspace.reorderPages`); backend kept unchanged; any UI for them is out of 216 scope unless the owner asks |

These are mapped and evidenced statically; they are confirmed by behaviour
when their wave runs its flows (`PAGE_ACCEPTANCE.md`).

## Files

| File | Purpose |
| --- | --- |
| `package.json` (modified) | 9 npm scripts: `frozen-identifiers:smoke`, `anxhost-capability-inventory:smoke`, `anxhost-design-tokens:smoke`, `anxhost-testid-convention:smoke`, `anxhost-brand-assets:smoke` (these 5 run in `rc:validate`, which picks up every `:smoke` script: 425 smokes, up from 420), `anxhost:inventory`, `anxhost:baseline`, `anxhost:brand`, `anxhost:gallery` |
| `PLANS.md` (modified) | Two decision-log rows recording the 216-0 owner approvals (no other change to the approved plan) |
| `scripts/anxhost-brand-assets-smoke.js` | Logo and icon set checks B1-B4: files complete, PNG sizes, `.ico` sizes, icon silhouette contrast on dark and light taskbars (Node built-ins only) |
| `scripts/anxhost-capability-inventory.js` | Inventory generator; `--check` fails on unmapped rows or on UI hooks that disappeared or appeared without regenerating |
| `scripts/frozen-identifiers-smoke.js` | 75 frozen identifier checks; fails if the doc stops listing a check |
| `scripts/anxhost-design-tokens-smoke.js` | Token integrity, no raw colours in patterns, all statuses covered |
| `scripts/anxhost-testid-convention-smoke.js`, `test-helpers/testid-convention.js` | `data-testid` rules (shared with future Playwright suites) and their enforcement |
| `scripts/anxhost-ui-baseline-capture.js` | Off-screen, unfocused baseline capture of all pages at any sizes |
| `scripts/test-helpers/offscreen-electron-preload.js` | Opt-in test-harness preload (`NODE_OPTIONS=--require …`) that keeps Electron windows off-screen and unfocused during `rc:validate`, `qa:feature` and UI suites, without changing tests; logs window bounds as evidence |
| `scripts/anxhost-brand-build.js` | Logo SVGs, PNG sizes, `.ico`, review sheet (headless) |
| `scripts/anxhost-gallery-render.js` | Gallery screenshots in both themes and the WCAG contrast check (headless) |
| `src/renderer/anxhost/tokens.css`, `patterns.css` | Proposed design tokens and patterns (not loaded by the app) |
| `src/shared/productBrand.js` | AnxHost CC product names (not used yet) |
| `docs/anxhost/CAPABILITY_INVENTORY.md`, `capability-inventory.json` | Generated inventory |
| `docs/anxhost/FROZEN_IDENTIFIERS.md` | Frozen identifiers, consequences, what is not frozen |
| `docs/anxhost/UI_PATTERNS.md` | Principles, tokens, status system, patterns, enforced test identifier rules, decisions |
| `docs/anxhost/NAVIGATION_PROPOSAL.md` | Proposed sidebar and behaviour, mapping of all 20 pages |
| `docs/anxhost/PAGE_ACCEPTANCE.md` | Per-page acceptance template for 216-A |
| `docs/anxhost/LEGACY_RETIREMENT.md` | AMP, Coolpals, Minecraft redirect, Expo pairing |
| `docs/anxhost/gallery/` | `ui-patterns.html`, renders in dark and light, `contrast-report.json` |
| `docs/anxhost/brand/` | `LOGO_STANDARD.md`, `anxhost-brand-proposals.png`, `svg/` (12), `png/` (app icon, tray, favicon, touch, marks) |
| `docs/anxhost/baseline/` | `BASELINE_215.md` and three contact sheets |
| `docs/HANDOFF_BUILD216.md` | This handoff |

## Validation performed (development PC, 2026-11-20)

| Command | Result |
| --- | --- |
| `npm run rc:validate` (`RC_FAIL_FAST=0`, off-screen harness), 07:03–07:18 | **421/423 PASS**; 2 FAIL, both environmental (below). Includes the 3 new smokes at that time: `frozen-identifiers`, `anxhost-capability-inventory`, `anxhost-design-tokens` all PASS |
| `npm run qa:feature` (off-screen harness), 07:18–07:26 | **PASS, 147 checks** in 477 s |
| `npm run anxhost-testid-convention:smoke` (added after `rc:validate` started) | PASS, self-test 8/8, 28 testids |
| `node --check` on every new script, helper and `productBrand.js` | all pass |
| `npm run qa:fast` | pass |
| `node scripts/anxhost-gallery-render.js` | PASS, 42/42 contrast pairs (dark and light) |
| Inventory generator determinism (regenerate, `cmp` both outputs) | identical |
| `git diff --check` (new files marked intent-to-add) | clean |
| Off-screen evidence (`offscreen-electron-preload` log) | 4 Electron windows shown during the runs: all at x -32000, 0 focused, 0 on screen |
| Baseline capture, 3 launches | 60/60 screenshots, 0 renderer errors, 0 horizontal overflow, final window bounds x -32000, unfocused |

**The 2 `rc:validate` failures are environmental, not regressions.**
`agent:package:smoke` and `local-agent:runtime:smoke` report runtime packages
(`js-yaml`, `dotenv`, `ssh2`) as unresolvable from the Agent closure. They
fail the same way in this worktree **without** the harness, and **both pass**
in the Build 215 worktree, which has a real `node_modules` and the identical
app and Agent code (`13825d70`): "AGENT PACKAGE CLOSURE SMOKE: PASS
(2.0-build215; 2 SKIP, 446 staged paths)" and "Local Agent runtime packaging
smoke checks passed (8 closure packages)". The cause is this worktree's
junctioned `node_modules`, already recorded in `docs/HANDOFF_BUILD215.md`
("`agent-package-closure` passes with a real `node_modules` copy (it fails
with the junctioned one, as before)"). 216-0 changes nothing under `agent/`.

**Mutation tests** (each file restored from a byte copy; `git diff` clean afterwards; the smoke passed again):

| Mutation | Caught by | Result |
| --- | --- | --- |
| `appId` `com.anxos.controlcenter` → `com.anxhost.controlcenter` | frozen-identifiers | FAIL FI-APP-01 (exit 1) |
| `APP_DATA_NAME` `AnxHub` → `AnxHost` | frozen-identifiers | FAIL FI-DATA-01 (exit 1) |
| Phone cookie `__Host-anxos-session` → `__Host-anxhost-session` | frozen-identifiers | FAIL FI-PHONE-01 (exit 1) |
| `data-docker-action="refresh"` → `"reload"` | inventory | FAIL, hook not in inventory (exit 1) |
| Removed `data-catalog-transfer-action="validate"` | inventory | FAIL, inventoried hook gone (exit 1) |
| Gallery `data-testid="nav-home"` → `"NavHome"` | testid convention | FAIL, invalid format and area (exit 1) |

**Problems found and fixed while working**

- The first baseline trial left the QA window **on screen, unfocused, for
  about 35 s**: the app's startup watchdog moved the off-screen window back.
  Fixed with a virtual off-screen display in the QA app; every later capture
  and test window stayed off-screen (logged).
- Playwright deletes `NODE_OPTIONS` before launching Electron; the harness
  therefore adds its own `-r` launch argument, the mechanism Playwright uses.
- Generated inventory ended with a blank line (`git diff --check`); fixed in
  the generator.
- Token smoke would have failed on a CRLF checkout; it now normalises.
- The gallery's own testid `page-my-servers` broke the convention; renamed
  `my-servers-page`. The pre-216 testid `qa-mode-indicator` (used by
  `qa-acceptance` and `capture-product-screenshots`) is kept as a listed
  legacy testid.
- The first IPC classifier run reported nothing because the shell collapsed
  the regex escapes; rewritten as a file, then built into the generator.
- **Icon contrast (owner review).** Measured on the rendered PNGs, the deep
  violet hexagon reached about 1.7:1 against a dark Windows taskbar, so 95 to
  100% of the edge of every icon from 16 to 64 px was below 3:1 (the concept
  folder's own 32 px mark: 96%). Fixed with a `#9854ee` rim on Option B and
  the small icon (3.75:1 dark, 3.91:1 light); a 1 px rim still blurred at
  16 px, so the small icon's rim is 1.5 px there. Details and before/after in
  `LOGO_STANDARD.md`; guarded by `anxhost-brand-assets:smoke` B4.
- **A shell quoting mistake during the approval session.** A one-line Python
  edit passed in double quotes contained Markdown backticks, which bash ran as
  command substitution: it tried to execute `LOGO_STANDARD.md` and, from it,
  `src/assets/anxos-logo.png` as shell scripts. Both stopped on syntax errors
  within their first lines. Checked afterwards: no new or changed files
  (`git status`, a newer-than search over the worktree, and `git diff` on all
  production paths); the only effect was an empty file path in one new
  PLANS.md row, corrected. Edits with Markdown now go through a script file,
  never an inline double-quoted string.

**Owner approval session (2026-11-20, 11:24-11:39)**

| Command | Result |
| --- | --- |
| `node --check` on all 11 new 216-0 JS files (including `anxhost-brand-assets-smoke.js`) | all pass |
| `npm run frozen-identifiers:smoke` | PASS, 75 checks |
| `npm run anxhost-capability-inventory:smoke` | PASS, 1,593 rows, 0 unmapped |
| `npm run anxhost-design-tokens:smoke` | PASS, 160 tokens, 8 statuses |
| `npm run anxhost-testid-convention:smoke` | PASS, self-test 8/8, 28 testids |
| `npm run anxhost-brand-assets:smoke` | PASS (66 checks): 12 SVGs, 23 PNGs, `.ico` 16-256, silhouette on both taskbars |
| Brand smoke mutation: rim width set to 0, assets regenerated | FAIL, 15 checks (every icon size on the dark taskbar, 100% / 95% of edge below 3:1); rim restored, assets regenerated **byte-identical** (SHA-256 of all 37 outputs), smoke PASS |
| Decoder cross-check: the smoke's built-in PNG decoder versus `pngjs` on 5 files | pixel-identical |
| `node scripts/anxhost-gallery-render.js` (twice) | PASS, 42/42 contrast pairs. The PNGs differ between runs (animated status glyphs and skeletons are captured mid-animation); the title bar now shows the rimmed small icon |
| `npm run qa:fast` | pass (5 checks) |
| `git diff --check` (new files marked intent-to-add) | clean |
| Concept folder `A:\AnxLabs\40-Assets\Brand\anxhost-logo` | SHA-256 of all 20 files identical before and after |
| `git diff HEAD` on `assets`, `src/assets`, `windows`, `website`, `src/mobile`, `app.js`, `index.html`, `main.js`, `preload.js`, `styles.css`, `src/ipc`, `src/services`, `agent`, `release.json` | no changes |

`rc:validate` and `qa:feature` were not re-run for this session: the
changes are a generator, its outputs, one new smoke and documentation
(no application, IPC, Agent or test-harness code). Their 07:03-07:26
results above still apply to the application code.

**Not run**

- `rc:validate` and `qa:feature` after the approval session (see above).
- `qa:release` (release tier, planned for 216-G).
- `agent:package:smoke` and `local-agent:runtime:smoke` with a real
  `node_modules` copy inside this worktree (proven instead in the Build 215
  worktree on identical code).

## Findings

1. At the 900x640 minimum window, the Build 215 navigation fills the window
   and page content starts below the fold; the A1 shell must fix this (icon
   rail proposed).
2. The hidden AMP page can be retired, but **Home still shows AMP and
   Minecraft (AMP) cards** from the same snapshot; decide in A2.
3. Expo "Pair Mobile Device" **rotates the node's permanent Agent token** and
   hands it to an app that no longer exists; plan: remove from normal UI in
   A5, keep the backend until a later approved removal.
4. 16 preload methods have no reference in today's renderer (candidates
   unused by the UI); backend unchanged.
5. The plan's six statuses miss `error` and `stopped`, which the app shows;
   the proposal has eight.
6. 29 controls have no stable hook and need a `data-testid` when redesigned.

## Owner approvals (2026-11-20)

1. **Logo: split strategy** (`docs/anxhost/brand/LOGO_STANDARD.md`).
   Option A for large branding (splash, About, website hero, installer
   welcome); Option B for the app title bar, app icons from 48 px, phone
   icons and social previews; the simplified mark for taskbar, tray and
   favicon at 16-32 px. Conditions: keep the concept recognizable, fix
   small-size readability and dark/light contrast (done, see Problems found),
   preserve the concept folder (verified unchanged). No production asset
   replaced; each wave adopts the set (table in `LOGO_STANDARD.md`).
2. **Navigation** (`NAVIGATION_PROPOSAL.md`): Run / Infrastructure / Tools
   with the footer, and the responsive icon rail below 1100 px. Condition:
   every existing capability remains accessible.
3. **UI foundation** (`UI_PATTERNS.md`): dark-first violet and charcoal
   identity, optional light theme, all eight status states, accessible
   contrast and keyboard navigation, **system fonts by default** (replacing
   the PLANS.md wording about bundled OFL fonts; decision log updated).
4. **Commit** of the 216-0 foundation with the message
   `docs(anxhost): Build 216-0 foundation, inventory and proposals`. No push,
   no deployment.

## Remaining risks

- Static evidence for the 47 IPC methods without a direct call is not a
  behaviour test; each wave confirms them by running its flows.
- `anxhost-capability-inventory:smoke` is intentionally strict: any UI hook
  change fails `rc:validate` until the inventory is regenerated. That is the
  216 contract; it can be relaxed after Build 216 with owner approval.
- Logo artwork is a vector draft from an AI-assisted concept; trademark
  clearance of the name and mark is the owner's step.
- Baseline timings come from one PC under normal load (3 launches).
- The icon contrast check uses typical Windows taskbar colours (`#202020`,
  `#f3f3f3`); a custom accent-coloured taskbar is not covered.
- (Settled 2026-11-20: the title bar uses the simplified small mark at 20 to
  28 px; `LOGO_STANDARD.md` aligned in A1.)

## Next step

Campaign instruction (owner, 2026-11-24): continue A2 to A10, then E, D, C,
B, F, G where authorized, solo, with local checkpoint commits; stop at the
release-candidate approval gate. No push, merge, tag, release or deployment
without separate approval; deletions, the 216-E security policy, signing/CI,
domain and production changes need their own approvals.

A1 to A5 are complete and committed locally. **A6, A7 and A8 are next.** Drafted, not linked or committed: `docker.css` (A6),
`network.css` (A7), `tools.css` (A8), their suites, and A8's in-window Add
Storage dialog (`src/renderer/addStorageDialog.js`, markup in `index.html`,
`openStorageModal` in `app.js`), which also fixes Build 215's Add Storage
window: its script used `window.desktopApi`, a name the preload never
exposed, so it could not save, test or cancel (history: since `dbf02c14`).

Owner decisions waiting (nothing blocks the next waves):

- Retire the Marketplace and Create Server windows (named targets in the A4
  section).
- Remove the Expo "Pair Mobile Device" button and handlers from Agent Control
  (A5; `LEGACY_RETIREMENT.md`).
- The Home AMP card (A2): keep, or show only when AMP is configured
  (recommended in `LEGACY_RETIREMENT.md`); unchanged so far.
- A10 deletions: the AMP and Coolpals pages, the dormant inline Create
  Instance form, old CSS and the v1.9 selectors.

## 216-A1 Desktop Shell Rebirth

Contract: `docs/anxhost/A1_FINISH_LINE.md` (owner-approved, `7fa88cab`).
Started from `claude/anxhost-build-216` at `7fa88cab`, clean. No other process
or Claude session was using this worktree (checked at the start: only this
session's shells; the AnxOS sessions were idle in other worktrees).

### A1 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-20T11:49:41-07:00 (system clock, start of the goal) |
| Finish | 2026-11-20T17:54:00-07:00 (system clock, after the last check; the first stop at 14:35:48 was followed by fixing two stale suites, re-measuring performance and, with the owner's approval, rebuilding the Build 215 test node) |
| Elapsed | 6 h 4 min 19 s, including about 1 h 10 min waiting at the acceptance gate for the owner's decision on rebuilding the Build 215 test node (15:25 to 16:35) and the owner's review afterwards; the 900x640 page-switch cost was found and fixed during that review. About 2 h of it was test runs (two full `rc:validate` sweeps, two UI batches, the A/B timing runs, `qa:feature`) |
| Commits | `fc2b47ec` `feat(anxhost): Build 216-A1 desktop shell rebirth`, approved by the owner after review; not pushed |

### What changed

| Area | Change |
| --- | --- |
| Shell styling | `src/renderer/anxhost/shell.css` (new, 216 rules, no `:is()` selector lists, see "Performance"): title bar, sidebar, icon rail and overlay, page host, destination tabs, focus rings, startup, gates, search, command palette, operation tray, shared dialog pattern, toasts, Assistant and computer picker, from the approved tokens only. No raw colours; every rule is scoped under `:root[data-shell="ahx"]`, which outranks the v1.9 shell layer (that layer is removed in A10). Loaded after `styles.css`, with `tokens.css` and `patterns.css`. |
| Title bar | Simplified mark at 22 px, "AnxHost CC", current page, a wide search box, command palette and Assistant buttons, operation tray pill, developer badge, selected computer status (status system shapes and colours), window controls. The QA badge (test builds only) sits in the title bar's flow instead of covering the window controls. |
| Sidebar | Run (Home, My Servers, Add Server), Infrastructure (Computers, Docker, Network), Tools (Files, Terminal, Backups), footer (Activity, Security, Settings, Anx Workspace for the owner, badge "Owner") and the computer switcher, whose dot now follows the computer's state. Headings are labels; nothing is collapsed away. Tab pages (Agent Control, Network addresses, Server consoles, Task details, Maintenance) keep their own pages and elements in a hidden members container, so search and the command palette still list them, and their destination is highlighted. |
| Responsive | 64 px icon rail with tooltips below 1100 px; there Ctrl+B or the toggle opens the full sidebar over the page (Esc, a click outside or choosing a page closes it, focus returns). At full width the toggle collapses to the rail and the choice is remembered with the existing `anxos.sidebar.v1` key. Short windows use a compact density so everything fits at 640 px. Below 600 px (phone widths used by the responsive suite) the rail steps aside and a title-bar menu opens the sidebar. app.js sets `data-sidebar-mode`; no inline sizes. |
| Tabs | Terminal (SSH, Server consoles) and Activity (Activity, Task details, Maintenance) gained tab strips in the existing `page-tabs` pattern, like Computers and Network. |
| Operation tray | Title-bar "N running" pill (only while something runs) and a tray listing running operations with progress; an item opens Activity › Task details; Esc and a click outside close it. It reads the same running list as Activity's "In progress" section. |
| Theme | `<html data-theme>` from the existing Theme setting, in one function (`resolveShellTheme`); dark only until A10. |
| Rename | Shell surfaces read AnxHost Control Center / AnxHost CC. The window title follows the display name; a saved old default ("AnxOS Control Center", which the settings service still returns) shows as the new name. "Unlock AnxOS …" action messages and the "AnxOS website" note are unchanged: they also come from main-process services and the website, which A1 does not touch. |
| Assets | `src/assets/anxhost/` (new): copies of the approved small mark, Option A mark and Option A dark lockup. No production icon changed. |
| Branding docs | `LOGO_STANDARD.md` aligned with the owner's title-bar decision (small mark at 20 to 28 px). `tokens.css` header marked approved. |
| Inventory | Generator regions for the operation tray and the page host; inventory regenerated twice and every difference reviewed (see "Capabilities"). |
| Tests and tooling | New: `scripts/anxhost-shell-ui-qa.js` (A1 acceptance, 78 checks, real app), `scripts/anxhost-brand-allowlist-smoke.js` (31 checks), `scripts/test-helpers/anxhost-real-app.js` (off-screen real-app launcher). Extended: `anxhost-design-tokens-smoke.js` (shell.css: tokens only, no raw colours, scoped). Registered: `anxhost-brand-allowlist:smoke` (runs in `rc:validate`), `anxhost-shell:ui-qa`; the release tier now runs `anxhost-shell-ui-qa` and `sidebar-navigation-groups-ui-qa`. |

No change to `preload.js`, `main.js`, `src/ipc`, `src/services`, `src/shared`,
`agent`, `release.json`, `assets/`, `windows/`, `website/` or
`src/assets/anxos-logo.png` (`git diff HEAD` on those paths is empty).

### Files

Modified: `app.js`, `index.html`, `package.json`,
`docs/anxhost/CAPABILITY_INVENTORY.md`, `docs/anxhost/capability-inventory.json`,
`docs/anxhost/brand/LOGO_STANDARD.md`, `docs/HANDOFF_BUILD216.md`,
`src/renderer/anxhost/tokens.css`, `scripts/anxhost-capability-inventory.js`,
`scripts/anxhost-design-tokens-smoke.js`, `scripts/release-validation.js`, and
the ported tests listed below. New: `src/renderer/anxhost/shell.css`,
`src/assets/anxhost/` (3 SVGs), `scripts/anxhost-shell-ui-qa.js`,
`scripts/anxhost-brand-allowlist-smoke.js`,
`scripts/test-helpers/anxhost-real-app.js`, `scripts/test-helpers/qa-owner.js`
(signs a disposable owner in for suites that need background polling),
`docs/anxhost/a1-shell/` (contact sheets). `AGENTS.md`: one Lessons Learned
entry.

### Capabilities

- The 159 A1 capabilities of the contract are all present: 157 with the same
  inventory id, and 2 (the search and command palette inputs) re-identified by
  their `data-testid`, which the generator prefers; their behaviour hooks are
  unchanged. A1 added 4 rows (operation tray toggle, tray, its Open Activity
  button, the phone-width menu), so wave A1 now has **163 rows, 163 ticked**.
- How each row was verified: every A1 `data-*` hook is present in the running
  shell (`anxhost-shell-ui-qa` S11) and its surface works there (S1-S9, S12);
  the 7 shell dialogs are labelled dialogs (S11); the 56 IPC rows are
  unchanged (no preload or IPC diff), still called (inventory check), and
  the 16 without a direct call were exercised (S12: maximize/restore through
  `isMaximized`/`onMaximizedChanged`; Add Server's workspace window through
  `openWorkspace`, `getWorkspaceContext`/`onWorkspaceInit`, and back through
  `focusMain`/`onNavigate`; `account.getStatus`; `account.listDevices` and
  `revokeCurrentDevice` stay backend-only). The AI rows are exercised by
  `phasex-ui-qa`, the update rows by the update smokes in `rc:validate`.
  Not clicked in a test because they would quit the app or install: window
  Close, Update Now / Download & Install, Restart Now; their handlers are
  unchanged and the controls are present and uncovered (S1).
- Regeneration differences, all reviewed: added the 4 A1 rows above and 9
  page-tab rows (Terminal and Activity tabs, waves A8 and A9); removed only
  the 2 re-identified input ids; no row changed wave, destination or hook.
  1,606 rows, 0 unmapped.
- All 20 pages reachable (S3): 12 from the sidebar, 5 from destination tabs,
  Anx Workspace from the footer for the owner (and still owner-gated when
  signed out), `amp` and `coolpals` keep their redirect to Home; every
  reachable page is in global search.

### Finish lines (A1_FINISH_LINE.md)

| # | Finish line | Result | Evidence |
| --- | --- | --- | --- |
| 1 | 159/159 A1 rows checked working and ticked; the 16 IPC rows without a direct call checked by behaviour | **Met**: 159 preserved, 163/163 A1 rows ticked; the 16 exercised | S11, S12; inventory smoke |
| 2 | All 20 pages reachable, checked automatically; legacy pages keep their behaviour | **Met** | S3; `sidebar-navigation-groups-ui-qa` N1, N4, N7 |
| 3 | 0 backend, IPC, preload, Agent or `src/services` changes; owner items enforced in the main process | **Met** | `git diff HEAD` empty on those paths |
| 4 | `frozen-identifiers:smoke` passes | **Met** (75 checks) | `rc:validate`; brand smoke BA4 |
| 5 | Shell rename via allowlist; title bar uses the small mark at 20-28 px; 0 production icons changed; new `brand-allowlist` smoke | **Met** | `anxhost-brand-allowlist:smoke` (31 checks; 3 mutations caught); S1, S8 |
| 6 | Shell CSS uses only tokens and patterns; 0 raw colours | **Met** (216 scoped, token-only rules) | `anxhost-design-tokens:smoke` (3 mutations caught) |
| 7 | Run / Infrastructure / Tools + footer; icon rail below 1100 px with tooltips and accessible names | **Met** | S2, S4 |
| 8 | 900x640: content visible above the fold on all 20 pages | **Met** (page heading at 80 px; content 836 px wide) | S4; screenshots |
| 9 | Keyboard: Tab, visible focus, Ctrl+K and Ctrl+Shift+P everywhere, dialogs trap and return focus, Esc closes; 10/10 shortcuts | **Met** | S5 (Tab with a 5.5:1 focus ring, Ctrl+K on 3 pages, palette, search + Enter, Esc everywhere it opens, 10/10 shortcut handlers), S4/S6 focus return |
| 10 | Contrast: WCAG AA text, 3:1 icons and focus ring | **Met** (lowest text 6.1:1, icons 7.4:1, focus 5.5:1) | S7 (15 measurements) |
| 11 | Screenshots at 900x640, 1280x800, 1920x1080 for all 20 pages and the shell surfaces; no clipping, overflow or overlap | **Met** (60/60, 0 horizontal overflow, 0 renderer errors) | `docs/anxhost/a1-shell/`; full PNGs below |
| 12 | 23 shell-driving UI suites ported to `data-testid`; nothing weakened, skipped or loosened; replacements listed | **Met: 23/23 ported and passing** (`build215-ui-qa` on its rebuilt test node, with the owner's approval) | final UI batch and reruns |
| 13 | Cold start and page switch within Build 215 +10% | **Met**: every approved budget; same-day startup medians within +10% at all sizes (900x640 and 1920x1080: 14 rounds, 1280x800: 5); page switching within +10% (direct measurement at 900x640: +5.1% median, +8.2% total, after removing a real shell CSS cost) | "Performance" |
| 14 | `node --check`, 216 smokes, `qa:fast`, `git diff --check`, `qa:feature` in full | **Met**: `node --check` 20/20, `rc:validate` 424/426 (2 known environmental), `qa:fast` within `qa:feature`, `git diff --check` clean, **`qa:feature` 147/147** | "Validation performed" |
| 15 | Handoff with checklist, timings, commands, screenshots; commit only with approval; no push | **Met** (this section); nothing committed or pushed | — |

### Tests ported (the 23 shell-driving suites)

| Suite | What changed | Final run |
| --- | --- | --- |
| `sidebar-navigation-groups-ui-qa` | Rewritten for the approved IA; same 7-check coverage restated (N2 headings are labels instead of toggles; N3 the remembered rail instead of remembered groups; N5 Advanced Mode leaves the sidebar alone instead of opening Tools) | PASS (7 checks) |
| `qa-acceptance` | Nav by `[data-testid="nav-item"][data-page-target]`; Agent Control reached through Computers › Agent & connection (the approved path); launch check now requires the AnxHost window title | PASS |
| `stabilization-ui-qa` | `.main-content` → `shell-page-host` testid; welcome title is the new name | PASS |
| `responsive-mobile-ui-qa` | Shell controls by `shell-sidebar` / `shell-titlebar` testids | PASS (failed before the phone-width fix; passes on Build 215) |
| `acceptance-fixes-ui-qa`, `phase8-ui-qa`, `anxnet-ui-qa`, `instances-layout-ui-qa`, `files-layout-ui-qa` | Shell readiness wait on the `shell-sidebar` testid instead of `.nav-menu` | PASS |
| `server-view-ui-qa`, `instances-refresh-preservation-ui-qa` | Shell readiness wait on the `shell-sidebar` testid (server-view); both sign a disposable owner in first (stale since Build 212's locked-polling rule; see below) | PASS (9/9, 4/4) |
| `phasex-ui-qa`, `build213-ui-qa`, `build214-ui-qa`, `build215-ui-qa`, `phase9-ui-qa`, `mobile-ui-qa`, `steamcmd-cancel-ui-qa`, `infra-inventory-ui-qa`, `node-routes-ui-qa`, `playit-account-ui-qa`, `service-managed-ui-qa`, `second-machine-acceptance` | No shell selectors (they drive pages through `window.showPage`, unchanged); run unmodified | PASS (`build215` on its rebuilt test node, 9/9) | PASS except `build215` and `instances-refresh-preservation` (below); `build214`: **PASS 10/10** rerun alone (476 s; clean-up left 0 containers) |

Smokes ported because the approved design changed what they asserted (not
loosened): `onboarding-smoke` and `onboarding-fresh-install-smoke` (welcome
title), `ui-network-page-smoke` (Network addresses is a tab of the Network
destination, still listed through `NAV_PARENT_PAGES`). `ui-polish-smoke` was
satisfied by restoring the developer badge's attribute order, not changed. No
time limit was raised and no check was removed.

**Two stale suites, fixed.** `server-view-ui-qa` (V2 "Overview to show
Running") and `instances-refresh-preservation-ui-qa` ("poll applies the
stopped state") failed identically on unchanged Build 215 code. Root cause
(probed in the running app, not guessed): both rely on My Servers' background
poll, and since Build 212 the app does no background work while locked
(`isAppLockedForBackgroundWork`: `securityState.localOwnerAuthenticated !==
true`). Neither suite signed an owner in, so the poll never ran. The Agent
itself brought the stand-in server to Running in 1 s (direct API probe), and
the window was not hidden (`visibilityState: "visible"`). Ported: both now
sign a disposable owner in first, through the new
`scripts/test-helpers/qa-owner.js` (the same steps as `phasex-ui-qa`; a
password generated per run, only inside the temporary profile). No assertion
changed. Results: `instances-refresh-preservation-ui-qa` 4/4 (R1-R4),
`server-view-ui-qa` 9/9 (V1-V9).

**`build215-ui-qa`: test node rebuilt with the owner's approval, 9/9.** Its
code has no shell selector (it drives pages through `window.showPage`), so
nothing needed porting; it needs the Build 215 acceptance node `anx215-a`,
which no longer existed. With the owner's go-ahead ("Yes, rebuild it") it was
rebuilt from the repo and the Build 215 notes:

1. `docker build -t anx215-node:test test-helpers/disposable-node`.
2. `docker run -d --name anx215-a --hostname anx215-a --privileged
   --cgroupns=private --tmpfs /run --tmpfs /run/lock -p 127.0.0.1:2221:22
   -p 127.0.0.1:47191:47131 anx215-node:test` (Git Bash: `MSYS_NO_PATHCONV=1`).
3. Inside it: the official `AnxOS-Agent-2.0-build213.deb` downloaded from the
   v2.0-build213 release and checked against its `SHA256SUMS` (OK), installed
   with `NEEDRESTART_SUSPEND=1`.
4. The Build 215 update helper copied from Git's index
   (`git show HEAD:packaging/agent-deb/update-helper`; the Windows working
   copy has CRLF, the container copy has 0 CR bytes), root 0755; the
   `%anxos-update` line of `packaging/agent-deb/anxos-agent.sudoers` as
   `/etc/sudoers.d/anxos-agent-update-test` (0440, `visudo -c` OK, the
   location the Build 215 notes require); group `anxos-update` created and
   `anx` added to it and to `anxos-control`; `/etc/anxos-agent/agent.env`
   `AGENT_HOST=0.0.0.0` so the published port reaches the Agent.
5. Checks before the run: `sudo -n update-helper status` as `anx` reported
   `INSTALLED=2.0-build213`; `http://127.0.0.1:47191/api/v1/health` HTTP 200;
   the Agent token file present.

Result (167 s): U1, K1, E1, F1, P1 (the real 2.0-build213 → 2.0-build215
update through the helper, every step complete, node verified on
2.0-build215), C1, D1, W1, W2: **9/9**. The suite removed its own nginx
container and volume. Left in place for later RC acceptance, as Build 215 did:
container `anx215-a` (now on 2.0-build215) and image `anx215-node:test`
(`docker rm -f anx215-a` and `docker rmi anx215-node:test` remove them), and
the `nginx:stable-alpine` image W2 pulled.

### Performance

Same tool as the 216-0 baseline (`anxhost-ui-baseline-capture.js`, one launch
per size, off-screen). Budgets are the A1 finish line's (Build 215 baseline
+10%).

**Against the approved budgets** (3 rounds, all three sizes, A1 means):

| Size | Renderer ready (budget) | Sidebar ready (budget) |
| --- | --- | --- |
| 900x640 | 1334 ms (2582) | 2025 ms (3938) |
| 1280x800 | 1417 ms (2393) | 2181 ms (3887) |
| 1920x1080 | 1849 ms (1964) | 2480 ms (3045) |

Page switch (60 switches per run): median 30.75 ms (budget 35.5), max
142.3 ms (budget 176.7). **All met.**

**Against Build 215 measured the same day** (Build 215 at `13825d70`, same
tool and harness). A first 3-round comparison by mean looked bad (A1 +14 to
+62% at 1280 and 1920), but single launches vary widely on this PC (Build
215 alone: 1521 to 2466 ms for the same measurement), so means of 3 were
dominated by outliers. Repeated with 5 alternating rounds and compared by
median:

| Size | Renderer ready, 215 / A1 | Sidebar ready, 215 / A1 | Page switch median, 215 / A1 |
| --- | --- | --- | --- |
| 1280x800 | 1486 / 1483 ms (-0.2%) | 2270 / 2184 ms (-3.8%) | 32.5 / 33.9 ms (+4.3%) |
| 1920x1080, 5 rounds | 1428 / 1494 ms (+4.6%) | 2108 / 2358 ms (+11.9%) | 32.2 / 32.0 ms (-0.6%) |
| **1920x1080, 14 rounds** | **1150.5 / 1168.5 ms (+1.6%)** | **1646.5 / 1696 ms (+3.0%)** | **30.35 / 29.15 ms (-4.0%, 280 switches each)** |

Five rounds left 1920x1080 sidebar-ready at +11.9%, which could not be told
apart from noise, so 9 more alternating rounds were run (all 14 reported, none
dropped).

**900x640 found a real cost, now fixed.** 14 alternating rounds at 900x640
put page switching at +15.8% (23.8 → 27.6 ms median), slower on almost every
page. A stylesheet on/off experiment (5 rounds) traced it to `shell.css`
(+19.6%): its `:is(…)` lists in ancestor position (for example
`:is(.security-gate, .app-modal, …) :is(.inline-action, …)`, and
`:is(.global-search-result, …) span`) are matched by every page button,
`span`, `p` and heading during a switch, without the browser's ancestor
filter. Fix: every `:is()` in `shell.css` expanded into a plain selector list
(33 rules), with a check that the before and after files contain exactly the
same 377 selector/declaration pairs and the same 36 comments (identical), so
nothing can look different. After it the stylesheets cost nothing measurable
(32.35 ms with, 33.90 ms without, 5 rounds). Re-validated: token smoke (216
scoped, token-only rules), brand smoke, `anxhost-shell-ui-qa` 78/78.

After the fix, 14 alternating rounds at 900x640 (medians):

| Measure | Build 215 | A1 | Difference |
| --- | --- | --- | --- |
| Renderer ready | 1418 ms | 1214 ms | -14.4% |
| Sidebar ready | 2088.5 ms | 2037.5 ms | -2.4% |
| Page switch (tool: switch + 2 animation frames) | 26.70 ms | 29.60 ms | +10.9% |

The tool's switch time includes two animation frames (about 16.7 ms each), so
a sub-millisecond change can move a sample by a whole frame. Measured
directly (each page's `showPage()` and the style and layout it triggers,
forced with `offsetHeight`, no frame waits; 3 alternating rounds, 5 passes
over 17 pages each):

| Measure | Build 215 | A1 | Difference |
| --- | --- | --- | --- |
| Median per switch | 7.9 ms | 8.3 ms | +5.1% |
| Sum over all switches | 2954 ms | 3196 ms | +8.2% |

**Finish line 13 is met**: every approved budget, and every same-day
comparison within +10% (startup at all three sizes; page switching by direct
measurement at 900x640, and by the tool at 1280x800 and 1920x1080). The
largest single-page difference is Computers' rendering at 900x640 (9.9 →
17.4 ms), worth a look when wave A5 rebuilds that page.
Cause check: at 1920x1080, A1 with and without its three new stylesheets
(5 alternating rounds) gave renderer-ready medians of 1544 and 1631 ms,
sidebar-ready 2452 and 2383 ms (+2.9%), page switch 34.65 and 34.70 ms; the
new CSS costs at most about 3%. The raw runs were scratch files; the medians above are the record.

### Validation performed (development PC, 2026-11-20)

Final runs on the finished code:

| Command | Result |
| --- | --- |
| `npm run rc:validate` (`RC_FAIL_FAST=0`, off-screen harness), 13:23–13:55 | **424/426 PASS**. The 2 failures are the environmental ones from 216-0 (`agent:package:smoke`, `local-agent:runtime:smoke`: junctioned `node_modules`). Includes `frozen-identifiers` (75), `anxhost-capability-inventory` (1,606 rows, 0 unmapped), `anxhost-design-tokens` (shell.css scoped and token-only), `anxhost-testid-convention`, `anxhost-brand-assets`, `anxhost-brand-allowlist` (new) |
| `npm run qa:feature` (off-screen harness), 14:17–14:27 | **PASS, 147 checks** in 572 s; the dirty-tree guard found no change made by a check |
| `node scripts/anxhost-shell-ui-qa.js` (A1 acceptance, real app) | **PASS 78/78** (final batch, 48 s) |
| The 23 shell-driving UI suites, final code (off-screen, one at a time) | 18 PASS in the batch; `acceptance-fixes`, `phase8` and `mobile` failed only while `rc:validate` ran beside them and **PASS** rerun alone (85 s, 42 s, 124 s); `build214-ui-qa` **PASS 10/10** rerun alone (476 s; clean-up left 0 containers); `server-view` 9/9 and `instances-refresh-preservation` 4/4 after their owner sign-in port; `build215-ui-qa` **9/9** on its rebuilt test node. **23/23 pass** |
| `node scripts/second-machine-acceptance.js --out …` | **PASS**: `qa-acceptance`, onboarding fresh install, responsive |
| `node --check` on the 20 changed or new JS files | all pass |
| `git diff --check` (new files marked intent-to-add) | clean |
| Mutation tests (scratch copy of the repo files; working tree untouched) | brand allowlist: old name in the title bar, old name in the welcome, appId changed: each FAIL; token smoke: raw colour, unscoped selector, undefined token in shell.css: each FAIL |
| Same-day A/B timings, Build 215 vs A1, 3 alternating rounds | see "Performance" |
| `git diff HEAD` on `preload.js`, `main.js`, `src/ipc`, `src/services`, `src/shared`, `agent`, `release.json`, `assets`, `windows`, `website` | empty |

Earlier in the goal (discovery runs, superseded by the final runs above): a
first `rc:validate` sweep (found the 3 smokes to port and the inventory to
regenerate) and a first UI batch (found the `qa-acceptance` Agent Control
path, the phone-width rail and the `second-machine-acceptance` `--out`
argument).

`build214-ui-qa` note: two runs were killed by my runner's 15-minute cap
mid-install, which skipped the suite's own clean-up and left 3 `anx214qa-*`
test containers and 6 volumes; the next run then refused to install over
them (correct behaviour). I removed exactly those test resources (the suite's
own clean-up step, by its `anx214qa-` prefix; 0 left, no stray processes) and
ran it again alone without the cap. Docker images it pulled were left in
place.

**Not run**

- `qa:release` as a whole (release tier; its UI suites were run individually
  above, the remaining release-tier smokes are covered by `rc:validate`).
- Nothing else from the A1 contract.

**Problems found and fixed while working**

- The QA badge covered the maximize and close buttons; it now sits in the
  title bar's flow.
- The computer switcher dot was green for an offline computer (my first
  shell.css coloured it statically); it now follows `data-agent-state` with the
  status system's shapes.
- The rail was 4 px too tall at 900x640 and the overlay and 1280x640 sidebar
  scrolled; compact densities fixed both (S4 checks them).
- "OWNER ONLY" squeezed "Anx Workspace" to "Anx …"; the badge reads "Owner"
  (with a tooltip).
- Phone widths (390 px): the rail cost Home 14 px and the responsive suite
  failed (it passes on Build 215); the rail now steps aside below 600 px and a
  title-bar menu opens the sidebar.
- The first `rc:validate` sweep found 3 smokes asserting text or structure the
  approved design changed; ported as listed above.

### Screenshots

- Contact sheets (in Git): `docs/anxhost/a1-shell/a1-shell-900x640.jpg`,
  `a1-shell-1280x800.jpg`, `a1-shell-1920x1080.jpg` (all 20 pages each) and
  `a1-shell-surfaces.jpg` (rail, overlay, phone overlay, search, palette,
  operation tray, Assistant, update dialog, onboarding, owner workspace,
  local setup and security gates).
- Full-resolution PNGs and `baseline-metrics.json` (kept out of Git):
  `A:\AnxLabs\40-Assets\AnxHost-CC\build216-a1-shell\` (60 page screenshots,
  `surfaces\` 15 shell surfaces).

### A1 remaining risks

- Startup timing on this PC is noisy (one measurement varies by up to 60%
  between launches); judge it by medians of many alternating rounds. Re-measure
  after A10 removes the v1.9 shell layer.
- Pages keep their Build 215 styles inside the new shell until their wave;
  page-level "AnxOS" text (for example the Home eyebrow, Settings' saved app
  name) is renamed by those waves. "Unlock AnxOS …" messages come from
  main-process services as well, so they need one coordinated change.
- The window, tray and exe icons still show the AnxOS logo until 216-D (owner
  decision); the title bar shows the new mark meanwhile.
- The rebuilt Build 215 test node `anx215-a` (privileged container) is still
  running for later RC acceptance; remove it with `docker rm -f anx215-a` when
  it is no longer needed.
- Add Server still opens its own window (A4).
- The 216-0 environment limitation remains: `agent:package:smoke` and
  `local-agent:runtime:smoke` fail with this worktree's junctioned
  `node_modules` (pass with a real copy).

## 216-A2 Home and Customize Home

Started from `claude/anxhost-build-216` at `1ffcd2fd`, clean, under the
owner's campaign instruction of 2026-11-24 ("continue the AnxHost CC Build 216
campaign, no /goal": waves A2 to A10, then E, D, C, B, F, G where authorized;
local checkpoint commits allowed; no push, merge, tag, release or deployment).
Worked solo, one writer, no workflows or subagents.

### A2 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-24T21:18:18-07:00 (system clock) |
| Finish | 2026-11-24T22:09:20-07:00 (system clock, before the commit) |
| Elapsed | 51 min 2 s (about 25 min of it test runs: the Home suite, the regression batch, the acceptance-fixes A/B and the timing A/B) |
| Commit | see `git log` (`feat(anxhost): Build 216-A2 Home and Customize Home`) (local checkpoint under the campaign instruction; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| Shared page layer | `src/renderer/anxhost/pages.css` (new, 41 rules): page header (eyebrow, title, lede), buttons (`inline-action`, `primary-button`, primary, danger, disabled, focus), form controls inside pages, panels (`panel`, `status-card`, `settings-section`), status pills mapped onto the eight status colours, server state pills (`instance-state`) with the status shapes and sentence case, disclosures. Every later page wave builds on it. |
| Home | `src/renderer/anxhost/home.css` (new, 81 rules): overview tiles, Needs attention, server cards, computer cards with the status shapes (dot online, diamond needs attention, ring offline or connecting, square not connected), meters, Customize Home, setup checklist, "More actions and computer details". Layout grids from Build 215 kept. |
| Markup and copy | Home eyebrow "AnxOS" → "Overview"; app-name "AnxOS" → "AnxHost" in Home text (all-clear line, computer details note, unreachable-Agent detail, next step, "is available to", "is running", first-server guide). "AnxOS Agent" and the AnxOS distro label are frozen and kept. Testids: `home-page`, `home-overview`, `home-tile`, `home-section-<id>`, `home-attention-item`, `home-attention-ok`, `home-computer`, `home-server-card`, `home-customize`, `home-customize-toggle`, `home-customize-row`, `home-details`. |
| Customize Home (accessibility) | Move up / Move down buttons now name their section ("Move Setup checklist up"), and keyboard focus follows the moved section; before, the list was rebuilt and focus fell to the page. |
| Bug fix: dialogs with a disabled first target | The first-server guide put initial focus on the first game card, which is disabled until the Marketplace templates load, so focus stayed on the page behind the dialog. It now starts on the first enabled card or "Browse all games". The shared `activateModal` also falls back to the dialog's first enabled control whenever its chosen target cannot take focus, so every dialog is covered. |
| Token smoke | `anxhost-design-tokens-smoke` now checks every AnxHost page stylesheet in `src/renderer/anxhost/` (not only `shell.css`): defined tokens only, no raw colours, every selector under `:root[data-shell="ahx"]`, and no `:is()` selector lists (the A1 page-switch cost). A deliberately bad file was rejected on all five rules. |
| Tests | New `scripts/anxhost-home-ui-qa.js` (H1–H11, 35 checks, real app, signed-in disposable owner) registered as `npm run anxhost-home:ui-qa` and in the release tier. |

No backend, IPC, preload, main-process or Agent change.

### Capabilities

All 26 A2 inventory rows are ticked after being checked working in the real
app (`anxhost-home-ui-qa`): the 11 `data-dashboard-action` buttons (routing
checked for 7; Start All, Stop All and Restart Agent checked at the action they
call, recorded rather than run, so the fixture Agent and its servers were not
restarted; Refresh checked by its confirmation), the attention action, the
first-server guide's close and "Browse all games", Continue Setup, the next
step, Customize, the details disclosure, the page, and the six IPC rows
(`system.getSnapshot`, `system.networkCheck` through the computer details'
internet check, `telemetry.getSummary/getSeries/export/clear`,
`amp.getSnapshot`) called as the signed-in owner. Inventory: 189 of 1,606 rows
verified (A1 163 + A2 26); `anxhost-capability-inventory:smoke` passes.

### Finish lines (PLANS.md, per wave)

| Finish line | Result |
| --- | --- |
| 100% of the wave's inventory rows checked | 26/26 |
| Tests ported | No existing test needed a change: the Home-touching suites pass unchanged (below) |
| Screenshots at 900x640, 1280x800, 1920x1080, no clipping | `docs/anxhost/a2-home/` (3 sizes plus Customize); H8 measures no horizontal overflow and no clipped Home text at all three sizes |
| Contrast | H9: 71 Home text elements at 4.5:1 or better; status shapes at 3:1 or better |
| Timing within Build 215 +10% | Met for page switching: same-day, 3 alternating rounds at 900x640 measured directly (255 switches per build): Build 215 median 12.0 ms, A2 11.2 ms (-6.7%); total 4208 vs 4009 ms (-4.7%); Home alone 13.1 vs 13.7 ms (+4.6%). Startup was not re-measured for A2 alone (two small stylesheets); it is measured with A3 |
| `node --check`, `git diff --check` | Clean |

### Validation performed (development PC, 2026-11-24)

| Check | Result |
| --- | --- |
| `node --check` on `app.js`, `homeDashboard.js`, `homeDashboardModel.js`, the new suite and the token smoke | PASS |
| `git diff --check` | Clean |
| `anxhost-design-tokens-smoke` (now all page stylesheets), `anxhost-testid-convention-smoke`, `frozen-identifiers-smoke` (75), `anxhost-brand-allowlist-smoke`, `anxhost-capability-inventory --check`, `home-dashboard-model-smoke`, `v19-ui-refresh-smoke`, `build193-productivity-smoke`, `ui-polish-smoke`, `onboarding-smoke`, `dashboard-metrics-presentation-smoke` | PASS |
| `anxhost-home-ui-qa` (final code) | **PASS 35/35** (60 s). Earlier runs failed first on the first-server dialog focus (the bug above), which is the failing-first evidence for that fix |
| `anxhost-shell-ui-qa` | PASS 78/78 |
| `phase8-ui-qa`, `simple-ui-screenshots-qa`, `sidebar-navigation-groups-ui-qa`, `stabilization-ui-qa` | PASS |
| `acceptance-fixes-ui-qa` | 8/9; **A2 "the dashboard polls again after the unlock" fails on the base too** (environment exception, below) |

**Environment exception: acceptance-fixes A2.** The check needs 2 dashboard
snapshot reads within 7 s of an unlock. Same-day, one at a time: the committed
A1 code passed once with exactly 2, then failed with 0 and 1 in two
alternating A2-only runs, and the A2 code failed with 1 and 1. The IPC log
shows why: each `system:getSnapshot` took 4 to 6 s on this PC during these
runs (started at about 1 s, completed at 5 to 7 s), so at most one fits in the
window; the 2 s poll skips while a read is in flight. Not caused by A2 and not
weakened; rerun it on a quiet machine before the release tier.

### Performance

Same-day A/B with Build 215 (`anxnet-orbit-relay-f3a366` at `13825d70`), 900x640,
3 alternating rounds, each page's `showPage()` plus the style and layout it
triggers (`$SP/perf/probe_switch.js`, no frame waits):

| Measure | Build 215 | A2 | Difference |
| --- | --- | --- | --- |
| Median per switch | 12.0 ms | 11.2 ms | -6.7% |
| Sum over all switches | 4208 ms | 4009 ms | -4.7% |
| Home | 13.1 ms | 13.7 ms | +4.6% |

Both builds were about 50% slower than on 2026-11-20 (Build 215 then: 7.9 ms
median), so only same-day comparisons mean anything; the same slowness shows
in the 4 to 6 s snapshot reads above.

### Screenshots

`docs/anxhost/a2-home/`: Home at 900x640, 1280x800 and 1920x1080, and Customize
Home at 1280x800 (from `anxhost-home-ui-qa --shots`).

### A2 remaining risks

- `pages.css` restyles shared controls on every page (buttons, inputs, panels,
  pills). The shell suite (78/78) and the Home-adjacent suites pass, and every
  later wave re-checks its own pages; pages not yet redesigned can still show
  Build 215 layouts inside the new controls until their wave.
- acceptance-fixes A2 depends on how fast `system:getSnapshot` answers on the
  test PC (environment exception above).
- The Create Server dialog's own copy ("AnxOS will check this system ...") is
  renamed with Add Server in A4.

## 216-A3 My Servers and the server page

Started from `2684898e` (A2) at 2026-11-24T22:10:10-07:00, same campaign
instruction, solo.

### A3 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-24T22:10:10-07:00 (system clock) |
| Finish | 2026-11-24T22:40:14-07:00 (system clock, before the commit) |
| Elapsed | 30 min 4 s (most of it test runs: the A3 suite, 9 real-app suites, 26 smokes and the timing A/B; the A4 artwork generator was written during the runs) |
| Commit | `feat(anxhost): Build 216-A3 My Servers and server page` (local checkpoint; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| Styling | `src/renderer/anxhost/servers.css` (new, 82 rules): list panels and summary tiles on tokens (status-coloured icons), the server list as a table above 1320 px and as cards at 1320 px and below (the card carries the colour, its cells stay transparent), the server page header (game icon, meta chips, address chip and Copy), quick actions and the More menu, underline tabs like the shell's page tabs, Overview cards with status-toned labels, console on an inset surface, file table hover/selection/folder icons, settings bar and groups, service (systemd) panel tones. Several Build 215 server-page rules are page-scoped (`.page[data-page="instances"][data-server-view="open"] …`), so the AnxHost rules here are scoped to the page as well to outrank them. The page header stays unboxed. |
| Markup | Only the stylesheet link. No JavaScript, IPC, preload, main-process or Agent change. |
| Test harness | `launchRealApp` takes `agentOptions` (passed to the service-managed Agent fixture), so a suite can add a disposable stand-in server. |
| Tests | New `scripts/anxhost-servers-ui-qa.js` (M1–M15, 46 checks, real app, signed-in owner, stand-in Paper server) registered as `npm run anxhost-servers:ui-qa` and in the release tier. It covers the 70 A3 inventory rows no other suite exercised. |

**Finding (no change made): the inline "Create Instance" form is dormant.**
My Servers' "Create Server" button opens the Create Server window
(`openCreateServerWorkspace`), and no code path calls
`setInstanceCreateFormVisible(true)`, so the older inline form
(`data-instance-create-form`, 13 `data-instance-form` fields, the template
cards, Create Instance and Cancel) cannot be reached in Build 215 or now.
Shown directly it still works (M3: presets set the type, an invalid ID is
refused with "Use an ID with 2-64 letters…", nothing is created, Cancel
closes it). Its rows are kept and ticked as "preserved, dormant"; retiring the
form is an A10 candidate that needs the owner's approval naming it.

### Capabilities

All 222 A3 rows are ticked:

- 152 rows were already covered by existing suites, all of which pass on the
  A3 code (below).
- The 70 rows without a test are covered by `anxhost-servers-ui-qa`:
  - By behaviour: search and status filter, the computer selector, Create
    Server, the dormant form's presets, fields, validation and Cancel, both
    Copy address buttons, "All servers", all nine tabs, the console (lines,
    search, status filter, Wrap, Pause/Auto-scroll, Copy, Download, Jump to
    latest, Send), Files' Up, "All backups", Advanced, Raw configuration, the
    Network link, Add-ons' provider choice, Import and Check for updates, the
    More menu, and the FiveM dialog (show/hide key, empty key refused,
    Cancel).
  - By presence and state, where running them would change the fixture
    without a meaningful assertion: Reset Runtime (enabled for a stopped
    server), Adopt service, Open service, Restart now, Add port, Update all,
    Reset Defaults, Change history, Technical details, "Why are some actions
    unavailable?" and Open server.cfg.

Inventory: 411 of 1,606 rows verified (A1 163, A2 26, A3 222).

### Validation performed (development PC, 2026-11-24)

| Check | Result |
| --- | --- |
| `anxhost-servers-ui-qa` (final code) | **PASS 46/46** (53 s) |
| `anxhost-design-tokens-smoke` | PASS (servers.css 82 rules, scoped, token-only, no `:is()`) |
| Real-app suites covering A3 rows, one at a time: `service-managed-ui-qa`, `instances-layout-ui-qa` (4), `server-view-ui-qa` (9), `phasex-ui-qa` (11), `instances-refresh-preservation-ui-qa` (4), `steamcmd-cancel-ui-qa` (2), `anxnet-ui-qa` (8), `build213-ui-qa` (4), `stabilization-ui-qa` | PASS |
| `anxhost-shell-ui-qa`, `anxhost-home-ui-qa` on the A3 code | PASS 78/78 and 35/35 |
| Hermetic smokes covering A3 rows (26): `instance-network-performance-ui-smoke`, `instances-ipc-authorization-smoke`, `permission-matrix-smoke`, `public-access-smoke`, `steamcmd-update-polish-smoke`, `minecraft-players-smoke`, `server-sign-in-smoke`, `preload-exposure-contract-smoke`, `workload-transfer-smoke`, `local-agent-discovery-scope-smoke`, `instances-node-routing-smoke`, `workload-transfer-gate-behavior-smoke`, `ui-polish-smoke`, `steamcmd-instance-update-smoke`, `steamcmd-auto-update-smoke`, `server-version-checks-smoke`, `server-page-fixes-smoke`, `scheduled-update-progress-smoke`, `restore-preview-smoke`, `restart-schedule-editor-smoke`, `player-monitor-smoke`, `mod-manager-smoke`, `marketplace-smoke`, `instances-ipc-error-contract-smoke`, `instance-snapshot-wiring-smoke`, `onboarding-smoke` | PASS |
| `service-managed-mutation-check` | **Not run to completion**: it reruns `service-managed-ui-qa` once per mutant and exceeded the 300 s cap used here; A3 changed no guarded code (styling only), and `service-managed-ui-qa` itself passes |
| `build214-ui-qa` (3 A3 rows; real Docker installs, about 8 min) | Not rerun for a styling-only wave; its A3 rows are also covered by the suites above |
| `node --check` (changed JS), `git diff --check` | PASS, clean |

### Screenshots

`docs/anxhost/a3-servers/`: the server list and the server page at 900x640,
1280x800 and 1920x1080 (from `anxhost-servers-ui-qa --shots`). M13 measures no
horizontal page overflow and no clipped header, tile, tab or action text at
all three sizes; M14 measures 4.5:1 text and 3:1 status shapes on both views.

### Performance

Same day as A2, alternating with Build 215 (`anxnet-orbit-relay-f3a366` at `13825d70`).

Page switching at 900x640, 3 rounds, measured directly (255 switches per build):

| Measure | Build 215 | A3 | Difference |
| --- | --- | --- | --- |
| Median per switch | 9.3 ms | 9.8 ms | +5.4% |
| Sum over all switches | 3196 ms | 3405 ms | +6.5% |
| My Servers | 13.7 ms | 15.8 ms | +15.3% |
| Home | 9.4 ms | 10.8 ms | +14.9% |

Overall switching is within +10%. The single-page medians rest on 15
samples each and swing more between runs than this difference (in the A2 run
an hour earlier Build 215's My Servers was 16.9 ms and A2's 16.0 ms), so they
are recorded, not concluded; they are re-measured with more rounds after A4.

Startup at 1280x800, 3 rounds: renderer ready 2381 → 2168 ms (-8.9%),
sidebar ready 3049 → 3362 ms (+10.3%), with Build 215 itself ranging from
1605 to 3894 ms between launches. **Inconclusive** at 3 rounds (the A1 lesson:
use many alternating rounds); re-measured for A2 to A4 together after A4.

### A3 remaining risks

- Labels still say "instances" in a few places ("Search instances", "Total
  Instances"); tests and the inventory key off hooks, not labels, so renaming
  them is safe but was left for the A10 consistency pass to keep this wave
  styling-only.
- `build214-ui-qa` and `service-managed-mutation-check` were not rerun (above).

## 216-A4 Add Server (Marketplace and Create Server in the main window)

Started from `6b2a7a77` (A3) at 2026-11-24T22:41:10-07:00, same campaign
instruction, solo. (The art set, `add-server.css` and the suite were drafted
from 22:17 while A3's checks ran.)

### A4 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-24T22:41:10-07:00 (system clock; drafting from about 22:17) |
| Finish | 2026-11-24T23:19:26-07:00 (system clock, before the commit) |
| Elapsed | 38 min 16 s from the A4 start, plus about 24 min of drafting during A3's checks; most of it test runs (two UI batches including build214 and build215 with real installs and a real Agent update, 26 smokes) |
| Commit | `feat(anxhost): Build 216-A4 Add Server in the main window` (local checkpoint; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| Add Server in the main window | `openWorkspaceSurface()` no longer asks the main process for a window when called from the main window: it calls the new `enterAddServer(mode, context)`. "browse" is what the Marketplace window showed (cards, package details with "Continue to Create Server", favourites, providers, saved view state); "create" is what the Create Server window showed (the two-step setup for one template, deployment progress, recovery). `isCreateServerFlow()` and `isMarketplaceBrowseSurface()` replace the window-only checks, so every flow that used to need the window works in place. With no template, Create Server shows the first-server guide over the browse view, as the window did; Cancel returns to browsing; a game in the guide opens Create Server for it. Every entry point stays in place: sidebar Add Server, Home New Server, My Servers Create Server, "Create Your First Server", package details, the guide, the Assistant. |
| Window code kept | A dedicated window (`?surface=`) still works for any older caller; the main-process `window:openWorkspace` handler, the preload bridge and the `body.*-window` CSS are untouched. Their deletion is a retirement decision for A10 (approval needed, below). |
| Shared styles for later waves | `pages.css` gained the form, note, summary-grid, empty-state and list-item styles used by Agent Control, Settings and Security (added while A4's checks ran; covered by the reruns above). |
| Layout | `src/renderer/anxhost/add-server.css` (new, 37 rules): the two windows' layout rules re-expressed for `body[data-add-server-mode="browse" | "create"]`, plus the AnxHost look for the toolbar, categories, provider tabs, template cards, favourites, details, the Create Server steps and the first-server cards. |
| Artwork | 50 original SVG tiles in `src/assets/anxhost/marketplace/<template-id>.svg`, generated by `scripts/anxhost-marketplace-art.js` (49 pictograms drawn from simple shapes; the two import templates share a folder pictogram in their runtime's colours). No third-party logo, trademark or downloaded image; source and licence for every file in `docs/anxhost/MARKETPLACE_ART_SOURCES.md` (generated, `--check` fails on drift). The ten Minecraft-family entries each have a distinct pictogram and colour. `createMarketplaceIcon()` shows the bundled tile for curated templates, keeps provider packs' own icons (the CSP `img-src` is unchanged) and falls back to the text monogram if a file cannot load. |
| Identity | Cards carry `data-template-id` and the `template-card` testid. |
| Copy | "AnxOS sets everything up for you" and the guide's install message say AnxHost. The catalog's `author: "AnxOS"` fields are catalog data (the catalog export is byte-stable) and are unchanged. |
| Tests | New `scripts/anxhost-add-server-ui-qa.js` (AS1–AS10, 36 checks, real app) registered as `npm run anxhost-add-server:ui-qa` and in the release tier. Ported (approved requirement: Create Server is no longer a window): `acceptance-fixes-ui-qa` A9, `build214-ui-qa` and `build215-ui-qa` D1 drive Create Server in the main window and leave it with Cancel's path instead of closing a window; `anxhost-home-ui-qa` H7 expects New Server to land on Add Server and checks that no window opens; `marketplace-smoke` checks the renamed install message. |

### Owner decision needed (deletion gate, A10)

To retire the two windows completely, approve deleting, by name:

- `main.js`: the `window:openWorkspace` and `window:getWorkspaceContext`
  handlers and the workspace-window creation they use;
- `preload.js`: `openWorkspace`, `getWorkspaceContext`, `onWorkspaceInit`
  (and `focusMain` if nothing else uses it);
- `app.js`: the `workspaceSurface` branches (`launchParameters` surface,
  `applyWorkspaceWindowContext`, the workspace navigation buttons and their
  storage event);
- `index.html`: the `data-workspace-navigation` buttons;
- `styles.css`: the `body.workspace-window`, `body.marketplace-window` and
  `body.create-server-window` rules.

Until then nothing in the main window opens them (AS1: 0 new windows from
every entry point).

### Capabilities

All 130 A4 rows are ticked:

- 99 rows were already covered by existing suites and smokes; the UI suites
  among them were rerun on the A4 code (below), and the four that assumed a
  Create Server window were ported.
- The 31 rows without a test are covered by `anxhost-add-server-ui-qa`:
  - By behaviour: "Create Your First Server", the card button
    (`data-marketplace-installed-action`, "View Details" while browsing),
    Cancel, search, provider modes (Featured, Trending, Recently Updated), the
    provider filters (a changed loader is saved), Refresh, the Downloads and
    Notifications shortcuts, the Minecraft version "Browse" toggle, the install
    plan dialog, the Docker service passwords dialog (made-up values), and
    Catalog Transfer (Export fills the document, Copy, Validate Import,
    Clear).
  - By presence: Create Server's Back button (hidden while its two-step flow
    has no earlier step), the Downloads Refresh, Advanced options, Technical
    details and Logs, and the version, storage and Playit fields.
- `CAP-WIN-WIN-window-workspace` (the workspace BrowserWindow) is kept and
  still verified: `anxhost-shell-ui-qa` S12 now opens it through the kept
  bridge (`anxWindow.openWorkspace`) and checks that the sidebar no longer
  does.

Inventory: 541 of 1,606 rows verified (A1 163, A2 26, A3 222, A4 130).

### Validation performed (development PC, 2026-11-24)

| Check | Result |
| --- | --- |
| `anxhost-add-server-ui-qa` (final code) | **PASS 38/38** (52 s) |
| `anxhost-home-ui-qa` (H7 ported: New Server lands on Add Server, no window opens) | PASS 36/36 |
| `anxhost-shell-ui-qa` (S12 ported: sidebar Add Server stays in place; the kept bridge still opens a window) | PASS 79/79 |
| `simple-ui-screenshots-qa` (Create Server section ported to the main window) | PASS 8/8 |
| `steamcmd-cancel-ui-qa` | PASS 2/2 (it **failed on the first A4 build**: browse mode hid the deployment panel with the Downloads list and its Cancel; fixed, and `anxhost-add-server-ui-qa` AS2 now guards it) |
| `acceptance-fixes-ui-qa` (A9 ported) | PASS 9/9 (A2 and A6 failed in the first batch under load and passed rerun one at a time) |
| `build214-ui-qa` (Create Server ported; sign-in now uses the sign-in screen's own refresh, as build215 does) | PASS 9, SKIP 1 (A1 needs `BUILD214_QA_JAR`): real installs of Jellyfin, a Node.js project and Unturned through Create Server in the main window; 0 test containers left |
| `build215-ui-qa` (D1 ported) | 8/10: D1 (Create Server fit check, in the main window) and W1/W2 pass; **P1 and C1 fail**: the real Agent update to the test node `anx215-a` timed out (240 s); the node shows SSH sessions at 23:00 and no package install (still `2.0-build213`). This path (Agent Control, main process, SSH) is unchanged by A4; rerun pending before it is called environmental |
| Hermetic smokes covering A4 rows (26, including `marketplace-smoke` with the renamed message, `anxhost-marketplace-art --check`, `ipc-boundary-hardening-smoke`, the design, testid, frozen-identifier and brand checks) | PASS |
| `marketplace-steamcmd-real-install`, `marketplace-docker-real-install` | Not run: they exercise the install backends A4 does not change; `build214-ui-qa` ran real installs through the new UI |
| `node --check`, `git diff --check` | PASS, clean |

### Screenshots

`docs/anxhost/a4-add-server/`: browse and create at 900x640, 1280x800 and
1920x1080, plus the art contact sheet (`a4-art-sheet.jpg`).

### Performance

Not measured before this commit: A2 to A4 are timed together on the committed A4 tree (a copy outside the worktree, alternating with Build 215), recorded in the A5 section.

### A4 remaining risks

- Leaving Add Server while a server is being created keeps the install
  running (progress stays in Downloads and Activity, as when the Create Server
  window was closed); returning through the sidebar shows the browse view.
- The window code paths are untested from the main window now that nothing
  opens them; they are kept only until the A10 deletion decision.
- The art is original and generic by design; official game artwork would
  need documented permission (PLANS.md section 5) and owner approval.

## A2 to A4 performance (measured on the committed A4 tree)

Same day (2026-11-24, from 23:20), alternating with Build 215
(`anxnet-orbit-relay-f3a366` at `13825d70`), the A4 commit `81a68cca` run
from a copy outside the worktree so later work could not change it.

| Measure | Build 215 | A4 | Difference |
| --- | --- | --- | --- |
| Startup: renderer ready (7 rounds, median) | 1148 ms | 1225 ms | +6.7% |
| Startup: sidebar ready (7 rounds, median) | 1732 ms | 1806 ms | +4.3% |
| Page switch, 900x640, median (5 rounds, 425 switches each) | 8.5 ms | 8.8 ms | +3.5% |
| Page switch, sum | 5071 ms | 5265 ms | +3.8% |
| Home | 11.0 ms | 10.4 ms | -5.5% |
| My Servers | 13.5 ms | 14.0 ms | +3.7% |
| Add Server | 39.4 ms | 41.7 ms | +5.8% |

Every measure is within Build 215 +10%, which also settles A3's single-page
figures (15 samples each, recorded as inconclusive). One A4 startup sample
was an outlier (5307 ms); the median is unaffected. Tools:
`$SP/perf/probe_startup.js` (new: launch to renderer and sidebar ready) and
`$SP/perf/probe_switch.js`.

## 216-A5 Computers, fleet, AnxNet and Agent Control

Started from `81a68cca` (A4) at 2026-11-24T23:20:53-07:00, same campaign
instruction, solo.

### A5 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-24T23:20:53-07:00 (system clock) |
| Finish | 2026-11-24T23:38:00-07:00 (system clock, before the commit) |
| Elapsed | 17 min 7 s (styling plus the A5 suite; the A6 to A8 drafts and the A8 Add Storage dialog were written while A4's timing ran) |
| Commit | `feat(anxhost): Build 216-A5 Computers and Agent Control` (local checkpoint; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| Styling | `src/renderer/anxhost/computers.css` (new, 19 rules): summary tiles, computer cards, the computer details panel and its resource cards and core bars, computer chips, the AnxNet panel and Agent Control's section grids, on tokens. Agent Control's forms, notes, summary grids and lists use the shared `pages.css` styles added in A4. Styling only: no JavaScript, IPC, preload, main-process or Agent change. |
| Test helpers | `scripts/test-helpers/inventory-hooks.js` (new): checks that a wave's inventory hooks are in the running app (`data-*` in the DOM after the pages were visited, `api.*` callable on the bridge), kept apart from behaviour checks; computed hooks, `fn:` dialogs and the `#x` dialog placeholder are left to behaviour checks. `launchRealApp`'s clean-up now retries and warns instead of throwing when Windows briefly locks a temporary folder (it had turned a passing run into an error). |
| Tests | New `scripts/anxhost-computers-ui-qa.js` (C1–C12, 27 checks, real app) registered as `npm run anxhost-computers:ui-qa` and in the release tier. |

**Not done (owner decision):** removing the Expo "Pair Mobile Device" button
and its handlers from Agent Control (`LEGACY_RETIREMENT.md`). The button is
kept and still present (C7).

### Capabilities

All 263 A5 rows are ticked:

- 192 rows were already covered by existing suites and smokes, all of which
  pass on the A5 code (below).
- The 71 rows without a test are covered by `anxhost-computers-ui-qa`:
  - By behaviour: computer cards and Refresh, the details drawer (Refresh,
    Edit, Remove asks first and cancelling keeps the computer, close), the
    Add Computer dialog's setup paths and Cancel, Check All updates, Load
    Network Inventory, every Agent Control section, Agent logs (Refresh,
    search, severity, Pause, Wrap), Capture Snapshot, Run Health Checks,
    Copy Summary, Load Provenance Report, Copy Report, New Browser Code
    (which says why there is no code while this PC's Agent is unreachable,
    as the harness keeps it), Test Connection.
  - By presence (C7, C12): the actions that change an Agent or open folders
    and files (pair, repair, save, reload configuration, reconnect, update
    all, mobile pairing, complete setup, open logs folder, export bundle),
    the 13 configuration fields, setup mode and start options, and every
    other A5 hook (249 present in the running app).

Inventory: 804 of 1,606 rows verified (A1 163, A2 26, A3 222, A4 130, A5 263).

### Validation performed (development PC, 2026-11-24/25)

| Check | Result |
| --- | --- |
| `anxhost-computers-ui-qa` (final code) | **PASS 27/27** |
| `build213-ui-qa` (4), `stabilization-ui-qa`, `infra-inventory-ui-qa` (189 rows), `anxnet-ui-qa` (8), `node-routes-ui-qa` (2), `mobile-ui-qa` (19) | PASS |
| `sidebar-navigation-groups-ui-qa`, `qa-acceptance` | **Failed first, then PASS after porting**: both still expected Add Server to open a window (A4 fallout this batch found). N7 now checks that every entry, Add Server included, opens in the main window and no window opens; `qa-acceptance` checks Add Server is visible in the main window with one window |
| Hermetic smokes covering A5 rows (35, from `add-computer-flow-smoke` to `ui-polish-smoke`, including the Agent Control, nodes and permission-matrix smokes) | PASS |
| `anxhost-design-tokens-smoke`, `anxhost-capability-inventory --check` | PASS |
| `build215-ui-qa` (18 A5 rows) | Not rerun in A5; its last run (A4) passed every check but the real Agent update (P1, C1), which is still pending a rerun |
| `node --check`, `git diff --check` | PASS, clean |

### Screenshots

`docs/anxhost/a5-computers/`: Computers and Agent Control at 900x640,
1280x800 and 1920x1080.

### A5 remaining risks

- Page copy on these pages still says "AnxOS" in places ("without leaving
  AnxOS", "AnxNet is AnxOS's own private network"). Several sentences name
  the installed app ("AnxOS Control Center"), which only changes with the
  216-D installer, so the wording is left for the A10 consistency pass.
- Actions that change an Agent (pair, repair, save, reload, reconnect,
  update, mobile pairing, complete setup) and folder/export actions were
  checked by presence only here; their behaviour is covered by the existing
  smokes listed above.
