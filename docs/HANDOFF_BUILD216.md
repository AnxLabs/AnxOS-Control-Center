# Build 216 handoff: AnxHost CC rebirth

Plan: `PLANS.md` (approved, commit `9aadaead`). Protocol: `AGENTS.md` (ADP).

## Status

| Phase | State |
| --- | --- |
| **216-0 Foundation and capability inventory** | **Complete and approved by the owner (2026-11-20)**: logo (split strategy), navigation and UI foundation approved; committed on `claude/anxhost-build-216` with owner approval as `docs(anxhost): Build 216-0 foundation, inventory and proposals` (hash in the owner report; not pushed). |
| 216-A1 Desktop Shell Rebirth | Finish line proposed for owner review; **not started** (its `/goal` needs separate approval) |
| 216-A2 … 216-G | Not started |

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
- `LOGO_STANDARD.md` sets a 40 px minimum for Option B, while the approved
  title bar mark is Option B. The A1 finish line must settle the title-bar
  mark size (see the proposed A1 finish line).

## Next step

Owner reviews the proposed 216-A1 Desktop Shell Rebirth finish line
(`docs/anxhost/A1_FINISH_LINE.md`). 216-A1 starts only with the owner's
separate approval of its `/goal`. Pushing the 216-0 commit also needs
explicit approval.
