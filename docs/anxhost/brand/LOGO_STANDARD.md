# AnxHost CC logo and icon standard (Build 216-0)

**Status: split strategy approved by the owner on 2026-11-20.** No
production asset has been replaced yet: `assets/icon.ico`, `assets/icons/`,
`src/assets/anxos-logo.png`, `windows/installer-art/`, `src/mobile/web` icons
and `website/` are unchanged. Each surface adopts the set in its own wave
(see "Approved use by surface and wave"). The concept folder
`A:\AnxLabs\40-Assets\Brand\anxhost-logo\` is preserved unchanged as the
source reference (SHA-256 of all 20 files identical before and after 216-0).

Review sheet: `anxhost-brand-proposals.png` (file name kept so links stay
valid). Regenerate everything with `npm run anxhost:brand`
(`scripts/anxhost-brand-build.js`; PNGs rendered in a headless browser, no
window); the output is byte-for-byte deterministic. Checked by
`npm run anxhost-brand-assets:smoke`.

## Owner decision (2026-11-20)

The split strategy is approved:

| Mark | Approved for |
| --- | --- |
| **Option A** (concept) | Large branding: splash screen, About, website hero, installer welcome page |
| **Option B** (badge) | App icons from 48 px, phone touch icons, social previews |
| **Small icon** (simplified) | App title bar at 20 to 28 px; taskbar, tray and favicon at 16 to 32 px |

**Title bar (owner decision, 2026-11-20, before wave A1):** the title bar uses
the simplified small mark at 20 to 28 px, because Option B's minimum size is
40 px. Option B stays for larger icons, Option A for major branding surfaces.
This replaces the first draft's "Option B in the title bar". Wave A1 ships it
at 22 px (`src/assets/anxhost/anxhost-icon-small.svg`, checked by
`scripts/anxhost-shell-ui-qa.js` S1).

Conditions from the owner: keep the original AnxHost concept recognizable,
fix small-size readability and dark/light contrast, and preserve the concept
folder. The contrast fix is described under "Icon silhouette rim".

## Source and originality

- Visual reference: the approved-direction concept saved in
  `A:\AnxLabs\40-Assets\Brand\anxhost-logo\` (raster crops and interim dark
  variants made during planning).
- The SVGs are redrawn vector artwork: hexagon, AH monogram, three-unit
  server rack, orbit with nodes and a bottom connector node.
- The wordmark "AnxHost" and the tagline "Control Center" are **original
  monoline geometric lettering drawn as SVG strokes**. No font file is used
  or embedded, so there is no font licence question.

## Options

| Option | Files | Character | Approved use |
| --- | --- | --- | --- |
| **A: Concept** | `svg/anxhost-mark-option-a-dark.svg`, `-light.svg`, `svg/anxhost-lockup-option-a-*.svg` | Open hexagon, orbit with two nodes, AH breaking the frame, rack and connector node; closest to the concept | Website hero, installer welcome page, About, splash (large sizes only) |
| **B: Badge** | `svg/anxhost-mark-option-b.svg`, `svg/anxhost-lockup-option-b-*.svg` | Filled violet hexagon with a lighter rim, white AH and rack, connector node; works on dark and light without variants | App icon 48 px and up, phone touch icon, social preview |
| **Small icon** | `svg/anxhost-icon-small.svg` | Filled hexagon with a lighter rim and three rack units only; letters and orbit dropped | Title bar (20 to 28 px); 16 to 32 px: tray, favicon, small app-icon sizes, taskbar at 100% scaling |
| Wordmark | `svg/anxhost-wordmark-{dark,light}.svg`, `svg/anxhost-wordmark-tagline-{dark,light}.svg` | "Anx" in ink, "Host" in the violet gradient; tagline with side rules | With either mark, or alone where the mark is already shown |

Dark variants use off-white ink (`#f7f6fa`), light variants the logo ink
(`#1e1e26`). The violets are the brand primitives in
`src/renderer/anxhost/tokens.css` (`#8c3ee6`, `#7818c0`, `#6010a0`, `#4a0d80`,
`#300058`).

## Icon silhouette rim (contrast fix)

**Problem.** Measured on the rendered PNGs, the deep hexagon fill
(`#6010a0` to `#300058`) reached only about 1.7:1 against a dark Windows
taskbar (`#202020`): 95 to 100% of the icon's edge pixels at 16 to 64 px were
below 3:1 (WCAG 1.4.11 non-text contrast), so the hexagon melted into the bar.
The concept folder's own small marks had the same problem (96% at 32 px) and,
with dark letters and rack, also lost the "A" and the rack on dark surfaces.

**Fix.** Option B and the small icon get a rim of `#9854ee` (halfway between
violet-400 and violet-500) along the hexagon edge. A rim must reach 3:1
against both taskbars; violet-400 alone only just did on light (3.18:1), so
anti-aliased edges fell below. `#9854ee` is 3.75:1 on `#202020`, 3.91:1 on
`#f3f3f3`, and white on it is 4.34:1. Widths are in mark units (256 = icon
size): the small icon uses 24 (1.5 px at 16 px; a 1 px rim blurred into the
fill at 16 px), Option B 10 (about 2 px at 48 px). The fill, monogram, rack
and connector node are unchanged, so the concept stays recognizable. Option A
is unchanged: it is used only at large sizes, in its `-dark` and `-light`
variants.

**Result** (share of opaque edge pixels below 3:1, dark / light taskbar):

| Image | Before | After |
| --- | --- | --- |
| App icon, tray, favicon 16 to 32 px (small icon) | 100% / 0% | 0% / 0% |
| App icon 48 px (Option B) | 95% / 3% | 0% / 1.7% |
| App icon 64 px | 95% / 3% | 0% / 1.3% |
| App icon 128 and 256 px | not measured | 0% / at most 0.3% |

`scripts/anxhost-brand-assets-smoke.js` (check B4) fails if more than 5% of
any icon-size image's edge falls below 3:1 on either taskbar. With the rim
removed it failed 15 checks (every icon on the dark taskbar); with the rim
restored the outputs were byte-identical to before and it passed.

The small icon's rim reads heavy above 32 px (see the review sheet tile); use
it only at 16 to 32 px, as approved.

## Generated sizes

| Set | Files | Source |
| --- | --- | --- |
| App icon | `png/app-icon/anxhost-app-icon-{16,20,24,32,48,64,128,256,512,1024}.png`, `anxhost-app-icon.ico` (16, 20, 24, 32, 48, 64, 256) | small icon up to 32 px, Option B from 48 px |
| Tray | `png/tray/anxhost-tray-{16,20,24,32}.png` (100% to 200% scaling of a 16 px tray) | small icon |
| Favicon | `png/favicon/anxhost-favicon-{16,32,48}.png`, plus `svg/anxhost-icon-small.svg` | small icon |
| Phone | `png/touch/anxhost-touch-{180,192,512}.png` (on `#08060d`, 10% padding) | Option B |
| Marks | `png/marks/anxhost-mark-option-{a-dark,a-light,b}-512.png` | |

## Approved use by surface and wave

| Surface | Mark | Wave |
| --- | --- | --- |
| Title bar | Small icon at 20 to 28 px, with the "AnxHost CC" name (owner decision) | A1 (shipped at 22 px) |
| Startup splash, About | Option A lockup, `-dark` variant (`-light` once the light theme ships) | A1 (splash), A9 (About) |
| Windows app icon (`.ico`), taskbar | Small icon at 16 to 32 px, Option B from 48 px (`png/app-icon/anxhost-app-icon.ico`) | 216-D (packaging) |
| Tray | Small icon, 16 to 32 px | A1 or 216-D |
| Installer welcome page | Option A lockup | 216-D |
| Phone touch icons and PWA | Option B (`png/touch/`) | 216-C |
| Website hero | Option A lockup | 216-B |
| Favicon | Small icon (`svg/anxhost-icon-small.svg`, `png/favicon/`) | 216-B (website), 216-C (phone) |
| Social preview | Option B | 216-B |

Each production asset is replaced in its wave, from these files.

## Rules

- **Clear space:** at least the height of one rack unit of the mark (about
  1/14 of the mark height) on every side; for lockups, the height of the "n"
  in the wordmark.
- **Minimum sizes:** Option A mark 48 px (below that the orbit and rack
  blur); Option B 40 px; lockups 160 px wide; below 40 px use the small icon
  only.
- **Backgrounds:** use the `-dark` variants on the app's dark surfaces and
  the `-light` variants on light surfaces. Option B and the small icon work
  on both.
- **Don't:** recolour outside the brand violets, stretch, add effects
  (shadows, glows) to the mark, put the wordmark in another typeface, or
  combine Option A and B in one layout.
- **Name:** "AnxHost Control Center" in full, "AnxHost CC" when short; the
  wordmark is "AnxHost" with the "Control Center" tagline.

## Known limits of this draft

- Strokes are not expanded to outlines. For print or a designer hand-off,
  convert strokes to paths in a vector editor (the geometry stays the same).
- The concept artwork was AI-assisted raster art. Before public use, the owner
  should confirm the name and mark are clear to use (trademark search), as
  noted in PLANS.md.
- At 48 px Option B is busy; if the owner prefers, 48 px can also use the
  small icon.
- PLANS.md section 5 described the simplified mark as "hexagon and monogram
  only, no rack detail". The approved small icon is the hexagon and rack,
  without the monogram, because the AH is unreadable at 16 px (see the review
  sheet's small sizes). The owner approved it as shown.
- The contrast check uses typical Windows taskbar colours; a custom accent
  colour on the taskbar is not covered.

## Decisions (2026-11-20)

1. Primary logo: the **split strategy** (A for large brand moments, B for
   icons from 48 px, the small icon at 16 to 32 px). Approved.
2. Wordmark lettering: approved as part of the lockups shown.
3. App, tray, favicon and phone icon sets: approved for use in their waves
   (table above), with the silhouette rim fix.
