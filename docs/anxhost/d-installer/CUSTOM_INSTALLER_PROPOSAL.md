# 216-D reopened: a standalone AnxHost Setup (proposal)

**Status:** proposal for owner approval, 2026-11-26. Nothing is built, signed,
pushed or changed in CI. Mockups: `custom/custom-installer-design-sheet.png`
and one PNG per screen, rendered by `node scripts/anxhost-setup-mockups.js`
from the approved brand SVGs and the app's colour tokens.

## What exists today (inspected)

| Product | Installer | What it really is |
| --- | --- | --- |
| **AnxBrowse** | `src-tauri/installer/setup` | A genuinely custom installer: a small Rust program (tao window + wry/WebView2 page, about 1,000 lines) with its own borderless window, HTML/CSS UI, gzip payload inside the exe, per-user install, `--silent` and `--uninstall`. Not Authenticode-signed (private builds). Its progress adds a 170 ms pause per step "to keep the bar readable", which this proposal does not copy. |
| **Sona** | `frontend/src-tauri/installer` | **Not custom.** Tauri's standard NSIS and MSI with branded bitmaps; its own docs say a dark installer window and custom pages are not possible with that bundler. |
| **AnxHost CC (216-D)** | `windows/installer.nsh` | electron-builder's assisted NSIS wizard with AnxHost art and texts: white inner pages, native buttons, Windows wizard frame. |

The updater contract every installed build (215 and earlier included) relies
on (`src/services/updateManager.js`): pick the first release asset over 5 MB
matching `/setup.*\.exe$/i`, check its SHA-256 against the release metadata
and its Authenticode publisher, then **open it normally** (`shell.openPath`, no
silent flags). An NSIS upgrade then runs the old uninstaller from the
registry's `UninstallString` with `/S --updated _?=<dir>`, which keeps the
Helper task.

## Recommendation: a custom Setup that drives the existing NSIS engine

```
AnxOS-Control-Center-Setup-2.0-build216.exe      (same asset name; Authenticode, AnxLabs)
└─ AnxHost Setup (Rust: tao window + wry/WebView2 UI, about 1.5 MB)
   └─ RCDATA payload: the electron-builder NSIS installer (signed, SHA-256 pinned at build)
        run silently: /S [/D=folder] [/NOHELPER] [/allusers] /ANXSTATUS=<file>
```

1. **One window, our design, every screen.** Custom title bar and window,
   charcoal and purple, custom buttons and transitions (welcome, upgrade from
   AnxOS, update, repair, options, "close the app", progress with a technical
   log, done, error, uninstall). No NSIS page is shown.
2. **The engine is unchanged.** The NSIS installer that 215 users get today
   still does the install: file extraction, registry layout from `appId`,
   shortcuts and their rename, the old-uninstaller call, the Helper task and
   its UAC prompt, per-user/all-users. Setup verifies the payload's signature
   and hash, extracts it to the user's temp folder, runs it with `/S` and the
   user's choices, and deletes it afterwards.
3. **Real progress.** `installer.nsh` writes phase events to the status file
   Setup passes (`/ANXSTATUS=`): app closed, Helper stopped, old version
   removed, files extracted, Helper set up (and its result code). During
   extraction the bar is the bytes really written to the install folder
   against the size recorded at build time. No timers.
4. **"App is open" handled first.** Setup lists what runs from the install
   folder and asks before closing anything. It stops the Helper with the
   existing `install-agent-task.ps1 -Mode Stop` (servers saved and stopped)
   instead of the engine's silent kill.
5. **Uninstall.** The Settings › Apps entry and `UninstallString` stay exactly
   as they are (so upgrades keep working). The NSIS uninstaller's
   `customUnInit` hook hands an *interactive* uninstall to a small copy of
   Setup without payload (`resources\AnxHost Setup.exe --uninstall`), which
   shows our uninstall screen and runs the NSIS uninstaller with `/S`. Silent
   and `--updated` uninstalls are never handed off.
6. **Silent installs.** `Setup.exe /S [same options]` runs the engine with no
   window and returns its exit code (3 still means "installed, Helper needs
   attention").

### Why not a complete replacement now

Replacing NSIS means re-implementing, exactly, what installed builds and
Windows already depend on: electron-builder's registry layout and
`UninstallString` conventions, the `--updated` uninstall of older builds,
shortcut migration, per-machine elevation, the Helper task flow and its Smart
App Control handling. Any slip breaks upgrades from Build 215 or the Helper,
and it could only be found with signed builds in Windows Sandbox. The custom
Setup gets the full visual result with the proven engine underneath; a full
replacement can follow later, behind the same window, once it is proven.

## Compatibility and security

| Requirement | How it is kept |
| --- | --- |
| Install and data folders, `appId`, frozen identifiers | The engine and its folder, registry keys and `AnxOSAgent` task are unchanged; `%APPDATA%\AnxHub` is never touched. |
| Helper and Agent compatibility | Same engine and `install-agent-task.ps1`; `/NOHELPER` passes through. |
| Updater picks the right file | The custom Setup takes the existing asset name; the engine is **not** published as an asset, so exactly one file matches `/setup.*\.exe$/i`. A new release check asserts that the asset `pickUpdateAsset` selects is the custom Setup (its version resource says "AnxHost Setup") and that no second `setup*.exe` exists. |
| Authenticode | Both executables signed with the existing Azure Trusted Signing identity; Setup refuses a payload whose signature or SHA-256 differs from the one recorded at build. |
| UAC | Setup runs as the user (asInvoker). Only the engine's existing prompts appear (Helper task, all-users install). Nothing is bypassed. |
| Build 215 installs | Their updater downloads the custom Setup, verifies it and opens it; Setup finds "AnxOS Control Center" and shows the successor screen. |
| Repair, rollback, uninstall | Repair reruns the engine over the same build. A failed run leaves the user's data untouched (as today) and offers Try again. Uninstall as in point 5. |
| No WebView2 (rare: removed by an administrator) | Setup falls back to running the engine's own wizard. This is the only case where an NSIS page can appear. |
| DPI and keyboard | Per-monitor DPI aware; WebView2 scales the page. Every action is reachable by Tab, Enter and Esc with visible focus rings, labelled for screen readers; motion respects "reduce animations". |

## Migration risks

| Risk | Mitigation |
| --- | --- |
| The engine's silent mode differs from the interactive flow | Same macros; Setup only adds `/S` and options electron-builder already supports. Covered by Sandbox runs of fresh, upgrade-from-215, update, repair and uninstall. |
| Antivirus or SmartScreen distrust of an exe that runs another exe | Both signed with the same identity; payload verified before it runs; temp copy removed. |
| A second `setup*.exe` asset confuses older updaters | The engine is never published; the release check fails the build if it is. |
| The uninstall handoff misfires | Only for interactive, non-`--updated` uninstalls; if Setup is missing or fails to start, the NSIS uninstaller continues as today. |
| More CI time | One `cargo build --release` (about 2 to 4 minutes on the Windows runner). |

## Needs your approval before implementation

1. **CI workflow change** (`windows-release.yml`): build the Rust Setup after
   electron-builder, embed the signed engine, publish Setup under the existing
   asset name, regenerate `latest.yml` and the blockmap for it.
2. **Signing:** Azure Trusted Signing signs one more executable (same identity,
   no new certificate).
3. **New build dependencies:** the Rust crates AnxBrowse already uses (`tao`,
   `wry`, `windows`, `serde_json`, plus `sha2` for the payload check).
4. **Release contract:** `validate-release-artifacts.js` and the release
   manifest learn the new layout (same file names).

## Plan once approved

1. `windows/setup/` crate (from AnxBrowse's window code), UI from the approved
   mockup markup, payload verification, engine runner, status protocol.
2. `installer.nsh`: status events, the uninstall handoff, the build record
   (the detection work already prepared, parked uncommitted).
3. Smokes: asset selection (one `setup*.exe`, it is Setup), status-protocol
   parsing, mode detection, silent pass-through; a local unsigned build checks
   the window, which is never installed on the development PC (it shares the
   real `appId`).
4. Acceptance needs the signed CI build: Windows Sandbox with Smart App
   Control (fresh, upgrade from Build 215, update, repair, uninstall, silent),
   then RC1 and the in-place upgrade on the owner's PC after `confirmed`.
