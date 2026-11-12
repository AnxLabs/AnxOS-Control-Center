# Phase 5 status: server pages and add-ons

Handover for the next development agent, 2026-11-12, branch
`claude/anxos-control-center-simplify-8080f1`. No AI features were added.
Nothing is committed, pushed, released or deployed yet.

## What changed

### 5.1 One server, one page

Opening a server (a row in My Servers, or a card on Home) shows only that
server. The list, the stat tiles and the filters stay on the list page, and
"All servers" goes back.

The page has one header with:
- the game icon and name, and "Minecraft · Paper"-style game labels
- the version, the computer, and the address with Copy
- live CPU, RAM and player chips, marked "last reading" when stale
- Start, Stop, Restart and Share
- a More menu for everything else, grouped as Access, Manage and Danger zone

Before this change, four groups held 15 buttons.

The header stays visible while switching tabs. There are six tabs: Overview,
Console, Files, Add-ons, Backups and Settings. Players and Performance open
from Overview, and Network opens from Settings. A detail view keeps its
parent tab highlighted and shows its own name only while it is open.

### 5.2 Overview

Overview shows:
- the status in plain words, with the reason when the server failed
- players
- CPU and memory, with a Live or Last reading label
- the address and whether friends can reach it
- the game, the version and the computer
- recent events from operations and Activity for this server

Anything that is not measured says so. The old metadata grids moved into a
collapsed "Technical details" section.

### 5.3 Live updates

The Overview and the header redraw from the existing instance poll and the
metrics store, with no new pollers. A 5-second tick ages readings while a
server page is visible. Card redraws are reconciled, so unchanged cards keep
focus. Settings edits survive polls (existing guard, still covered by R2).

### 5.4 Settings

Settings has these sections:
- General
- Game settings (server.properties, existing editor)
- Performance: memory, with a suggestion based on the computer's own free memory
- Server behavior: crash restart, start with the computer, scheduled restarts
  (moved here from Backups)
- Network, with a link to network details and diagnostics
- Advanced, collapsed: startup command, Java options, folder, timeouts and
  environment variables
- Raw configuration and recovery

Saving now:
- **Validates inputs inline** before anything is sent.
- **Asks before you leave unsaved changes.** This applies to another tab,
  another server, or the list.
- **Detects conflicts.** It sends the values it loaded, and the Agent refuses
  the save if any of them changed elsewhere since
  (`expectedConfig` → `INSTANCE_CONFIG_CONFLICT`). Field values are compared,
  not `updatedAt`, because the Agent also bumps `updatedAt` on unrelated file
  writes.
- **Flags restart-only changes.** A change to a running server that only
  applies at start shows "Restart the server to apply: …" until the server
  restarts or stops.

Environment variables can now be edited. The app only ever sees variable
names, because values are redacted before they reach it. A save therefore
sends name-level changes (`environmentChanges: { set, remove }`), and
unchanged variables keep their stored values. The editor turns on only when
the Agent reports `environmentEditable`, which this build adds. Older Agents
show a read-only list.

**Bug fixed:** the old Advanced panel duplicated the startup fields as
editable-looking inputs that were never saved.

### 5.5 Console

**Bug fixed:** "Clear" deleted the Agent's captured logs. It is now "Clear
view", which hides the lines on screen and keeps the server's logs.

Auto-scroll now follows new lines only while the view is at the bottom. Reading
older lines is not interrupted, and a "Jump to latest" button resumes it.

Verified unchanged:
- Streaming re-reads a bounded window and reconciles it, so reconnects can't
  duplicate lines.
- ANSI colors work.
- Commands work: the test sends `say` and `list` to a running server and sees
  the answers.

### 5.6 SSH and terminal audit

Audited against a real in-process `ssh2` server
(`scripts/ssh-interactive-session-smoke.js`). No defect was found in the
service:
- An unknown host key is held for approval.
- A changed host key is refused.
- The shell is a real PTY of the requested size.
- Typed input, Ctrl+C and arrow keys reach the server.
- Resize sends a window-change.
- Disconnect closes the channel.
- A rejected key fails with a plain message and no key material.

The interactive terminal only uses SSH profiles the user created. Unattended
connections (commands, tunnels) require key authentication and an already
approved host key. No code path uses a monitoring credential for a shell.
Nothing about SSH authentication, host verification or permissions was
changed.

### 5.7 Add-ons (Modrinth and CurseForge)

`src/services/modManagerService.js` was rewritten around provider adapters,
and `src/renderer/addonsTab.js` is the tab.

- **Search** runs on Modrinth, or on CurseForge through AnxOS's existing
  approved CurseForge route. When CurseForge isn't configured, it is shown
  as unavailable with the reason. Results are filtered to the server's
  Minecraft version and loader.
- **Install plan:** what will be installed, where, and which required
  dependencies come along. Install proceeds only with the dependencies
  approved (`MOD_DEPENDENCIES_NEED_APPROVAL` otherwise). Missing or
  incompatible dependencies block the install.
- **Refused:**
  - client-only projects
  - the same project again, including from the other provider
  - files whose author forbids third-party downloads on CurseForge (the user
    is pointed to the CurseForge page and Import instead; nothing is scraped)
  - any download not from the provider's CDN host
  - checksum mismatches (Modrinth SHA-512, CurseForge SHA-1)
  - non-archives
- **All or nothing:** every file is downloaded and verified before any is
  written, and a failed write removes what was written.
- **Installed list:**
  - update and Update all
  - roll back to the previous version, which updates keep in
    `.anxos-addon-backups/` outside mods/plugins
  - enable and disable
  - remove, which keeps a backup copy
  - dependency warnings and history
- **Import a file:** a .jar from your computer. A file Modrinth recognises by
  its SHA-512 becomes updatable, and a duplicate is refused.
- **One add-on job per server** at a time. Jobs appear in Activity.
- **Restart notice:** changes to a running server show the restart notice.
  A file the server holds open reports "stop the server first" instead of
  failing.
- **Vanilla servers** explain why they can't load add-ons. Other games have
  no Add-ons tab yet; the adapter layer is where they would go.

### 5.8 Files

**Bug fixed:** drag-and-drop read every file as text, which silently
corrupted jars, images and archives. Files are now uploaded byte for byte.
Replacing an existing name asks first, progress shows in the drop zone, and
files over 100 MB are refused with an explanation.

### 5.9 Backups

The Backups tab lists this server's backups inline from the shared backup
system. Each shows its time, scope, size and verification state, with
Restore (the existing preview and confirmation), Verify and Download. The
tab also shows the schedule and Back up now.

**Bug fixed:** the backup dialog's "Cancel" button meant "make a full
backup", so it could not be cancelled. It is now Whole server / World only
(only when the game's world layout is known) / Cancel.
`WORLD_PATH_NOT_FOUND` now reads as a plain message.

## Evidence

| Check | What it proves |
| --- | --- |
| `scripts/server-view-ui-qa.js` (V1–V9) | Real app and a real Agent, with a disposable Paper stand-in that has a console. Covers: the server page; live Overview after Start; console commands and Clear view; settings validation, saving, the unsaved guard and the restart notice; the conflict refusal; the add-on plan, install and remove (Modrinth faked by intercepting `fetch` in the main process only); the backups list and restore preview; binary upload; no renderer errors. |
| `scripts/server-view-model-smoke.js` (P1–P7) | Tab mapping, status wording, freshness, restart notes, validation, memory suggestion, add-on support |
| `scripts/mod-manager-smoke.js` (A1–A7) | The add-on service with fake providers: plan and approval, lifecycle, rollback, safety, CurseForge rules, import, IPC permissions |
| `scripts/ssh-interactive-session-smoke.js` (T1–T6) | Interactive SSH against a real `ssh2` server |
| Updated pins | `instances-layout-ui-qa` (More menu), `instance-network-performance-ui-smoke` (six tabs), `ui-polish-smoke` (Clear view), `backup-world-scopes-smoke` and `backup-consistency-smoke` (scope dialog) |

## Needs real servers, credentials or approval

- **Live add-on downloads.** Live Modrinth and CurseForge downloads into a
  real server were not run. The tests fake both providers.
  - CurseForge uses AnxOS's hosted route and key, and was not called.
- **Settings persistence across an Agent restart.** It was verified as the
  Agent's own config write; a real Agent restart on a real node was not
  done.
- **Agent build and approval.** The Agent-side pieces need the next Agent
  build, which needs approval: the conflict check, name-level environment
  edits, and the `environmentEditable` flag. Older Agents ignore the conflict
  check and keep environment variables read-only.
- **SSH on real hosts.** It was not exercised on real hosts. That needs real
  credentials.

## Known limits

- **Add-ons.** These are Minecraft only. Dependency checks use the
  providers' declared dependencies; no jar is inspected. Disabling a
  dependency that others need is allowed and shown as a warning.
- **Uploads.** Files are capped at 100 MB each, and uploads have no cancel
  button.
- **Mobile layout.** The header is not sticky on narrow windows (under
  760 px) so it doesn't cover the content.
