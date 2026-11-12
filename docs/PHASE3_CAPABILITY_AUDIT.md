# Phase 3 capability audit and status

Audit of the Phase 3 brief (Hosting, Networking & Reliability) against branch
`claude/anxos-control-center-simplify-8080f1`, updated 2026-11-12 at the end
of the Phase 3 run. It is the handover document for the next development
agent.

Status values:

- **Exists**: implemented before Phase 3; found in the named code.
- **Phase 3**: added or fixed in this phase (commit named).
- **Partial**: implemented in part, or not reachable for beginners.
- **Missing**: not found.
- **Blocked**: needs real credentials, hardware or owner approval.

Items marked Exists were located in source. Items marked Phase 3 have tests,
listed under Evidence.

## 3.1 Playit and networking

| Capability | Status | Where |
| --- | --- | --- |
| Playit installed / running / stopped detection | Exists | `src/services/playitService.js`, `agent/src/services/playitService.js` |
| Guided account and agent linking | Exists | `src/services/playitAccountService.js` (browser claim; never reads the secret key) |
| Active tunnels, addresses, ports | Exists | Agent Playit metadata parsing; Sharing page tunnel list |
| Tunnel creation | Partial (by design) | The detected integration does not create tunnels. AnxOS states the exact tunnel to create on playit.gg (`describePlayitTunnelSetup`) |
| `tcp+udp` / `both` tunnels reported correctly | Phase 3 (`a41bcf0b`) | Previously reported as plain TCP |
| Tunnel protocol that does not fit the game | Phase 3 (`a41bcf0b`) | "Tunnel protocol does not fit the game"; an unreported protocol is never a problem |
| Playit restart-on-failure and start-on-boot | Phase 3 (`a41bcf0b`) | Read-only (`systemctl show -p Restart`, `is-enabled`, `Get-Service` StartType, `sc.exe qfailure`). Shown on the Sharing page with how to fix it. No second watchdog |
| Outdated Playit agent detection | Missing | Version is read; there is no "latest version" source without a network call |
| Per-server Share dialog | Phase 3 (`cfb26020`) | "Can friends join?" checklist, one next step, Test connection |
| Tunnel up is not reported as a reachable game | Phase 3 (`cfb26020`) | `src/shared/shareHealth.js` |
| Connection test per server | Phase 3 (`cfb26020`) | Reuses the read-only `connectivity:runDiagnostics` with the server id |
| Sharing needs explicit approval | Phase 3 (`cfb26020`, verified `073ac13a`) | The server's expose-share action previously shared without asking |
| Management ports never shared automatically | Phase 3 (`cfb26020`) | SSH, Docker API, RDP, VNC, WinRM, AnxOS Agent |
| Stop sharing | Phase 3 (`cfb26020`) | States that the playit.gg tunnel stays until deleted there |
| Layered diagnostics | Exists | `src/services/connectivityDiagnosticsService.js` |
| Port conflicts at Create Server (other programs) | Phase 3 (`c1d2af1a`) | Live listener list; the note names the program; Create server refuses an occupied port |
| Firewall rule preview before applying | Exists | Public Access `create-firewall-rule` (preview, then apply); not changed |
| IPv6 / CGNAT handling | Partial | Connectivity diagnostics separate host, tunnel and public stages; no CGNAT-specific detection |

## 3.2 Server management

| Capability | Status | Where |
| --- | --- | --- |
| Start / stop / restart / force kill | Exists | Instance lifecycle; `force-kill` server action |
| Crash restart with backoff and crash-loop stop | Exists | `restartPolicy`, `getRestartBackoffDecision`, `CRASH_LOOP` |
| No restart loop for a failure a restart cannot fix | Phase 3 (`c027e27f`) | A taken port or full disk during startup stops automatic restarts |
| Auto start, scheduled restarts, version pinning, pre-update backup | Exists | `autoStart`, `restartScheduleService`, `runtimePinService`, `createPreUpdateBackup` |
| Plain wording for restart and auto start | Phase 3 (`cfb26020`) | Stored values and defaults unchanged |
| Hardware-aware defaults | Phase 2 | Memory fitted to the computer, free port, software check |

## 3.3 Backups

| Capability | Status | Where |
| --- | --- | --- |
| Manual and scheduled backups, retention, verification | Exists | `agent/src/services/backupService.js` |
| Backups tab on each server | Exists | Backup Now, Restore, Scheduled Backups, History |
| Restore preview in the confirmation | Phase 3 (`5dc62696`) | Uses the Agent's read-only dry run: what is replaced, the safety copy, warnings |
| Import a backup from the server's tab | Phase 3 (`5dc62696`) | No server ID prompt |
| Restoring an imported world backup deleted the server | **Fixed** Phase 3 (`e00c2642`) | Reproduced in a sandbox. See AGENTS.md lessons learned |
| Importing a game world (e.g. a singleplayer `.zip`) | Missing | Design below |

## 3.4 – 3.8

| Area | Status | Notes |
| --- | --- | --- |
| Startup failures explained | Phase 3 (`c027e27f`) | Port taken, out of memory, disk full, crash loop, early exit, killed, crashed, invalid command |
| Per-server CPU, RAM, logs, alerts | Exists | Instances inspector, console, Activity alerts |
| Player counts | Partial | Minecraft and AMP paths |
| Game config forms | Exists | Game config routes |
| Per-mod enable/disable | Out of scope | Phase 5 (Modrinth/CurseForge mod management) |
| Multi-computer status and pairing | Exists | Phase 4 covers the computer/agent dashboard |
| Management services private | Exists | Agent auth, IPC permission checks, URL allowlists (not changed) |
| Repairs recorded in Activity | Exists | Repairs run as operations, shown in Activity / Task details |

## Next work (independent, no approval needed)

1. **Game world import from a `.zip`.** Reuse the desktop's hardened ZIP
   reader (`validateZipDirectory`, `safeArchivePath` in
   `marketplaceInstallService.js`). Find the world folder by `level.dat`.
   Repack it as a `.tar.gz` under the server's world path (read from a fresh
   world backup's `sourcePaths`, or a new read-only Agent query). Import it
   with `type: "world"`; the import now validates world-only archives. Then
   restore through the normal flow, which includes the preview, safety copy
   and stop/restart.
2. **Outdated Playit detection,** if an approved source for the latest
   version exists.
3. **CGNAT hint.** When the public stage fails and the host has a
   100.64.0.0/10 address, say so.

## Blocked: needs a real node, a Playit account or owner approval

- Sharing a Minecraft Java server and a UDP game over a real Playit tunnel.
- Two servers behind tunnels at the same time.
- Recovering from a disconnected Playit agent on a real node.
- Restoring on a real node, for example a real world backup on Anxlab.
- `agent-package-closure-smoke` (release tier). It must run in a checkout
  with its own `node_modules` (`npm ci`). In a worktree, dependencies resolve
  outside the repository and the packager refuses them by design.

## Evidence

Run in an isolated QA app with a disposable test Agent, or in pinned temporary
roots. Nothing touched the installed app, real nodes, Playit, firewall rules
or public exposure.

- `scripts/share-health-smoke.js`: sharing rules, approval order,
  management ports, tunnel protocol, Playit restart settings (read-only).
- `scripts/simple-ui-screenshots-qa.js` (Electron):
  - S5: Share dialog and Test connection.
  - S6: approval wording, cancel creates nothing, approve sends the
    request, port 22 refused with no dialog.
  - S2: occupied-port refusal.
- `scripts/create-server-defaults-smoke.js`: live-listener port conflicts.
- `scripts/restore-preview-smoke.js`, plus `restore-targeting-smoke.js` feeding
  real Agent previews to the presenter.
- `scripts/world-import-restore-smoke.js`: reproduces and guards the
  imported-world data-loss bug, including records older builds wrote.
- `scripts/server-failures-smoke.js`: real processes. A bind failure is
  `PORT_IN_USE` and not restarted; an ordinary crash is still restarted.
