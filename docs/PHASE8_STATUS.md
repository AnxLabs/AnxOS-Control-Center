# Phase 8 status: server, Docker, files, network monitoring and UI quality

Last update: 2026-11-12. Continues from `7fe4fcf1` (Phase 7.1). Local commits
only; nothing is pushed or deployed. No AI features.

## P8-A Audit and gap matrix

The audit launched the real app (isolated profile, QA mode, a test Agent) and
captured every page with Advanced Mode on, then read the services behind them.

Phase 7.1 stays accepted as a checkpoint: the Windows ↔ Anxlab LAN run (7/7),
port protection and the phone app are preserved. The real iPhone, public
internet, OS DNS rule and Agent deployment remain open and do not block
Phase 8.

| Area | What exists | What is wrong or missing | Decision |
| --- | --- | --- | --- |
| Home (Phase 4) | Overview tiles, Needs attention, servers, computers | — | Preserve |
| Computers (Phase 4) | Resource cards, graph, Agent info, AnxNet panel | No per-interface network data (throughput, errors, link speed, gateway, DNS) | Preserve layout; add a Network section |
| Server pages (Phase 5) | Overview, Console, Files, Add-ons, Backups, Settings, Players (Minecraft files) | Online player list, join/leave and ping not shown; FiveM players reduced to a count | Preserve; extend Players |
| AnxNet, Phone (6, 7) | Accepted | — | Preserve |
| My Servers list | Old table: Name, Type, Status, IP:PORT, CPU, RAM, Uptime, Tags | Not redesigned; a running server also says "Node disconnected"; no computer column, sorting, grouping or bulk actions; "CPU warming"/"0s" placeholders read like data | Redesign (cards like Home), keep the same services |
| Docker | Full backend (containers, images, volumes, networks, Compose, cleanup preview, policy) | Page is a wall of buttons (Start/Stop/Restart/Pause/Unpause/Kill/Remove/Logs/Terminal) acting on a hidden selection; no "used by" for images and volumes; tabs are all open at once | Redesign the page on the existing backend |
| Files | Local, Agent and SFTP storage; transfers; editor | Storage list repeats "Local Filesystem" twice and shows a dead legacy Agent (`127.0.0.1:9`); a "Server: Debian / No profiles" picker that does nothing for local files; "Offline" badge while local browsing works | Repair and simplify |
| SSH | xterm.js with a real PTY, host-key approval, saved profiles, several sessions | **Ships the owner's own server as a default profile for every user (`anx@192.168.1.134`)**; the form pre-fills it too; profile picker says "No profiles" while the side panel shows that profile; two "New Session" buttons | Fix (privacy) and repair |
| Console, Backups, Activity, Task details | Working | — | Preserve |
| Network page | Endpoints, providers, graph | Fine for advanced users | Preserve |
| Maintenance | Scan, clear safe caches, reset UI | — | Preserve |
| Agent Control, Security | Sectioned pages | — | Preserve |
| Settings | Sectioned | "Default page on launch" lists retired names (Dashboard, Minecraft, AMP, Public Access, Nodes, Operations, CoolPals) | Repair |
| Navigation | Top 5 + More + "Advanced tools" (only with Advanced Mode) | Tools are invisible to beginners unless they find Advanced Mode | Show a collapsed "Tools" group instead |
| Agent telemetry | CPU, per-core, RAM, disk, network totals, uptime, CPU temperature, NVIDIA GPU | Per-interface throughput, errors/drops, link speed, gateway and DNS checks | Extend the existing sampler |
| Players | Minecraft: Server List Ping count and max; FiveM (service-managed only): count | Names, join/leave, real per-player ping (FiveM exposes it; Palworld REST API exposes it); Minecraft has no per-player ping in vanilla | Add game adapters; "Not supported" where the game does not report ping |

Order of work: SSH privacy fix and small repairs, Agent network telemetry,
player monitoring, My Servers, Docker, Files, SSH page, Tools navigation,
then stabilization.

## Done so far

### P8-E Network telemetry (`ae816e2b`)

- `src/shared/networkDetails.js`, used by the Agent and by this PC directly:
  every adapter's type (wired, Wi-Fi, VPN, virtual), state, IPv4/IPv6
  addresses (link-local left out), link speed, download/upload rates,
  errors and drops, the default router and DNS servers. Linux reads
  `/proc` and `/sys`; Windows runs one PowerShell query, cached 15 s.
  Unknown values stay "Not reported", never 0.
- Computers > Network (a section added to the Phase 4 panel, layout kept):
  connected wired/Wi-Fi adapters first, the rest folded away. "Link speed
  is the connection to your router or switch, not your internet speed."
- Check connection, only when clicked: three pings to the router, one name
  lookup and one HTTPS connection to example.com, run on the computer
  itself (`POST /api/v1/system/network-check`, `system:read`).
- No continuous probes or speed tests.

### Fixes from the audit (`ae816e2b`)

- SSH: new installs no longer get the developer's own server
  (`anx@192.168.1.134`) as a profile; `config/ssh-profiles.json` is no
  longer packaged and the form starts blank. Installs that already copied
  it keep it (it may be the owner's real profile); remove it under SSH if
  it is not yours. The tracked dev file is unchanged so the owner's
  source runs keep their profile.
- Settings > Default page lists the current page names.

### P8-F Players (this commit)

`src/shared/instances/playerMonitor.js`, read through
`GET /api/v1/instances/:id/players` (`instance:read`) and
`instances:getPlayers`:

| Game | Source | Names | Per-player ping | Time online |
| --- | --- | --- | --- | --- |
| Minecraft | Server List Ping | Status sample (may be partial; marked) | Not supported (vanilla does not report it) | Seen by AnxOS |
| FiveM | `/players.json`, `/dynamic.json` on 127.0.0.1 | Yes | **Yes, from the server** | Seen by AnxOS |
| Palworld | REST API on 127.0.0.1 (when the owner enables it) | Yes | **Yes, from the server** | Seen by AnxOS |
| Valheim, Rust, CS2 | Steam A2S query | Yes | Not supported (A2S has none) | Yes, from the server |
| Hytale, Terraria | — | Not supported | Not supported | — |

- Identifiers, IP addresses, account ids and locations from the game are
  dropped; names are shown, never stored or logged. Service-managed
  servers keep their stricter rule: counts and pings, no names.
- Join/leave events are what AnxOS saw between reads (memory only, last 40).
- Polled every 10 s only while a server's Players tab is open; replies are
  cached 5 s; loopback only.
- The Players tab now opens for every supported game ("Who is online").

Tests: `player-monitor-smoke` (8, real local HTTP and UDP fakes),
`phase8-ui-qa` P4 (a running test server's two players in the real app),
`server-view-ui-qa` 9/9 and `minecraft-players-smoke` still pass (its
tab-order assertion was stale since Phase 5 and now checks the Overview
parent instead).
