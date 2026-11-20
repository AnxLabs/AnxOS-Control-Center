# 216-A1 Desktop Shell Rebirth: proposed finish line

**Status: finish line and its three open decisions approved by the owner
(2026-11-20). Implementation has not started.** A1 starts only when the
owner launches its `/goal` separately.

Sources: `PLANS.md` section 3 (216-A, wave A1, per-wave finish lines),
`docs/anxhost/CAPABILITY_INVENTORY.md` (wave A1), the approved
`NAVIGATION_PROPOSAL.md`, `UI_PATTERNS.md` and `brand/LOGO_STANDARD.md`, and
the Build 215 baseline (`baseline/BASELINE_215.md`). Base commit: `567dda58`
on `claude/anxhost-build-216`.

## Scope

The application shell, and the global surfaces that every page sits inside:

| Area | Inventory destination | Rows |
| --- | --- | --- |
| Custom title bar (brand, search, computer status, window controls) | Shell › Title bar | 29 |
| Sidebar with the approved information architecture and icon rail | Shell › Sidebar (new information architecture) | 25 |
| Page host, main window and shell regions | Shell; Shell › Main window | 6 |
| Computer switcher (sidebar footer) | Shell › Computer switcher | 1 |
| Global search (Ctrl+K) | Shell › Global search | 4 |
| Command palette (Ctrl+Shift+P) | Shell › Command palette | 4 |
| Keyboard shortcuts | Shell › Keyboard shortcuts | 10 |
| Assistant panel | Shell › Assistant panel | 14 |
| Contextual help | Shell › Contextual help | 4 |
| Security (sign-in) gate: restyle only; session persistence is 216-E | Shell › Sign-in gate | 20 |
| Local setup gate | Shell › Local setup gate | 6 |
| Onboarding welcome and wizard | Shell › Onboarding | 8 |
| Update dialog, update-ready banner, developer update dialog | Shell › Update dialog / banner / Developer update dialog | 26 |
| Shared dialog pattern (confirmations), toasts | Shell › Shared dialog pattern | 1 |
| Startup diagnostic window (kept, minimal restyle) | Keep (minimal restyle) | 1 |
| **Total** | | **159** |

Also in A1, per PLANS.md:

- The **status system** (eight states) and the **operation tray** as shell
  components, available to later waves.
- The **startup splash** with the Option A lockup (dark variant).
- The **theme mechanism**, dark only (the light theme ships in A10).
- The **in-app rename (216-B1)**: user-visible strings only, through an
  allowlist, never a search-and-replace of "AnxOS" (`FROZEN_IDENTIFIERS.md`).

Not in A1: page content (Home is A2, My Servers A3, and so on; existing pages
render inside the new shell unchanged), session persistence (216-E), the
installer and the exe icon (216-D), the phone (216-C), the website (216-B),
any backend, IPC, preload or Agent change.

## Finish lines

### Capabilities

1. **159/159** A1 inventory rows checked working and ticked in
   `CAPABILITY_INVENTORY.md`. The 16 A1 IPC rows with no direct call are
   checked by behaviour: 14 the UI uses indirectly (`account.getStatus`,
   `isMaximized`, `onMaximizedChanged`, `focusMain`, `getWorkspaceContext`,
   `onNavigate` and `onWorkspaceInit` on `anxWindow` and `window`, and
   `window.openWorkspace`), and 2 with no renderer reference
   (`account.listDevices`, `account.revokeCurrentDevice`), which stay
   backend-only and gain no UI in A1.
2. **All 20 Build 215 pages** reachable from the new sidebar, footer, search
   or command palette, with an automated check that opens each one; the
   hidden legacy pages (`amp`, `coolpals`, the `minecraft` redirect) keep
   their current behaviour until A10.
3. **0** backend, IPC, preload, Agent or `src/services` changes
   (`git diff --stat` on those paths is empty). Owner-only items stay
   enforced in the main process; hiding them in the sidebar is presentation.
4. `npm run frozen-identifiers:smoke` passes: window title, tray text and
   visible strings change, but `appId`, `productName`/exe name, `%APPDATA%`
   folder, localStorage keys and every other frozen identifier do not.
5. Rename: **0** user-visible "AnxOS Control Center" strings left in the
   desktop-shell surfaces above, which read "AnxHost Control Center" or
   "AnxHost CC" (checked against the allowlist), and **0** changes to strings
   outside the allowlist. The title bar shows the simplified small mark at
   20 to 28 px; **0** production icon files changed. New `brand-allowlist`
   smoke (PLANS.md section 7).

### Design and accessibility

6. Shell CSS uses only `--ahx-*` tokens and `ahx-` patterns
   (`anxhost-design-tokens:smoke` extended to the shell files; **0** raw
   colours).
7. Navigation: Run / Infrastructure / Tools plus footer as approved; the
   **icon rail below 1100 px** window width, with labels in tooltips and the
   accessible name on every rail item.
8. **900x640**: page content visible above the fold on all 20 pages (fixes
   baseline finding 1, where the Build 215 navigation filled the window).
9. Keyboard: every shell control reachable by Tab; visible focus; Ctrl+K and
   Ctrl+Shift+P work from every page; dialogs and the Assistant panel trap
   focus and return it; Esc closes them. **10/10** existing shortcuts still
   work.
10. Contrast: WCAG AA for text and 3:1 for icons and focus rings in the dark
    theme (automated contrast check over the rendered shell).
11. Screenshots at 900x640, 1280x800 and 1920x1080 for all 20 pages inside
    the new shell, plus the gates, onboarding, search, palette, Assistant and
    update dialog: **0** clipping, overflow, overlap or unreadable text.

### Tests and performance

12. Every UI suite that drives the shell is ported to `data-testid` in the
    same change (23 UI suites reference the sidebar, title bar, gates or
    `showPage`; the heaviest are `stabilization-ui-qa`,
    `sidebar-navigation-groups-ui-qa`, `qa-acceptance`,
    `acceptance-fixes-ui-qa` and `phase8-ui-qa`). No test weakened, skipped
    or deleted, and no time limit raised, without owner approval; each
    replaced assertion listed in the handoff.
13. Cold start within the Build 215 baseline **+10%**:

    | Size | Renderer ready (budget) | Sidebar interactive (budget) |
    | --- | --- | --- |
    | 900x640 | 2347 ms (2582 ms) | 3580 ms (3938 ms) |
    | 1280x800 | 2175 ms (2393 ms) | 3534 ms (3887 ms) |
    | 1920x1080 | 1785 ms (1964 ms) | 2768 ms (3045 ms) |

    Page switch: median 32.25 ms (budget 35.5 ms), max 160.6 ms (budget
    176.7 ms), measured the same way (3 launches, same PC).
14. `node --check` on changed JS; the 216-0 smokes, `qa:fast` and
    `git diff --check` pass; `qa:feature` passes in full (A1 changes every
    page's frame, so the full feature tier is the regression gate here even
    though PLANS.md schedules it only at the end of 216-A).
15. The handoff records the A1 page-acceptance checklist
    (`PAGE_ACCEPTANCE.md`) for each shell surface, timings, commands and
    screenshots; commit only with owner approval; no push.

## Owner decisions (2026-11-20)

1. **Title bar mark: the simplified small mark at 20 to 28 px.** Option B
   stays for larger icons (48 px and up) and Option A for major branding
   surfaces (splash, About, installer, website). This replaces the "Title
   bar: Option B" row of the `LOGO_STANDARD.md` surface table; that table is
   updated in the first A1 commit.
2. **Window and tray icons: deferred to 216-D**, together with the branded
   installer and the upgrade compatibility tests. A1 does not replace any
   production icon (`assets/icon.ico`, `assets/icons/`, the window and tray
   icons set in `main.js`).
3. **Rename scope: user-visible desktop-shell branding** becomes
   "AnxHost Control Center" (full) and "AnxHost CC" (short). Frozen internal
   identifiers, package names, data paths, Agent names, update endpoints and
   executable compatibility are preserved (`FROZEN_IDENTIFIERS.md`; enforced
   by `frozen-identifiers:smoke`).

## Proposed `/goal` (for owner approval; not started)

> Build 216-A1 Desktop Shell Rebirth on `claude/anxhost-build-216`: the new
> title bar, sidebar (Run / Infrastructure / Tools, footer, icon rail below
> 1100 px), page host, status system, operation tray, toasts, global search,
> command palette, Assistant panel, startup splash, security gate, local
> setup gate, onboarding, dark theme mechanism and the in-app rename of
> user-visible shell branding to AnxHost Control Center / AnxHost CC, using
> the approved tokens, patterns and logo (simplified mark in the title bar,
> Option A on the splash). Meet every finish line in
> `docs/anxhost/A1_FINISH_LINE.md`. No backend, IPC, preload or Agent
> changes; no frozen identifier changes; no production icon replacement
> (window, tray and exe icons are 216-D). Port the affected UI tests in the
> same change. Stop for approval before any commit; no push.
