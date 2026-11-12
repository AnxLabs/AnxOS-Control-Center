# Phase 3 capability audit

Audit of the Phase 3 brief (Hosting, Networking & Reliability) against the
code on branch `claude/anxos-control-center-simplify-8080f1`, 2026-11-12.
Per the brief's engineering requirements 1–2, each item is marked:

- **Exists**: implemented; found in the named code.
- **Partial**: implemented in part, or not reachable for beginners.
- **Missing**: not found.
- **Not verified**: present in code but not exercised in this audit.

The audit is a code search, not a runtime test of every item. Items marked
Exists were located in source; only the 3.1 increment below was run.

## 3.1 Playit and networking

| Capability | Status | Where |
| --- | --- | --- |
| Playit installed / running / stopped detection | Exists | `src/services/playitService.js`, `agent/src/services/playitService.js` |
| Guided account and agent linking | Exists | `src/services/playitAccountService.js` (browser claim; never reads the secret key) |
| Active tunnels, public addresses, ports, protocols | Exists | Agent Playit metadata parsing; Sharing page tunnel list |
| Tunnel matched to a server by port | Exists | `findSharePlayitTunnelMatches` in `app.js` |
| Tunnel creation through official methods | Partial | Tunnels are read from Playit; creation happens on playit.gg |
| Outdated Playit agent detection | Not verified | Version parsing exists (`parseVersion`); no "outdated" rule found |
| Automatic reconnect / controlled restart of Playit | Partial (by design) | Manual start, stop and restart exist. Playit runs under the system service manager (systemd or a Windows service), which is the right supervisor; a second AnxOS watchdog would duplicate it and could fight it. Next: show the service's own restart setting |
| Per-server Share dialog with copy buttons | Exists | `openShareServerModal` |
| Local, Playit and Tailscale addresses per server | Exists | `getShareServerAddresses` |
| Connection test per server | **Fixed in this increment** | Share dialog Test connection runs `connectivity:runDiagnostics` with the server id |
| Tunnel up is not reported as a reachable game | **Fixed in this increment** | `src/shared/shareHealth.js`; it was reported ready with an unknown game port |
| Layered diagnostics (process, port, host, Agent, tunnel, public) | Exists | `src/services/connectivityDiagnosticsService.js` (read-only, bounded) |
| Occupied ports and listener conflicts | Exists | `agent/src/services/networkInventoryService.js` |
| Firewall rule preview before applying | Exists | Public Access `create-firewall-rule` (preview, then apply) |
| IPv6 / CGNAT handling | Not verified | Mentions in desktop services only |
| Enable/disable sharing per server with approval | **Added (increment 2)** | Share dialog: Share over the internet / Stop sharing; approval required in `createAccessServiceForInstance` |
| Management ports never shared automatically | **Added (increment 2)** | `getManagementPortName` refuses SSH, Docker API, RDP, VNC, WinRM and the AnxOS Agent port |

## 3.2 Server management

| Capability | Status | Where |
| --- | --- | --- |
| Start / stop / restart | Exists | Instance lifecycle in `src/shared/instances/instanceServiceCore.js` |
| Force stop | Partial | SIGKILL fallback after the graceful stop times out; no separate button found |
| Crash restart with backoff and crash-loop stop | Exists | `restartPolicy` (`never`, `on-failure`, `always`), `getRestartBackoffDecision`, `CRASH_LOOP` |
| Auto start | Exists | `autoStart` instance setting |
| Scheduled restarts with player warnings | Exists | `agent/src/services/restartScheduleService.js` |
| Version pinning | Exists | `agent/src/services/runtimePinService.js` |
| Pre-update backup | Exists | `createPreUpdateBackup` for SteamCMD updates |
| Beginner wording for these settings | **Fixed (increment 2)** | "Automatic restart": Don't restart automatically / Restart if it crashes / Always keep it running; "Start with the computer". Stored values and defaults are unchanged |

## 3.3 Backups

| Capability | Status | Where |
| --- | --- | --- |
| Manual and scheduled backups, retention | Exists | `agent/src/services/backupService.js` (`pruneRetention`) |
| Integrity verification | Exists | `verifyBackup` |
| Restore with preview (dry run) | Exists | `restoreBackup`; read-only preview at backupService.js:1407 |
| World import / export | Missing | No world-import path found |
| Backups inside each server's page | Partial | Backups is a separate page |

## 3.4 – 3.8

| Area | Status | Notes |
| --- | --- | --- |
| Per-server CPU, RAM, logs | Exists | Instances inspector, console |
| Player counts | Partial | Minecraft and AMP paths |
| Smart startup diagnostics | Partial | Error copy maps known codes (`MINECRAFT_PORT_IN_USE`, `DEPENDENCIES_REQUIRED`, …) |
| Alerts | Exists | Alert engine on Activity (active alerts) |
| Game config forms | Exists | Game config routes and smokes |
| Mod and plugin workflows | Partial | Modrinth and CurseForge modpack installs; no per-mod enable/disable found |
| Multi-computer status and pairing | Exists | Nodes, fleet, pairing; reconnect handling |
| Management services private | Exists | Agent auth, IPC permission checks, URL allowlists (not changed) |
| Self-repair | Partial | Repair Runtime, Prepare Node, Agent repair; repairs are recorded in Activity |

## Delivered in this increment (3.1)

1. `src/shared/shareHealth.js`: one rule set for "can friends join". An
   active tunnel with an unconfirmed game port is reported as "Tunnel ready,
   game not verified". The old rule called it "Public access ready".
2. The Share dialog leads with "Can friends join?". It shows a plain
   checklist in connection order, one next step, and a Test connection
   button. The button reuses the existing read-only connectivity diagnostics
   and names the first broken stage. A recent test settles the game's port.
3. When the computer is disconnected, the checklist marks nothing as working
   or broken.
4. Tests: `scripts/share-health-smoke.js` (rules) and an Electron check (S5)
   in `scripts/simple-ui-screenshots-qa.js`.

## Delivered in increment 2

1. Per-server sharing switch in the Share dialog. **Share over the internet**
   asks for approval and states exactly which port and protocol are shared.
   **Stop sharing** says that a tunnel on playit.gg is not deleted by AnxOS.
2. The approval and the management-port refusal live in
   `createAccessServiceForInstance`, so every path is covered. That includes
   the server's "expose-share" action, which previously shared without asking.
3. When a share is waiting for its tunnel, the dialog shows the exact Playit
   tunnel to create (protocol and local port) for that game.
4. Plain restart and auto-start wording in server settings and the console.

## Suggested next increments

1. Show whether the Playit service restarts itself (systemd or Windows
   service restart setting), and offer a guided fix if it does not.
2. Backups and restore preview inside each server's page.
3. Port-conflict check at Create Server against the Agent's live listener
   inventory, not only ports used by other AnxOS servers.

## Acceptance scenarios not run here

The QA app runs locked against a test Agent. Connection tests are therefore
refused with "Unlock AnxOS to run connectivity diagnostics", which is the
correct security behaviour. A live Playit share, a UDP game, two servers
behind tunnels, and backup and restore were not exercised. They need a real
node and Playit account, and the owner's approval.
