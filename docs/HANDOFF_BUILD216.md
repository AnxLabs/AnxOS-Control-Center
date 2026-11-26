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
| **216-A6 Docker, A7 Network, A8 Files and Terminal** | **Complete; one local checkpoint commit** (not pushed). Two Build 215 defects fixed (Add Storage window, Windows Agent folders). See "216-A6, 216-A7, 216-A8" below. |
| **216-A9 Activity, Security, Settings, Workspace** | **Complete; local checkpoint commit** (not pushed); the accent setting works again on redesigned pages. See "216-A9" below. |
| **216-A10 Consistency and light theme** | **Complete; local checkpoint commit** (not pushed). Light theme (Dark, Light, System) on tokens only; legacy styles bridged to AnxHost tokens; two controls-cut-off defects and unreadable placeholders fixed; full validation sweep and performance re-check. Legacy retirement done with the owner's approval (2026-11-25; 51 inventory rows retired). See "216-A10" and "Legacy retirement" below. |
| **216-E Secure Session Persistence** | **Complete; local checkpoint commit** (not pushed). Approved policy implemented: secure storage only, token rotation on every restore, device binding, enforced idle lock (15 min default) and a real manual lock. See "216-E" below. |
| **216-D Custom Installer** | **Implemented; local checkpoint commit** (not pushed). New art from the brand SVGs, AnxHost names on every page, shortcut and uninstall entry, "AnxHost Helper". Not compiled on this PC (junctioned `node_modules`); Sandbox install, upgrade, repair and uninstall need the signed CI build (216-G). See "216-D" below. |
| **216-C Phone Access Rebirth** | **Complete; local checkpoint commit** (not pushed). The phone uses the desktop's tokens, follows the phone's light or dark scheme, says AnxHost, uses the Option B icons and the `anxos-shell-v3` cache; a Build 215 pairing still works. See "216-C" below. |
| **216-B Website and Branding** | **Partly complete; local checkpoint commit** (not pushed, not deployed). B2: every page, the READMEs and the release tooling say AnxHost Control Center ("formerly AnxOS Control Center"; release history keeps its names); AnxHost logo, icons and social preview. B3: domain plan written. Not done: new product screenshots and a layout redesign (see "216-B"). |
| **216-F Integration and Migration** | **Complete; local checkpoint commit** (not pushed). Real Build 215 to 216 upgrade 8/8, 216 desktop with a Build 215 Agent 5/5, all 1,573 capabilities verified, `qa:feature` 147/147; two phone defects shipped in Build 215 fixed (add-ons list, backup check result). See "216-F Integration and Migration" below. |
| 216-G | Not started: needs the version bump (commit and push approval) and the signed RC workflow dispatch |

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

A1 to A10 are complete and committed locally. On 2026-11-25 the owner
wrote "i approved anything", recorded as approval of the 216-E security
review (with the recommended answers D1–D6) and of the 216-D installer
design. 216-E, 216-D and 216-C are done and 216-B is partly done (screenshots and layout open); **216-F is next**, then G. The exact-reply
gates (`confirmed`, `done`, `🚀 publish`), pushes, signing or CI workflow
changes, and deletions still need their own approvals naming the target.

Owner decisions waiting (nothing blocks the next waves):

- The Home AMP card (A2): keep, or show only when AMP is configured
  (recommended in `LEGACY_RETIREMENT.md`); unchanged so far.
- The v1.9 stylesheet layer and old page-specific CSS (including the
  retired pages' rules): a separate, measured removal.
- Removing the Expo pairing backend (`nodes:createMobilePairing`,
  `mobilePairingService`, the Agent claim page and their smokes), whose UI is
  gone.
- Push approval for the signed CI build (216-G) and the domain plan (B3).

Done 2026-11-25 with the owner's approval ("Approve all deletions"): the
legacy retirement, see "Legacy retirement (A10 deletions)" below.

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

## 216-A6 Docker, 216-A7 Network and Sharing, 216-A8 Files, Terminal and Backups

Started from `de3e5799` (A5) at 2026-11-24T23:38:56-07:00, same campaign
instruction, solo. The three waves were validated together and committed as
one local checkpoint.

### Timing

| Field | Value |
| --- | --- |
| Start | 2026-11-24T23:38:56-07:00 (system clock; the drafts were written during A4's and A5's checks) |
| Finish | 2026-11-25T00:56:29-07:00 (system clock, before the commit) |
| Elapsed | 1 h 17 min 33 s (most of it in the three suites, the two product defects they found and the Build 215 base comparison of build215-ui-qa) |
| Commit | `feat(anxhost): Build 216-A6 to A8 Docker, Network, Files and Terminal` (local checkpoint; not pushed) |

### What changed

| Wave | Change |
| --- | --- |
| A6 Docker | `src/renderer/anxhost/docker.css` (new, 24 rules): summary tiles, toolbar, the shared data table (`docker-table`, also used by other pages), resource panels and items, output and inspect viewers, inspector tabs, empty and loading states. Styling only. |
| A7 Network | `src/renderer/anxhost/network.css` (new, 18 rules): Sharing tiles, the Playit status card with status-coloured edge, providers, tunnels, steps, endpoint cards, diagnostics stages and the endpoint picker. Styling only. |
| A8 Files, Terminal, Backups | `src/renderer/anxhost/tools.css` (new, 26 rules): toolbars and panels, console sources with status dots, filter chips, crash alert, the storage list, the file table, context menu, editor and terminal surfaces. |
| A8: Add Storage in the main window | New dialog in `index.html` (`data-add-storage-*`, testid `files-add-storage`) and `src/renderer/addStorageDialog.js`; `openStorageModal()` opens it instead of the window. Same IPC (`files.saveConnection`, `files.testConnection`) and the same "saved" handler (`handleStorageConnectionSaved`); errors use the app's own wording; saved secrets are never sent back to the page (blank keeps them). |
| **Fix: Build 215's Add Storage window never worked** | Its script used `window.desktopApi`, a name the preload has never exposed (it exposes `anx`, `anxos`, `anxhub`, `electronAPI`); so Save, Test Connection, Cancel, Escape and the edit pre-fill did nothing since the window was added (`dbf02c14`). Proven at run time on the kept window (T2: `desktopApi=undefined`). Users now get the working in-window dialog; the window, its IPC (`storageWindow:*`) and `windows/add-storage.*` are kept until their retirement is approved. |
| **Fix: Files could not open folders on a Windows Agent computer** | On a Windows computer's Agent filesystem, the Files page normalized paths with the POSIX remote rules: `C:\…\folder` has no leading `/`, so it was treated as relative and glued onto the current folder, and the Agent rightly refused the result as outside its root. Opening any subfolder (double-click, Go, Up) failed. Windows absolute paths (`C:\`, `\\server\share`) are now kept native in `normalizeFilesPathValue`, `joinFilesPath`, `getFilesParentPath` and the Up helper; Linux Agents, local files and single-device mode are unchanged, and the Agent's root check is still the boundary. Before the fix the probe saw an empty list and an empty path after opening a folder; after it, the folder's files (A8 T3, T4). |
| Fix: Files path placeholder | It read "/home/user or C:SERSYOU" (an earlier uppercase replacement mangled `C:\Users\you` and the attributes, Build 215 included, since `d9661c0f`); now "/home/user or C:\Users\you". |
| Inventory generator | Knows the Add Storage dialog region, so its 15 hooks are A8 rows (A8: 166 rows). |
| Tests | New `anxhost-docker-ui-qa` (12 checks), `anxhost-network-ui-qa` (15), `anxhost-tools-ui-qa` (37), registered in `package.json` and the release tier. |

**Dormant controls found (kept as found, owner decision for A10):** the
Backups page's "Search backup name or source" box is `disabled` in the markup
and has no handler (A8 T6 checks it as present and disabled).

**Safety:** the Docker suite reads the real Docker daemon (the owner's
containers were listed and left untouched: still up after every run); it
opens only this suite's test container (`anx215-a`). Every Docker-changing
control is checked by presence only. Files writes happen only inside a
temporary folder in the test Agent's own folder.

### Capabilities

All 359 rows of the three waves are ticked (A6 116, A7 77, A8 166, the last
including the 15 hooks of the new Add Storage dialog):

- Rows already covered by existing suites and smokes: those suites and 48
  smokes pass on this code (below).
- Rows without a test are covered by the three new suites: by behaviour
  where it is safe (Docker reads, refreshes, the cleanup Preview, logs and
  inspector tabs on the test container; the reverse-proxy form refusing an
  invalid route; diagnostics stage actions, drawn by the app's own renderer
  for a stage given a fix because every stage passes against the test Agent;
  Add Storage save, edit, Escape, Mark Default, delete; Files Go, list,
  search, New Folder, Rename, Delete, editor Open, Save to disk, Revert,
  Wrap, Minimap, Fullscreen, Copy Path, height; console sources, filters,
  Pause, Send, Copy, Clear, source search, navigation; Backups create,
  restore preview and Cancel, Verify, delete), and by presence for actions
  that change Docker or open native dialogs (create, pull, prune, Compose
  up/down, upload, download, import). Each suite also checks every hook of
  its wave is in the running app (D9, N7, T9).

Inventory: 1,163 of 1,621 rows verified (A1 163, A2 26, A3 222, A4 130,
A5 263, A6 116, A7 77, A8 166).

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `anxhost-docker-ui-qa` | **PASS 12/12** (the owner's containers listed, never opened; the test container opened read-only) |
| `anxhost-network-ui-qa` | **PASS 15/15** |
| `anxhost-tools-ui-qa` | **PASS 37/37** (Files writes inside its own temporary folder; real edit saved through the Monaco editor) |
| `phase8-ui-qa` (9), `files-layout-ui-qa` (1), `playit-account-ui-qa` (5), `acceptance-fixes-ui-qa` (9), `anxhost-shell-ui-qa` (79), `qa-acceptance`, `anxhost-add-server-ui-qa` (38), `server-view-ui-qa` (9), `simple-ui-screenshots-qa` (8) | PASS |
| `build215-ui-qa` | 8/10: every check passes but the real Agent update (P1, C1). **Environment exception**: Build 215's own code (`anxnet-orbit-relay-f3a366`, its own copy of the suite) fails P1 and C1 identically on the same node the same day; the node gets the SSH sessions and never installs the package (still `2.0-build213`). The cause is not determined; the update path is unchanged in 216. |
| Hermetic smokes covering A6 to A8 rows (48, including the Docker, network, SSH, files, backups, public-access, storage-window and permission-matrix smokes, `monaco-worker-csp-smoke`, `modal-behavior-smoke`) | PASS |
| `anxhost-design-tokens-smoke`, `anxhost-testid-convention-smoke`, `frozen-identifiers-smoke`, `anxhost-brand-allowlist-smoke`, `anxhost-capability-inventory --check` | PASS |
| `node --check`, `git diff --check` | PASS, clean |

### Screenshots

`docs/anxhost/a6-docker/`, `docs/anxhost/a7-network/`, `docs/anxhost/a8-tools/`
at 900x640, 1280x800 and 1920x1080.

### Remaining risks

- `build215-ui-qa`'s real Agent update (P1, C1) result is in the validation
  table; the update path is unchanged by these waves.
- The Add Storage window and its IPC are still present (unused by the app)
  until the owner approves their retirement.

## 216-A9 Activity, Security, Settings, Maintenance and Anx Workspace

Started from `9420d52a` (A6 to A8) at 2026-11-25T00:56:58-07:00, same
campaign instruction, solo.

### A9 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-25T00:56:58-07:00 (system clock; `account.css` and the suite were drafted during A6 to A8's checks) |
| Finish | 2026-11-25T01:11:00-07:00 (system clock, before the commit) |
| Elapsed | 14 min 2 s |
| Commit | `feat(anxhost): Build 216-A9 Activity, Security, Settings and Workspace` (local checkpoint; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| Styling | `src/renderer/anxhost/account.css` (new): section navigation (Settings, Security, Agent Control), Activity task and maintenance items with status-coloured progress, notifications with unread and error edges, security lists and tables, Anx Workspace panels, and the accent swatches (now spanning the row: their names were cut to "Pur…", "Gre…"; W3 checks they fit). |
| **Fix: the accent setting had stopped working** | Settings › Appearance › Accent set only the legacy `--accent`, which the redesigned pages no longer use, so choosing Green, Cyan or Gold changed almost nothing. `applyShellAccent()` now drives the AnxHost accent tokens too (accent, hover, pressed, soft, selection, border, text, gradient, focus ring, glow) and picks dark or white text on the accent by luminance (Gold: a primary button at 12.4:1). Purple, the default, keeps the token values. |
| Copy | 14 sentences in which "AnxOS" is the app acting now say AnxHost (Sharing, Network, My Servers, Activity, Agent Control, Computers, Settings, help), with their two `app.js` copies, and `add-computer-flow-smoke` follows the "Connect this computer to AnxHost" panel name. Kept: product and identifier names (AnxOS Relay, AnxOS Account and its sign-in, the phone web app, the `.deb` package names, "AnxOS-managed" firewall rules, "AnxOS-owned" caches, "Install AnxOS there" for the installer a user downloads elsewhere), which follow the installer (216-D) and brand and domain (216-B) decisions. |
| Tests | New `scripts/anxhost-account-ui-qa.js` (W1–W10, 38 checks) in `package.json` and the release tier. |

### Capabilities

All 389 A9 rows are ticked: the 181 already covered by existing suites and
smokes (all passing, below) and the 208 without a test through
`anxhost-account-ui-qa`: by behaviour (Activity tabs, notification and task
filters, refreshes; every Settings category; a setting saved across a reload
and reset by its category; the accent swatches; help topics; every Security
section, alias sections included; audit event filters; Export Window's
redacted preview; the signed-in owner; Anx Workspace overview, log search and
level), and by presence for what changes the account, tokens, remote access,
emergency controls, caches or updates, or opens folders and save dialogs (W9:
all 378 checkable A9 hooks in the running app).

Inventory: **1,552 of 1,621 rows verified**. The 69 left: A10's 11 legacy
page rows (AMP and Coolpals; retirement needs approval) and 216-C's 58 phone
rows.

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `anxhost-account-ui-qa` | **PASS 38/38** |
| `phase9-ui-qa` (5), `phasex-ui-qa` (11), `mobile-ui-qa` (19), `phase8-ui-qa` (9), `playit-account-ui-qa` (5), `stabilization-ui-qa`, `simple-ui-screenshots-qa` (8), `sidebar-navigation-groups-ui-qa` (7), `anxhost-shell-ui-qa` (79) | PASS |
| Hermetic smokes covering A9 rows (37, from `agent-control-sections-smoke` to `webhook-alerts-smoke`, with the security, settings, owner-workspace, maintenance, diagnostics and permission-matrix smokes), plus `add-computer-flow-smoke` after the rename | PASS |
| Design tokens, testid convention, frozen identifiers, brand allowlist, inventory `--check` | PASS |
| `node --check`, `git diff --check` | PASS, clean |

### Screenshots

`docs/anxhost/a9-account/`: Notifications, Task details, Maintenance,
Security, Settings and Anx Workspace at 900x640, 1280x800 and 1920x1080.

## 216-A10 Consistency, light theme and validation sweep

Started from `75cb8cce` (A9) at 2026-11-25T01:11:58-07:00, same campaign
instruction, solo.

### A10 timing

| Field | Value |
| --- | --- |
| Start | 2026-11-25T01:11:58-07:00 (system clock, start of the `rc:validate` sweep) |
| Finish | 2026-11-25T11:26:44-07:00 (system clock, after the performance runs; the report was written afterwards) |
| Elapsed | 10 h 14 min 46 s, including about 25 min of `rc:validate`, about 50 min of performance rounds and the real-app suite reruns |
| Commit | `feat(anxhost): Build 216-A10 light theme and consistency` (local checkpoint; not pushed) |

### What changed

| Area | Change |
| --- | --- |
| **Light theme (owner-approved 2026-11-20: "Light theme yes, dark first, tokens only")** | Settings › Appearance › Theme offers Dark, Light and System. `resolveShellTheme` honours the setting; System follows the operating system's colour scheme, also when it changes while the app is open. The settings service accepts `light` (`settingsPreferenceService`, one enum value). Dark stays the default. |
| Legacy bridge | `src/renderer/anxhost/legacy-bridge.css` (new). Its root block points the variables the older stylesheet paints with (`--text` 182 uses, `--muted` 292, `--line` 143, the v1.9 and v2 palettes, the legacy summary tiles, the website design-system palette, status colours, scrollbars) at the AnxHost semantic tokens. The rest replaces raw colours in specific legacy rules (panels, toolbars, table headers, small controls, empty states, the computer details drawer, the server page's console frame, Create Server facts, owner badges) with the matching AnxHost patterns. No rule anywhere branches on the theme: **0 per-component light overrides**, enforced by the design-token smoke. |
| Dark by design | Terminal, console and log windows and the code editor stay dark in both themes. New tokens `--ahx-terminal-bg`, `--ahx-terminal-text`, `--ahx-terminal-muted` are defined in the dark block only, so the light block cannot change them. The Monaco editor theme keeps its fixed dark palette instead of reading theme variables (they are no longer always hex). |
| Form controls in dialogs | The AnxHost input, select and textarea styles now cover `.app-modal` dialogs as well as pages (the Add Storage fields kept the legacy dark field style). |
| **Fix: unreadable placeholders (Build 215 and A1 to A9)** | Placeholders in Settings fields, dialogs, the command palette and the owner's workspace search used Chromium's default grey (4.28:1 to 4.37:1 on dark, under AA). They use the muted text token. |
| **Fix: SSH and Console toolbars cut off their own controls at 1280 px (A8)** | The SSH terminal toolbar was 768 px wide inside a 678 px panel that hides overflow, so Copy, Clear, Fullscreen and the command line's input and Send were cut off; Console's actions never shrank, so its log search collapsed to a sliver and Copy was cut off. Both toolbars now wrap. `anxhost-tools-ui-qa` T7 now checks for controls cut off by a panel and failed on the A9 stylesheet (SSH and Console at 1280x800). |
| Dark changes (measured) | A computed-colour comparison of 14,891 elements in 69 views against A9: text `#f8f5ff` → `#f7f6fa` (not visible); muted text `#b9abc8` → `#c3c0cf`; translucent lavender labels → the muted token; about 40 legacy gradient panels, summary tiles, toolbars, table headers and small controls → the flat AnxHost surfaces the redesigned pages already use. Status pills keep their tone (descendant `span` rules skip `.status-pill`). |
| **Missed port from A4: `anxhost-servers-ui-qa` M3** | It still expected My Servers' Create Server to open a new window, which A4 replaced with Add Server in the main window, and the first-server guide it now opens covered the rest of the run (TimeoutError). The suite was not rerun after A4, so this went unseen until the A10 sweep. M3 now checks Add Server opens in place with the guide and no new window, closes the guide and goes back to My Servers. |
| Tests | New `scripts/anxhost-theme-ui-qa.js` (T1–T6): the Theme setting through the real control, saved across a reload; light and dark over 69 views (every page, Home's Customize panel, command palette, Create Server, Add Storage, computer details, four toast tones, every Settings and Security category, every visible server tab), each with 0 text under WCAG AA (form values and placeholders included) and 0 surfaces in the wrong theme; terminals dark in light; no control cut off by a panel on any page at three sizes. Registered in `package.json` and the release tier. `anxhost-design-tokens-smoke` now fails on any `[data-theme]` or `prefers-color-scheme` rule outside `tokens.css`, on a bridge entry that is not a token, and on a light override of the terminal tokens (mutation-tested). `anxhost-shell-ui-qa` S9 ported from "dark only until A10" to Dark/Light/System, System following the OS live (emulated). |

### Not done (owner decisions)

- **Legacy retirement (deletions):** the AMP and Coolpals pages, the dormant
  inline Create Instance form, the Marketplace and Create Server windows, the
  Add Storage window and its `storageWindow:*` IPC, the Expo "Pair Mobile
  Device" UI, and the Backups page's disabled search box (wire it up or
  remove it). Named targets are in the A4, A5 and A8 sections and
  `LEGACY_RETIREMENT.md`. Each needs an approval naming it.
- **The v1.9 stylesheet layer:** `<html data-ui-generation="v1.9">` is still
  set, so its 395 rules still apply wherever the AnxHost layer does not
  override them; none of them "matches nothing", so PLANS.md's mechanical
  removal does not apply yet. Removing the layer changes the screen and is a
  separate, measured step (the bridge and the theme suite make it testable).
- **Generic "AnxOS" wording:** 171 renderer strings still say "AnxOS" for the
  app (for example "Unlock AnxOS to continue.", "AnxOS can manage
  containers…"), plus messages from main-process services. Most sit next to
  names that 216-B and 216-D decide (AnxOS Agent, Local Agent, Account,
  Relay, the installed "AnxOS Control Center"). Recommended: one copy pass
  once those names are settled, instead of a pass now and another later.
- **Home AMP card:** unchanged (keep, or show only when AMP is configured).

### Capabilities

No inventory row changed (`anxhost-capability-inventory --check` PASS, 1,621
rows). **1,552 of 1,621 verified.** The 69 left: A10's 11 legacy rows (AMP
and Coolpals, retirement needs approval) and 216-C's 58 phone rows.

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `npm run rc:validate` (`RC_FAIL_FAST=0`, off-screen harness), 10:50–11:15 | **424/427 PASS**. Failures: `agent:package:smoke` and `local-agent:runtime:smoke` (the 216-0 environment exception, junctioned `node_modules`) and `inventory:agent:smoke` (Agent request timeout under the sweep's load; **PASS** run alone afterwards). |
| Release checks outside the `:smoke` set | **21/21 PASS**: `node --check` of `app.js`, `main.js`, `preload.js`; `agent-game-config-route`, `agent-game-config-compat`, `dependency-preparation`, `create-server-defaults`, `share-health`, `restore-preview`, `world-import-restore`, `server-failures`, `agent-metrics-sampler`, `home-dashboard-model`, `server-view-model`, `ssh-interactive-session`, `anxnet`, `anxnet-host`, `anxnet-dns`, `service-managed-agent-routing`, `forge-health-reader`; `git diff --check` |
| `node --check` of every changed script and service | PASS (7 files) |
| `anxhost-design-tokens-smoke` | PASS (0 theme rules outside `tokens.css`; bridge 27 token-only declarations). Mutation test: a `[data-theme="light"]` rule added to `docker.css` made it fail. |
| `anxhost-capability-inventory --check` | PASS (1,621 rows, 0 unmapped) |
| `anxhost-theme-ui-qa` (new) | PASS 3 of 4 runs (69 views, about 5,150 text checks per theme, 0 under AA, 0 surfaces in the wrong theme, 0 cut-off controls). The failing run took 376 s against about 240 s for the others and its log was overwritten by the rerun; recorded as an unexplained intermittent failure (risk below). |
| Real-app suites (35, one at a time) | PASS except as listed: `anxhost-servers-ui-qa` failed on its stale A4 M3 check (ported, now **46/46**); `anxhost-network-ui-qa` failed N2/N3 in the batch and **passed alone (15/15)**; `server-view-ui-qa` hung at 900 s in the batch and **passed alone**; `infra-inventory-ui-qa` timed out launching in the batch and **passed alone**; `second-machine-acceptance` needs `--out` and **passed with it**; `build215-ui-qa` P1/C1 are the known environment cases from 215. |
| `acceptance-fixes-ui-qa` | Fails a different timing check on each run (A2; A7; A2+A6) on A10, and **also fails A2 (page.reload timeout) on the unchanged A9 tree**: pre-existing timing flakiness, not caused by A10. |
| `anxhost-tools-ui-qa` T7 (new cut-off check) | Failed first on the A9 `tools.css` (SSH: Auto-scroll, Copy, Fullscreen, input, Send; Console: Copy), **37/37 PASS** on A10. |

### Performance

Same-day, 5 alternating rounds (Build 215 `13825d70`, A9 `75cb8cce`, A10),
compared by median; off-screen, isolated profile, real Agent fixture.
Startup with `probe_startup` (one launch per round); page switching with
`probe_switch` at 900x640 (each page's synchronous `showPage()` plus the
style and layout it forces, 5 passes per round).

| Measure | Build 215 | A9 | A10 | A10 vs 215 (budget +10%) | A10 vs A9 |
| --- | --- | --- | --- | --- | --- |
| Renderer ready | 2163 ms | 1902 ms | 1960 ms | **−9.4%** | +3.0% |
| Sidebar ready | 3230 ms | 2744 ms | 3045 ms | **−5.7%** | +11.0% |
| Page switch, median page | 14.0 ms | 11.5 ms | 12.4 ms | **−11.4%** | +7.8% |
| Page switch, slowest page (Add Server) | 58.9 ms | 59.8 ms | 64.1 ms | **+8.8%** | +7.2% |

**Budgets met** (every measure within Build 215 +10%). The A10 cost over A9
is the legacy bridge stylesheet (more rules to match on every page); it is
recorded, not hidden, and the slowest page is the one to watch if a later
wave adds CSS.

### Screenshots

`docs/anxhost/a10-theme/`: Home, Backups, Security, SSH and Computers in
light and dark at 1280x800.

### A10 remaining risks

- `anxhost-theme-ui-qa` failed once in four runs (376 s against about 240 s,
  log overwritten by the rerun). Not explained; rerun it alone before the
  release tier if it fails again.
- `acceptance-fixes-ui-qa` has pre-existing timing flakiness (also on A9).

- The theme suite covers 69 views. Not covered: the Assistant panel (needs AI
  help configured; its styling is in `shell.css` on tokens), the operation
  tray (only while an operation runs), dialogs built at run time other than
  those listed, and Docker container details (needs a container). These all
  use AnxHost tokens or the bridged variables, but their light rendering was
  not measured.
- Before the settings load, the startup screen and the window background are
  dark, so a Light user sees a dark frame for a moment at launch.

## 216-E Secure Session Persistence

Security review: `docs/anxhost/SECURITY_REVIEW_216E.md`, approved by the
owner on 2026-11-25 ("i approved anything", after the review was prepared),
with the recommended answers D1–D6 (30-day absolute lifetime, 15-minute idle
lock, idle lock needs the password even on a trusted device, fallback-key
sessions deleted, "Trust this device").

### What changed

| Area | Change |
| --- | --- |
| Remembering (policy 1, 2) | A Local Owner session is remembered only when Windows secure storage (`safeStorage`) is available and "Remember me on this device" is on. The fallback key is never used for it; a remembered session written with it by an older build is refused and deleted (audited `security.session.refused`). The lock screen's option reads "Trust this device (stay signed in for 30 days)" and is disabled, with the reason, when it cannot be used. |
| Rotation (policy 4) | Every restore writes a new token (state first, then `session.dat`, both atomic) and fails closed if either write fails. Rotated tokens are SHA-256 hashed (48 random bytes; bcrypt cost about 0.3 s per launch for nothing); Build 215 bcrypt hashes are accepted once and replaced. |
| Device binding (policy 5) | Restore requires the session's device ID to match and the device not to be removed. Removing a device revokes its remembered sessions. |
| Idle lock (policy 6) | New `src/services/idleLockMonitor.js` (main process): every 30 s, idle time is the shortest of system idle time, time since unlock and time since the last input to an app window; past the limit the session locks. Windows locking or suspending also locks when idle lock is on. Options 5, 15 (default), 30, 60 minutes or Never, in Security › Automatic Session Expiration. |
| Inactivity expiry (policy 7) | The existing "Expire inactive sessions after" setting is now enforced at restore. |
| Manual lock (policy 8) | "Lock Owner Workspace" ends the main-process session (it only hid the workspace before). A lock never restores from the remembered session in the same run; the next launch does (D4). The renderer shows the lock screen at once through the new `security:locked` event. |
| Fix | Revoking your own current session reported "Sign in to continue." after succeeding; it now returns `{ ok, signedOut }`. |
| Unchanged | Account sign-in never unlocks Local Owner credentials; all 61 `requireLocalOwnerAuthenticated(` sites unchanged; password change still invalidates remembered sessions; schema versions unchanged. |

### Tests

- New `scripts/secure-session-persistence-smoke.js` (P1–P15, real
  `securityService`, fake `safeStorage`, restarts simulated by reloading
  `src/`): restore after restart and after an upgrade from Build 215-format
  stores; token changes on every restore and the old one is refused; failed
  rotation fails closed; logout, manual lock, revoke, expiry, idle timeout,
  inactivity expiry, device ID mismatch, removed device, opt-out and missing
  secure storage all require the password. **11 of 15 failed on the A10
  code**; 15/15 now.
- New `scripts/secure-session-ui-qa.js` (E1–E5, real app, real DPAPI,
  restart on the same profile): settings shown, lock screen within about
  130–300 ms of a main-process lock, restore without a prompt after a
  restart, password after logout and restart, no renderer errors. Added to
  the release tier.
- Ported (requirement changed by the approved policy, listed here):
  - `security-backup-smoke` expected "Stay signed in" to persist in plain
    Node, which has no secure storage; it now installs
    `scripts/test-helpers/fake-safe-storage.js` first. Its assertions are
    unchanged.
  - `permission-matrix-smoke`: the Owner's allowed `security:lockOwnerWorkspace`
    probe now ends the session, so the matrix asserts that it did and signs
    the actor in again (`endsSession`).
- Test setup: `test-helpers/qa-owner.js` turns idle lock off for its
  disposable owner, so an unattended run is not locked by the PC's own
  screen lock; `anxhost-real-app.js` gained `relaunch()` (same profile).

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `secure-session-persistence-smoke` | **15/15 PASS** (11 of 15 failed on the A10 code) |
| `secure-session-ui-qa` | **5/5 PASS** in 4 of 5 runs (17–40 s). The first run stalled after E3 until a 600 s timeout and never reported E4/E5; not explained (risk below). |
| Every smoke that loads `securityService`, `securityIpc`, `preload.js`, `app.js` or `index.html`, plus the auth smokes named in PLANS.md (217) | **216/217 PASS**. `agent-connectivity-fixes-smoke` check 6 failed once with a Node/libuv crash in a child (`UV_HANDLE_CLOSING`, `src\winsync.c`) and passed on 3 reruns; it does not touch session code. |
| Real-app suites affected (15, one at a time): shell, account (Security and Settings), theme (69 views, new fields included), home, servers, add-server, computers, docker, tools, instances-refresh-preservation, server-view, phasex, phase9, stabilization | **14/15 PASS**. `anxhost-network-ui-qa` failed N2/N3 here and alone, and **fails the same way on the committed A10 tree** (no 216-E; one A10 run also timed out at sign-in), so 216-E did not cause it; it passed alone earlier the same day (risk below). |
| `node --check` of every changed file, `git diff --check` | PASS |

### Capabilities

Three new rows (`CAP-SEC-IN-security-idle-lock`,
`CAP-SEC-IN-security-session-toggle-trustdevice`,
`CAP-SEC-IPC-security-onlocked`), verified by `secure-session-ui-qa` E1 and
E2. **1,555 of 1,624 verified**; the 69 left are A10's 11 legacy rows (AMP and
Coolpals, retirement needs approval) and 216-C's 58 phone rows.
`anxhost-capability-inventory --check` PASS.

### 216-E remaining risks

- `secure-session-ui-qa` stalled once in five runs; rerun it alone if it
  hangs in the release tier.
- `anxhost-network-ui-qa` N2/N3 now fail on both A10 and 216-E on this PC
  (the route refusal and diagnostics stages never arrive). Investigate the
  Agent fixture's response time before the release tier.
- A lock does not survive quitting: after a manual or idle lock, the next
  launch restores the remembered session (approved D4 behaviour).
- Same-user malware can read DPAPI data (review T7, out of scope).

## 216-D Custom Installer (polished NSIS)

Design: `docs/anxhost/d-installer/INSTALLER_DESIGN.md` and the page mockups,
approved by the owner on 2026-11-25.

### What changed

| Area | Change |
| --- | --- |
| Art | `windows/installer-art/sidebar.bmp` (164x314) and `header.bmp` (150x57), 24-bit, regenerated from the approved brand SVGs (Option A mark and wordmark on the sidebar, the small mark in the header) by `node scripts/anxhost-installer-mockups.js --write-art`. |
| Pages | Welcome shows "Welcome to AnxHost Control Center" for a new install and "Update AnxHost Control Center" for an update or repair (new `$anxWelcomeTitle`); Set up, Finish and Uninstall use the new names. Same pages, controls and logic as Build 215. |
| Names | Branding text, shortcut and uninstall display name: "AnxHost Control Center". The background service is shown as "AnxHost Helper" in the installer and the app (Restore notification, toasts, Agent Control errors). On update, electron-builder renames the old shortcuts (its `WinShell` plugin is among the DLLs `sign-nsis-toolsets` signs). |
| Unchanged (frozen) | `appId`, executable and install folder name, the `AnxOSAgent` task and `install-agent-task.ps1`, `/NOHELPER`, `--updated`, every NSIS plugin used, the publisher pin, Azure Trusted Signing, `artifactName` (still matches the updater's `/setup.*\.exe$/i`). |
| Left out of the mockup | The "Installed: Build 215 → New: Build 216" chip on the update page: reading the installed build would need new NSIS code against electron-builder's registry layout, for little gain. |

### Tests

- Ported: `agent-control-foreign-task-stop-smoke` S5 follows the
  "Restore AnxHost Helper" label (the behaviour it checks is unchanged).
- PASS: `upgrade-migration-hardening`, `agent-control-foreign-task-stop`,
  `frozen-identifiers`, `anxhost-brand-allowlist`, `windows-elevation-tray`,
  `local-agent-installer`, `installer-signature`, `build-signing`,
  `windows-signing-coverage`.

### Not verified (environment and gates)

- **Not compiled on this PC.** `node scripts/run-electron-builder.js --win
  nsis --x64 --no-increment-build` (in a scratch copy) stops at Agent runtime
  staging: `js-yaml` resolves outside the repository's `node_modules`, because
  this worktree's `node_modules` is a junction (the same 216-0 environment
  limitation as `agent:package:smoke`). The script changes are strings and
  one new variable (`$anxWelcomeTitle`, declared and used only in the
  installer build), so a compile failure is unlikely, but the first real
  compile is the signed CI build.
- The PLANS.md finish lines that need the signed build (Windows Sandbox with
  Smart App Control: fresh install, in-place upgrade from Build 215, repair,
  uninstall; 100% signed binaries and plugins; Helper task kept) belong to
  216-G and need the push approval for the CI workflow.
- Real installer screenshots for the owner can only come from that build;
  the approved design is the mockup set.

### 216-D remaining risks

- A user who pinned the old "AnxOS Control Center" shortcut to the taskbar
  keeps a pin that still works (it points at the same executable) but shows
  the old name until re-pinned; the desktop and Start menu shortcuts are
  renamed by electron-builder on the update.
- The uninstall entry in Windows Settings changes its display name; its
  registry key (from `appId`) is unchanged, so the update is still in place.

## 216-C Phone Access Rebirth

### What changed

| Area | Change |
| --- | --- |
| Shared design language | The gateway serves the desktop's own `src/renderer/anxhost/tokens.css` as `/tokens.css` (one file, no copy). The phone's `app.css` maps its local names onto the AnxHost tokens and has **no raw colours** left; status pills, banners, buttons, toasts and the skeleton use the status and surface tokens. |
| Light theme | The phone follows its own colour scheme: `app.js` sets `<html data-theme>` from `prefers-color-scheme` and follows changes live, so light and dark come from `tokens.css`, like the desktop. The console stays dark in both, on two new dark-only tokens, `--ahx-terminal-danger` and `--ahx-terminal-accent` (stderr and typed commands; the token smoke keeps them out of the light block). |
| Fonts (measured) | The phone keeps the system font stack instead of `--ahx-font-sans`. With the token stack, `mobile-ui-qa` failed 5 of 7 runs (server start and the landscape settings form timed out); with only the font lines restored, 3 of 3 passed. Bisected file by file (stylesheet reverted: 3/3 past those checks; fonts restored: 3/3 full pass). The mechanism (font matching or layout cost in the phone browser) was not proven. |
| Brand | Title, home-screen name and manifest say AnxHost; the home-screen icon, favicon and pairing screens use the AnxHost Option B touch icons (`src/mobile/icons/`, from `docs/anxhost/brand/png/touch`); the tab bar's text glyphs are SVG line icons. Every visible "AnxOS" in the phone app says AnxHost (22 occurrences in `app.js`, plus `index.html`, the manifest and the service worker's comments); the frozen `X-AnxOS-CSRF` header, cookie, CA files and subject are unchanged. |
| Service worker | Cache `anxos-shell-v2` → `anxos-shell-v3` (frozen-identifier plan), with `/tokens.css` in the shell, so phones replace the old shell on their next visit. |

### Tests

- `mobile-ui-qa` **M20** (new): light and dark, each at 360, 390 and 430 px
  and in landscape, on all 5 sections and all 6 server tabs (88 views):
  0 sideways scrolling, 0 controls cut off by a box that hides overflow,
  0 text under 4.5:1 against what is painted behind it (1,720 checks), the
  console dark in light. The run also records every phone API route it
  calls (`phone-api-routes.json`, 23 routes) for the inventory.
- New `mobile-upgrade-from-215-smoke` (U1–U4): a pairing written by Build
  215's own `sessions.js` (fixture `scripts/fixtures/mobile-devices-build215.json`,
  generated from `13825d70`, test values only) is still listed, its token
  authenticates, its CSRF value passes and the stored record keeps its shape.
- Ported: `mobile-ui-qa` M13 and M16 follow the AnxHost name (banner text,
  manifest name).

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `mobile-ui-qa` (with M20) on the final tree | **PASS** (184 s): M20 88 views, 1,797 text checks, 0 under 4.5:1, 0 cut off; 23 API routes recorded |
| Bisect of the earlier failures | Current tree with the token fonts: 2 of 7 passed. A10 tree: 3/3. 216-E + 216-D tree (`c4fc8ce5`): 3/3. Phone stylesheet reverted: 3/3 past the failing checks. Token fonts replaced by the system stack: 3/3 full passes. |
| `responsive-mobile-ui-qa`, `anxhost-theme-ui-qa` (tokens gained two terminal tokens) | PASS |
| `mobile-gateway-smoke`, `mobile-pairing-smoke`, `mobile-claim-page-smoke`, `mobile-upgrade-from-215-smoke` (4/4) | PASS |
| Design tokens (165 tokens; terminal tokens dark-only), frozen identifiers, brand allowlist, inventory `--check` | PASS |
| `node --check` of every changed script, `git diff --check` | PASS |

### Capabilities

39 phone rows ticked from evidence: the 20 API routes in the run's
`phone-api-routes.json`, the 8 screens the run asserts (Pairing, Unpaired,
Home, Servers, Computers list, Sharing, More, Server) and the 11 section and
server tabs M3/M20 visit. **1,594 of 1,624 verified.** Not ticked, because
no real-app run calls them yet (216-F must cover them): add-on updates,
enable, import, remove, rollback, update and update-all; backup verify,
restore and download; file save, delete, rename and new folder; restart;
`GET /computers/:nodeId` and its Computer screen; the loading skeleton and
message states. A10's 11 legacy rows (AMP, Coolpals) are unchanged.

### Screenshots

`docs/anxhost/c-phone/`: Home and a server page in light and dark, the
console and Computers, from the final `mobile-ui-qa` run (412 px Pixel).

### 216-C remaining risks

- The font finding is measured, not explained. The desktop still uses
  `--ahx-font-sans`; the A1 performance budgets were met with it.
- The light theme on a real phone (Safari's handling of `color-mix()`, older
  Android WebViews without it: tinted pills fall back to no tint) was only
  tested in Edge's phone emulation.
- 30 inventory rows remain unverified (above).

## 216-B Website and Branding

Nothing was deployed. The website changes reach users only through a
separately approved Pages deploy.

### What changed

| Part | Change |
| --- | --- |
| B2 name | Every visible "AnxOS" on the 32 website pages, `site.js` and the web manifest says AnxHost (429 replacements, standalone word only, so file, repository, asset, cookie and path names are untouched). The release-note cards and release titles keep the name each release was published under. The home page says "AnxHost Control Center (formerly AnxOS Control Center)"; the generated JSON-LD carries `alternateName: "AnxOS Control Center"`. |
| B2 sources | The names come from their generators, so a release sync keeps them: `release-docs.js` (`PRODUCT_NAME`, its README and JSON-LD templates), `sync-website-release.js` (`brandName`, `logoPath`) and `website/config.js`. `release-docs.js --check` and `release-consistency-check` pass. |
| B2 brand assets | New `scripts/anxhost-website-assets.js` writes the favicons (SVG, 16, 32, `.ico` with 16/32/48), touch and manifest icons (Option B), a 64 px header mark (small icon) and a 1200x630 social preview (Option A lockup, "formerly AnxOS Control Center"). The header on every page uses `/assets/anxhost-logo.png`. |
| B4 READMEs | `README.md` and `docs/releases-repository/README.md` say AnxHost with a "Formerly AnxOS Control Center" line and the AnxHost logo; their generated release sections follow the generator. No repository was renamed or moved. |
| Desktop | The two remaining "AnxOS website" sign-in messages say AnxHost (`app.js`, `accountAuthService.js`); the brand allowlist's last entry was removed, so the shell check is stricter. |
| B3 | `docs/anxhost/DOMAIN_MIGRATION_PLAN.md`: where the domain is used (verified), selection criteria, six additive steps that keep `anxoscontrolcenter.org` serving sign-in, `config.js` and downloads forever, tests and rollback. **Needs owner approval; every step is a production step.** |
| Naming decision taken | User-facing component names follow the product: AnxHost Account, AnxHost Agent, AnxHost Local Agent, AnxHost Relay (and the AnxHost Helper from 216-D). Package and file names (`AnxOS-Agent-*.deb`, `AnxOS-Control-Center-*`) are unchanged. The owner can reverse this with one rename pass. |

### Tests ported (requirement changed: the visible name)

`website-accessibility-smoke` (1 phrase), `website-download-smoke` (3),
`website-setup-smoke` (2), `website-production-smoke` (logo path, manifest
name and 9 page phrases). Every port only swaps AnxOS for AnxHost in an
expected visible phrase; no assertion was removed or loosened.

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `npm run qa:website` (12 checks: syntax, `release-docs --check`, release consistency check and smoke, production, download, accessibility, setup, download-functions and release-promotion smokes, `git diff --check`) | **PASS** |
| `website-search-indexing-smoke` after `website-sitemap.js` (pages changed, so their dates moved) | PASS |
| `verify-website-config-vs-stable`, `anxhost-brand-allowlist`, `frozen-identifiers`, `marketplace`, `account-system`, `account-browser-auth` smokes | PASS |

### Not done (216-B)

- **Product screenshots.** The nine `website/assets/product/*` images (and
  the README hero) still show the Build 215 interface and the AnxOS name. A
  capture from the QA harness shows offline computers and a "QA MODE" badge,
  which is worse than the old images, so they were left. They need a
  populated, connected install, best from the signed 216 RC.
- **Layout redesign.** The pages keep their current structure and the
  existing purple design system; only names, logo and icons changed.
- `scripts/generate-linux-icons.js` still writes the old
  `website/assets/anxos-logo.png`, which no page uses now. Removing the file
  (and the old `src/assets/anxos-logo.png`) is a deletion and needs approval.
- The README "current release" line now reads "AnxHost Control Center v2.0
  Build 215" although 215 shipped as AnxOS; it is right from the 216 release.

## Legacy retirement (A10 deletions)

Owner approval, 2026-11-25: "Approve all deletions", in answer to a list
naming each target. Scope followed `docs/anxhost/LEGACY_RETIREMENT.md`: only
the UI and the window code went. **Kept on purpose:** the AMP backend (IPC,
services, Agent route) and the Home AMP card; the Expo pairing IPC,
`mobilePairingService`, the Agent claim page and their smokes (their removal
is a later, separately approved step); the `amp`, `coolpals` and `minecraft`
page-name redirects and default-page values, so saved settings still load;
page-specific CSS for the retired pages ("old CSS" was not a named target).

### Removed

| Target | What went |
| --- | --- |
| AMP page | `index.html` section (61 lines); its page-only field writes in `renderAmpSnapshot`/`refreshAmpDashboard`; the dead `setMinecraftPage*` writers (their fields never existed) and 9 helpers only they used. `updateAmpPanelLink` and its URL gate stay: two security smokes cover them and the function already returns when the link is absent. |
| Coolpals page | `index.html` section (147 lines, static, all buttons disabled). |
| Dormant inline Create Instance form | The form (40 lines), its 8 element constants, `INSTANCE_SERVER_PRESETS`, 8 functions (form values, presets, payload, visibility, submit) and 3 parsers left without callers. The shared memory validator keeps its other two fields. |
| Marketplace and Create Server windows | `main.js`: `openWorkspaceWindow`, the shared child-bounds helper and the `window:openWorkspace`, `window:focusMain`, `window:getWorkspaceContext` handlers; `preload.js`: `openWorkspace`, `focusMain`, `getWorkspaceContext`, `onWorkspaceInit`, `onNavigate`; `app.js`: every `workspaceSurface` branch, the workspace init and navigation code, the hand-off write; `index.html`: the Back/Dashboard buttons; `styles.css`: 24 window-only rules (a parser removed only selectors naming the windows; none were mixed with main-window selectors); `add-server.css`: the rule hiding those buttons. |
| Add Storage window | `windows/add-storage.{html,js,css}`, `src/ipc/storageWindowIpc.js`, `openAddStorageWindow`/`closeAddStorageWindow` and their registration in `main.js`, `storageWindow` in `preload.js`, the window fallback in `openStorageModal`. |
| Expo "Pair Mobile Device" UI | Agent Control's Pair Mobile Device and Copy Mobile Claim buttons, the claim/QR panel and every renderer handler, label, confirmation and state for them. |
| Backups search box | The disabled, unwired search field. |
| `anxos-logo.png` (two copies) | `src/assets/` and `website/assets/`, unused since 216-B; `generate-linux-icons.js` no longer writes them **or any website asset** (it would have overwritten the 216-B icons and social preview), and `anxhost-website-assets.js` now keeps the social preview's `?v=` hash current. |

### Inventory

51 rows retired, all from the targets above, none elsewhere (old and new
inventories diffed): listed with their replacements in
`docs/anxhost/RETIRED_CAPABILITIES.md`. **1,554 of 1,573 verified** at that point; the 19
left were phone API routes and screens, verified in 216-F.

### Tests (retired or ported, each because its subject was removed)

- **Retired:** `scripts/storage-window-ipc-authorization-smoke.js` (and its
  `package.json` script): it tested only the removed `storageWindow:*` IPC.
- **Permission matrix:** the `storage-window-*` families and the three
  workspace channels left `test-helpers/permission-matrix.js`; the matrix
  fails on rows for unregistered channels, so this was required.
- **`ipc-boundary-hardening-smoke`:** navigation and window-open guards
  checked on the windows that remain (main, diagnostic), plus new checks that
  exactly those two windows exist and the retired page and factories are gone.
- **`marketplace-smoke`, `ui-polish-smoke`:** Add Storage checks moved to the
  in-window dialog (same IPC, saved hand-off, body-before-footer layout);
  workspace-window checks became "stay removed" checks; Create Server layout
  checks read `add-server.css` (same values). The first-server hand-off checks
  follow the main-window path; the "AnxHost will check this system…" message
  they asserted lived only in the window branch, which the main window never
  ran. Retired with the window: the first-server dialog's stacked header "at
  dedicated-window widths" and the window's own CSS polish and size.
- **`instances-node-routing-smoke`:** the inline form was the renderer's only
  direct `instances.create` call; it now asserts none remains (the
  context-stamping allowlist entry stays for any future call).
- **UI suites:** `anxhost-servers-ui-qa` M3 (form gone), `anxhost-computers-ui-qa`
  C7 (17 kept actions, was 19), `anxhost-tools-ui-qa` T6 (search box gone),
  `ui-polish-smoke` page list (no `amp`/`coolpals`, plus a stay-removed check).

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| Every smoke that reads `app.js`, `index.html`, `preload.js`, `main.js`, `styles.css`, the AnxHost styles, the website or the icon generator (231) | **PASS** after porting `build193-productivity`, `hytale-server`, `node-switch` and `onboarding` (each asserted removed code) |
| `ipc-boundary-hardening`, `permission-matrix`, `marketplace`, `ui-polish`, `instances-node-routing` (ported) | PASS |
| Real-app suites (16): shell, servers, add-server, computers, tools, home, theme, sidebar navigation, build214, stabilization, phase8, simple screenshots, files layout, qa-acceptance | **PASS** (shell S3/S12 and tools T2 ported; tools T3 failed once and passed on the rerun) |
| `build215-ui-qa` P1/C1, `acceptance-fixes-ui-qa` A2 | Known: environment cases since Build 215, and A2's timing failure also seen on the A9 tree |
| `anxhost-capability-inventory --check` (1,573 rows), `release-docs --check`, sitemap regenerated (two pages' preview hash changed) | PASS |
| `node --check` of every changed JS file, `git diff --check` | PASS |

One run of the shell suite hung because the app's window never appeared
within 30 s, and the run then stuck in cleanup; it was stopped (its four
processes ended by PID after checking their command lines). The rerun on
the same code passed, so this is recorded as a one-off launch hang.

## 216-F Integration and Migration

Owner instruction, 2026-11-25: "Finish 216-F first" (before any version bump
or release candidate). Nothing in this phase changes a backend, IPC, Agent,
Docker or AnxNet behaviour except the two phone defects below, which were
found by the new end-to-end checks and shipped in Build 215.

### Finish-line evidence

| Requirement | Evidence | Result |
| --- | --- | --- |
| Build 215 profile upgrades with nothing lost | `scripts/upgrade-from-215-ui-qa.js --base=<Build 215 checkout>`: the real Build 215 app writes an owner with "Stay signed in", a preference, an Agent computer (token in the credential store), an SSH profile, a backup, a Marketplace favorite and a phone paired over HTTPS; Build 216 then opens the same profile | **8/8 PASS**: session restored without a password (216-E), preference unchanged, computer listed and its stored token authenticates, SSH profile, the 215 backup, favorite, the paired phone listed and its cookie still works, 0 renderer errors |
| Mixed fleet: 216 desktop, 215 Agent | `scripts/mixed-version-215-agent-ui-qa.js --base=<Build 215 checkout>`: the published Build 215 Agent source runs under the service-managed fixture (new `agentRoot` option) | **5/5 PASS**: online and reports build 215; start, console command (echoed) and stop; file write, list, read back; backup create, list and check (`verification.state` "verified"); 0 renderer errors |
| Every mapped capability verified | `anxhost-capability-inventory --check` | **1,573 of 1,573 ticked**: the last 19 rows (16 phone API routes, the Computer, message and skeleton screens) are covered by `mobile-ui-qa` M21, whose run recorded 40 phone API routes |
| Backups and restore, AnxNet and sharing, Docker update with rollback, Phone Access end to end | Feature tier: `restore-drill`, `backup-verification`, `backup-file-fixes`, `backup-before-update`; `anxnet-*` (6), `sharing-fixes`, `share-health`, `playit-*` (3); `docker-service-update` (image rollback step), `agent-docker-actions`; `mobile-gateway` (27). Real app: `mobile-ui-qa` (25), and the A6–A8 suites already run on this tree | See "Validation performed" |

The Build 215 checkout used was the `anxnet-orbit-relay-f3a366` worktree
(`release.json` build 215); both tests refuse any other build and only read
it (`git status` clean afterwards).

### Defects found and fixed (both shipped in Build 215)

1. **The phone never listed installed add-ons** (since Phase 7, `6dec0139`).
   The server page's loader fetched the installed list when the tab was
   `"addons"`, but the Add-ons tab is `"mods"` in `ServerView.MAIN_TABS`, so
   the tab always said "No plugins installed". Fixed in
   `src/mobile/web/app.js`; `scripts/mobile-tab-loader-smoke.js` checks every
   tab name the loader tests against the shared tab list (fails on the old
   code: "not tabs: addons").
2. **Every phone backup check said "Check finished: done."** The gateway read
   the outcome from the top level of the Agent's reply, but the Agent returns
   it on `record.verification` (`persistVerificationOutcome`), so a failed or
   corrupt backup was never reported as such on the phone. Fixed in
   `src/mobile/api.js`. The gateway smoke's fake returned the shape the code
   expected; it now returns the Agent's real shape, and G27 checks a verified
   and a failed result with its detail (fails on the old code: state "").
   M21 now requires "Check finished: verified".

### Tests added

- `scripts/upgrade-from-215-ui-qa.js` (U1–U8), `scripts/mixed-version-215-agent-ui-qa.js` (K1–K5): need a Build 215 checkout with its `node_modules`; not in a tier because of that dependency (`npm run upgrade-from-215:ui-qa -- --base=…`).
- `mobile-ui-qa` M21: add-ons (publish an update, Check for updates, Update all, Roll back, Update, turn a dependency off and on, import, Remove), files (New folder, Rename, Delete, edit), backups (Check, download as gzip, restore with RESTORE), Restart, the Computer screen, an error message and the loading skeleton.
- `scripts/mobile-tab-loader-smoke.js`; `mobile-gateway-smoke` G27.

### Phone suite reliability

11 runs of `mobile-ui-qa` during 216-F: 4 failed on defect 1 (no "Homes"
row), 1 on defect 2's toast, 3 on early timeouts (two at launch, one Agent
start request timed out), 3 passed; the last two (after both fixes) passed.
The early timeouts match the 216-C finding (2/7 passing) and are not
explained; the Agent fixture alone answers in 50–180 ms.

### Validation performed (development PC, 2026-11-25)

| Check | Result |
| --- | --- |
| `upgrade-from-215-ui-qa` (real Build 215 app, then 216) | **PASS 8/8** |
| `mixed-version-215-agent-ui-qa` (216 desktop, Build 215 Agent) | **PASS 5/5** (K4 tightened to the exact `verification.state`; rerun passed) |
| `mobile-ui-qa` (off-screen harness), with M21 and the verified-result assertion | **PASS, 25 checks** in 346 s; 40 phone API routes called |
| `mobile-gateway-smoke` | **PASS, 27 checks** (G27 failed first on the old `api.js`) |
| `mobile-tab-loader-smoke` (added to the feature and release tiers) | PASS (failed first on the old loader) |
| `mobile-upgrade-from-215-smoke` | PASS 4/4 |
| `npm run qa:feature` (off-screen harness), full tier | **PASS, 147 checks** in 741 s (run before the tab-loader smoke was added) |
| `release-validation --tier=fast` | PASS, 5 checks |
| `anxhost-capability-inventory --check` | PASS, 1,573 rows, all ticked |
| `node --check` of every changed JS file (9), `git diff --check` | PASS |

### 216-F remaining risks

- The upgrade test covers the data the 215 app writes through its own
  bridge on a temporary profile, not an installed 215 upgraded by the 216
  installer; that is the Phase 4–6 RC upgrade.
- The add-on import was driven through the phone API, not a file picker
  (the phone has no import button; the row says so).
- Phone suite early timeouts remain unexplained (see above).
- Not done: 216-G (version bump, signed RC) waits for approval.
