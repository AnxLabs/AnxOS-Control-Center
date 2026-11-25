# 216-D Installer design (polished NSIS)

**Status:** design proposed 2026-11-25. Owner approval: "i approved anything"
(2026-11-25, chat), recorded as approval of this design. Mockups:
`installer-design-sheet.png` and one PNG per page. Rendered with
`node scripts/anxhost-installer-mockups.js` at the real Modern UI 2 sizes from
the approved brand SVGs (Option A mark on the welcome, finish and uninstall
sidebars; the small mark in the header art, per `LOGO_STANDARD.md`).

## Pages

| # | Page | Change from Build 215 |
| --- | --- | --- |
| 1 | Welcome, new install | AnxHost sidebar art (Option A mark, wordmark with tagline, "formerly AnxOS Control Center"); new name in title and text. |
| 2 | Welcome, update or repair | Same art; title "Update AnxHost Control Center"; shows the installed and new build when the installed version can be read. |
| 3 | Who is it for | electron-builder's page, unchanged apart from the header art and the copy the NSIS language strings allow. |
| 4 | Install folder | Header art and copy. The default folder name stays `AnxOS Control Center` (FI-APP-04: the executable and install folder are frozen identifiers). |
| 5 | Set up AnxHost | Same controls and logic (Helper checkbox, kept when already installed, `/NOHELPER`), clearer layout: a "Recommended" tag and the administrator-approval explanation in a callout. |
| 6 | Installing | Header art and copy. |
| 7 | Finish | Same art; the run checkbox keeps the unthemed white drawing fix. |
| 8 | Uninstall | Same art; text unchanged apart from the names. |

## Unchanged (must be preserved, PLANS.md 216-D)

`appId`, upgrade detection, the Helper scheduled task (`AnxOSAgent`) flow and
its Smart App Control and UAC handling, `/NOHELPER`, `--updated`, Azure
Trusted Signing, signing of every NSIS plugin (no new plugin is introduced:
the design uses nsDialogs, LogicLib, FileFunc, nsExec and System, as today),
the publisher pin, the executable name, the install folder, and the updater's
installer selection (`artifactName` keeps matching `/setup.*\.exe$/i`).

## Art files

`windows/installer-art/sidebar.bmp` (164x314, 24-bit) and `header.bmp`
(150x57, 24-bit) are regenerated from the brand SVGs by the same renderer, so
they stay reproducible. Inner pages keep the native Windows light body, which
NSIS draws reliably; only the header bar and the welcome and finish pages are
dark (`MUI_BGCOLOR 181521`), as in Build 215.

## Name decisions taken with this design

- Visible product name: **AnxHost Control Center** (216-B1).
- The background service is shown as **AnxHost Helper**. Its task name
  `AnxOSAgent` and the `install-agent-task.ps1` script stay (frozen).
- Branding text: "AnxHost Control Center by AnxLabs".

## Validation still required (not claimable before the signed CI build)

Fresh install, in-place upgrade from a real Build 215 install, repair and
uninstall in Windows Sandbox with Smart App Control on; signature coverage;
the `local-agent-installer`, `installer-signature`, `build-signing` and
`windows-signing-coverage` smokes. Signed artefacts come only from the
existing GitHub Actions workflow (216-G), which needs a push approval.
