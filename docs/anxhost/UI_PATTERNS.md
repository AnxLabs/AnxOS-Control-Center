# AnxHost CC UI patterns, tokens and test identifiers (Build 216-0)

**Status: approved by the owner on 2026-11-20** (PLANS.md section 3, 216-0
finish lines): dark-first violet and charcoal identity with an optional light
theme, all eight status states, accessible contrast and keyboard navigation,
and system fonts by default. Nothing here is loaded by the production app
yet; wave A1 starts using it.

| File | Purpose |
| --- | --- |
| `src/renderer/anxhost/tokens.css` | Design tokens: primitives, semantic tokens for dark (default) and light, type, space, radius, layout, motion, layers |
| `src/renderer/anxhost/patterns.css` | Reusable components, class prefix `ahx-`, tokens only |
| `docs/anxhost/gallery/ui-patterns.html` | Static review page: the proposed shell and navigation, a My Servers page, and every pattern. Open with `?theme=light` for light |
| `docs/anxhost/gallery/ui-patterns-dark.png`, `ui-patterns-light.png` | Rendered gallery (`npm run anxhost:gallery`, headless) |
| `docs/anxhost/gallery/contrast-report.json` | WCAG contrast of 42 token pairs in both themes (all pass) |
| `scripts/anxhost-design-tokens-smoke.js` | Token integrity: defined, no light-only tokens, no raw colours in patterns, all statuses covered |

## Principles

1. **Dark first.** Near-black violet base, the logo's purple as the accent,
   off-white text. The dark theme is the identity; light is optional and is
   one block of semantic overrides in `tokens.css`. Components never branch
   on the theme.
2. **Tokens only.** New AnxHost CSS uses `var(--ahx-*)` for colour, type,
   space, radius, elevation, motion and z-index. Primitives
   (`--ahx-violet-*`, `--ahx-ink-*`, `--ahx-signal-*`) are referenced only
   inside `tokens.css`.
3. **Theme switch in one place.** The app resolves its Theme setting (Dark,
   Light, System) to `<html data-theme="dark|light">`; "System" is resolved
   in code from `prefers-color-scheme`, so the light values are not
   duplicated inside a media query.
4. **Plain JavaScript, no framework.** Patterns are CSS classes plus
   semantic HTML and ARIA; behaviour stays in the existing renderer modules.
   Security stays in the main process and Agent: hiding or disabling a
   control is presentation only.
5. **Local assets only.** System fonts (Segoe UI Variable on Windows, with
   `system-ui` fallbacks) and inline SVG icons; no remote fonts or images, so
   the CSP stays unchanged.
6. **Desktop density, progressive disclosure.** Advanced options move into
   disclosures (`ahx-disclosure`) or dialogs; they are never removed.
7. **Accessibility.** WCAG AA contrast in both themes (measured, 42/42 pass),
   visible focus ring (`--ahx-focus-ring`) on every control, full keyboard
   use, states never conveyed by colour alone, reduced motion honoured.

## Tokens (summary)

| Group | Tokens | Notes |
| --- | --- | --- |
| Brand primitives | `--ahx-violet-50` … `950` | From the logo: `600 #7818c0`, `700 #6010a0`, `800 #4a0d80`, `900 #300058` |
| Neutral primitives | `--ahx-ink-0` … `1000` | Slightly violet greys; logo ink `#1e1e26` sits between 850 and 900 |
| Signals | green, amber, orange, red, blue, slate (`-400` dark, `-700` light) | Status and feedback colours |
| Backgrounds and surfaces | `bg-app`, `bg-titlebar`, `bg-sidebar`, `bg-content`, `surface-1/2/3`, `surface-inset`, `surface-hover`, `surface-selected`, `overlay-scrim`, `art-bg` | surface-1 cards, surface-2 raised and table headers, surface-3 dialogs and trays |
| Borders | `border-subtle`, `border`, `border-strong`, `border-accent` | |
| Text | `text-primary`, `text-secondary`, `text-muted`, `text-disabled`, `text-on-accent`, `text-link` | Muted text still meets 4.5:1 on cards |
| Accent | `accent`, `accent-hover`, `accent-pressed`, `accent-soft`, `accent-text`, `accent-gradient`, `brand-ink` | |
| Feedback | `success`, `warning`, `danger`, `info` and their `-soft` backgrounds, `danger-solid` | |
| Type | `font-sans`, `font-display`, `font-mono`, `text-2xs` (11 px) … `text-4xl` (36 px), weights, leading, `tracking-caps` | |
| Space | `space-0` … `space-16` (2 to 64 px) | 4 px grid with 2, 6 and 10 px half steps |
| Radius | `radius-xs` 4 … `radius-xl` 16, `radius-pill` | |
| Layout | `titlebar-height` 40, `sidebar-width` 240, `sidebar-width-collapsed` 64, `content-max` 1440, control heights 28/34/40, icon sizes 16/20/24 | |
| Motion | `duration-instant/fast/base/slow`, `ease-standard/emphasis/exit` | All durations become 1 ms with `prefers-reduced-motion` |
| Layers | `z-sticky` 10 … `z-tooltip` 80 | Titlebar, sidebar, popover, tray, dialog, toast, tooltip |

## Status system

Every state has a **unique combination** of colour, shape and label, so it
reads without colour. One pattern on desktop and phone:
`<span class="ahx-status" data-status="…">Label</span>`.

| State | Shape | Colour token | Use for (existing app states) |
| --- | --- | --- | --- |
| `running` | filled dot | `--ahx-status-running` (green) | running, healthy |
| `starting` | pulsing ring | `--ahx-status-starting` (blue) | starting, restarting, queued start |
| `stopping` | half-filled dot | `--ahx-status-stopping` (amber) | stopping |
| `updating` | spinning arc | `--ahx-status-updating` (violet) | installing, updating, backing up, restoring, SteamCMD update |
| `degraded` | diamond | `--ahx-status-degraded` (orange) | degraded, unhealthy, needs attention, sign-in needed (e.g. Hytale auth) |
| `error` | red square | `--ahx-status-error` (red) | failed, crashed, error |
| `stopped` | small neutral square | `--ahx-status-stopped` (neutral) | stopped (computer reachable) |
| `offline` | hollow ring | `--ahx-status-offline` (slate) | computer offline, unavailable, unknown |

The label is always visible text ("Running", "Computer offline", "Sign-in
needed"), never the colour alone. The plan named six states; the owner
approved all eight (adding `error` and `stopped`, which the app already shows).

## Patterns

| Pattern | Classes | Notes |
| --- | --- | --- |
| Shell | `ahx-shell`, `ahx-titlebar`, `ahx-sidebar`, `ahx-main` | Grid: title bar across the top, sidebar and content below; `data-sidebar-collapsed="true"` gives a 64 px icon rail |
| Title bar | `ahx-titlebar__brand`, `__search`, `__status`, `ahx-window-controls` | Drag region; buttons and inputs are `no-drag`; keeps `data-window-action` hooks |
| Sidebar | `ahx-nav-group`, `__label`, `ahx-nav-item` (`aria-current="page"`), `__badge`, `ahx-sidebar__footer`, `ahx-computer-switcher` | Keeps `data-page-target` hooks |
| Page | `ahx-page`, `ahx-page-header` (`__eyebrow`, `__title`, `__description`, `__actions`), `ahx-tabs`/`ahx-tab` (`aria-selected`) | |
| Layout helpers | `ahx-grid`, `ahx-stack`, `ahx-row` | |
| Card | `ahx-card` (`--interactive`), `__header`, `__title`, `__meta`, `__footer` | Marketplace entries, computers, servers |
| Stat | `ahx-stat` (`__label`, `__value`, `__hint`), `ahx-meter` | Tabular numbers |
| Artwork | `ahx-art` (48 px tile; image or letters fallback) | Marketplace art with an offline fallback |
| Status | `ahx-status[data-status]` | See above |
| Buttons | `ahx-button` (`--primary`, `--ghost`, `--danger`, `--sm`, `--icon`) | Disabled via `disabled` or `aria-disabled="true"` with a reason in `title` |
| Forms | `ahx-field` (`__label`, `__hint`, `__error`), `ahx-input`, `ahx-select`, `ahx-textarea` (`aria-invalid`), `ahx-switch` | |
| Table | `ahx-table-wrap`, `ahx-table` (sticky header, `aria-selected` rows, `ahx-num`) | |
| Progress | `ahx-progress-tray` (fixed bottom-right, or `--inline`), `ahx-operation`, `ahx-progress` (`data-indeterminate`), `ahx-steps`/`ahx-step[data-state=pending/running/complete/failed/skipped]` | One place for every long operation; the Docker update's automatic rollback shows as steps |
| States | `ahx-state[data-kind=empty/error]`, `ahx-skeleton` | Every list has empty, loading and error |
| Feedback | `ahx-banner[data-tone]`, `ahx-toast-stack`, `ahx-toast`, `ahx-badge` | |
| Dialog | `ahx-scrim`, `ahx-dialog` (`__header`, `__title`, `__body`, `__footer`), `ahx-disclosure` | `role="dialog"`, `aria-modal`, labelled title, focus trapped (existing focus helpers) |
| Wizard | `ahx-wizard-steps` (`data-state="done"`, `aria-current="step"`) | Create Server inside the main window |
| Icons | inline SVG `<symbol>` sprite, 24 px grid, 1.75 stroke, `ahx-icon` (`--sm`) | Original line icons; no icon font |

## Test identifiers

The capability inventory and the existing tests depend on the current
`data-*` hooks (`data-page`, `data-page-target`, `data-*-action`, `data-*-tab`,
`data-*-section-target`, …). They are the **behaviour contract**.

1. **Keep existing hooks.** A redesigned page keeps every hook its inventory
   rows list. Renaming one is a deliberate change: update the code, the
   tests and the inventory in the same commit (the inventory smoke fails
   otherwise).
2. **Add `data-testid` for test-only selection** where a control has no stable
   hook (29 inventory rows today) and for new structure:
   - kebab-case `"<area>-<thing>[-<qualifier>]"`, for example
     `nav-my-servers`, `my-servers-table`, `server-row`,
     `dialog-stop-server-confirm`, `create-server-name`;
   - area prefixes follow the 216 destinations: `shell`, `nav`, `home`,
     `my-servers`, `server`, `add-server`, `create-server`, `template`,
     `computers`, `agent`, `docker`, `network`, `files`, `terminal`,
     `backups`, `activity`, `security`, `settings`, `workspace`, `dialog`,
     `operation`, `phone` (and `gallery` for the review page);
   - repeated items use one testid plus a data attribute for identity
     (`data-testid="server-row" data-instance-id="…"`), never an index;
   - stable across languages and copy changes; never contains user data,
     hostnames, tokens or secrets.
3. **Tests select by hook or testid**, then role and accessible name. Never by
   class name, layout position or visible text alone (the 215 column-index
   break in `build213-ui-qa` is the example to avoid).
4. **JavaScript never uses `data-testid`.** Behaviour keeps its `data-*`
   hooks; testids exist only for tests.

**Enforced.** The rules live in `test-helpers/testid-convention.js`
(`AREAS`, `checkTestId`, `selector` for Playwright suites) and
`npm run anxhost-testid-convention:smoke` applies them to `index.html`,
`app.js`, `src/renderer/**`, the phone PWA and the gallery: format and area,
no IP-like, e-mail or secret-like values, no bare trailing index, repeated
testids only with a `data-*-id` identity attribute, and no application code
selecting by testid. Today it passes on 28 testids (27 in the gallery, plus
the pre-216 `qa-mode-indicator` in `app.js`, which is kept unchanged as a
listed legacy testid because `qa-acceptance` and
`capture-product-screenshots` use it). A deliberately invalid testid made it
fail, then the file was restored.

## Owner decisions (2026-11-20)

1. Token palette: approved. Dark first (violet and charcoal); the light theme
   is optional, built from the same tokens, and ships in wave A10.
2. Status system: all eight states approved (`error` and `stopped` added).
3. Fonts: **system fonts by default**; no font is bundled. This replaces the
   PLANS.md section 5 wording "fonts bundled under an open licence".
4. Pattern set and test identifier rules: approved, with accessible contrast
   (WCAG AA, checked in both themes) and full keyboard navigation as
   requirements for every wave.
