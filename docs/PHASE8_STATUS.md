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

### P8-B My Servers (this commit)

The list keeps its table and hooks (the Phase 5 server view opens from a
row; layout, refresh and service-managed tests depend on them):

- Columns: Server, Status, Address, CPU, RAM, Uptime, Actions. Under each
  name: the game and version ("Minecraft · Paper 1.21.1", "FiveM") and the
  id; the process type moved to a tooltip; tags and "Update available"
  became badges. The row actions no longer get pushed out of the table
  when a server has tags.
- Sort: Status (problems first), Name, Most CPU, Most memory (remembered).
- Select servers: checkboxes on the names (a click selects, it does not open
  the server); Start / Stop / Restart selected. One confirmation names every
  server and says which are skipped (already running, stopped or busy);
  servers run one at a time through the same action path as a single row,
  re-checked just before each.
- Stale state (a real bug found by the test): with the Agent gone, the
  app kept saying the computer was "Connected" and its servers "Running"
  on My Servers, because node health was only re-checked on Home and
  Computers. My Servers now asks for the selected computer's health every
  15 s (one request, never during a server action) and, when the computer
  is not connected and the list has not loaded for 15 s, each state reads
  "Last known · Running" with a dashed outline.

Tests: `phase8-ui-qa` P5 (sort, select, bulk start/stop with skip) and P6
(stale state after stopping the Agent; actions still fit);
`instances-layout-ui-qa` 4/4, `instances-refresh-preservation-ui-qa` 4/4,
`server-view-ui-qa` 9/9, `responsive-mobile-ui-qa` 45 checks with 0
failures (it reports two missing xterm files: this worktree has no
`node_modules`, an environment limit that also shows on the unchanged code).

Not done: one list across several computers (the list shows the selected
computer, as before); grouping.

### P8-C Docker (this commit)

The Docker backend already covered containers, images, volumes, networks,
Compose, guided create with a safety preflight, a cleanup preview and
"used by" for images and volumes. What was wrong was the page, so only the
page changed (`src/renderer/dockerWorkspace.js`):

- One section at a time: Containers, Images, Storage (volumes), Networks,
  Compose, Create, Clean up (remembered). The page went from about 2,400 px
  of stacked panels to 1,174 px.
- Shortcuts: Create a container, View logs, Manage storage, View networks.
- The top toolbar acted on a hidden selection with ten buttons; it now has
  only Refresh. Start, Stop, Restart, Pause, Resume, Kill, Remove, Logs and
  Terminal sit in the selected container's details panel (the same button
  elements, so their wiring is unchanged). Rows keep their quick actions.
- Images say "not used by any container" or "used by N containers";
  removing an image or volume that a container uses stays disabled.

Tests: `phase8-ui-qa` P7 (fake image and volume lists injected at the IPC
layer in the test app; Docker Desktop is stopped on this PC and was not
started); all eight `docker-*` smokes pass.

Not verified here: live containers, logs, terminal and Compose against a
running Docker daemon (no daemon on this PC during the run; Anxlab has
Docker but is a live server).

### P8-D Files (this commit)

The file service already wrote uploads atomically (temp file, then rename),
refused silent overwrites, guarded paths and moved binaries intact, but
only through a one-file picker. Added:

- Drag and drop on the Files list: several files at once, to the folder
  being shown, on this PC, a computer's Agent or an SFTP server
  (`files:uploadContent`, `files:write`, rate limited). Content travels as
  base64 and is written byte for byte; names that would leave the folder,
  control characters, over-100 MB files and malformed content are refused
  before anything is written. Existing names are listed in one
  confirmation; nothing is replaced without it. Uploads appear in
  Transfers and the list refreshes.
- This PC and Agent storage open when selected; only SFTP keeps its
  Connect step (it asks for a password).
- The path field no longer suggests the developer's home folder.

Tests: `files-drop-upload-smoke` (5), `phase8-ui-qa` P8 (two files dropped
in the real app into a disposable folder, checked on disk);
`files-layout-ui-qa`, files IPC and pipeline smokes pass.

Not done: resuming an interrupted transfer; dropping folders.

### SSH and the Tools area (this commit)

SSH already had a real PTY terminal (xterm.js, `xterm-256color`, resize,
Ctrl+C), several sessions, host-key approval, an SSH-agent option and
redacted output. Fixed and added:

- **Bug:** with no sessions the session strip showed two "New Session"
  tabs (one inert). Now one, saying what to do next.
- **Saved connections by computer:** profiles were filtered to the
  selected computer, so a server saved for another computer was invisible
  ("No profiles configured"). A Saved connections list now shows every
  saved server under its computer (selected one first, no credentials).
  Use fills the pickers; for another computer, Switch selects that
  computer first (the SSH service only connects a profile from the
  selected computer, which stays enforced). Nothing connects by itself.
- **Handshake time:** the status bar shows how long the TCP connection and
  SSH handshake took for the active session, from the SSH service's own
  stage timings (no extra probe).
- Game-server consoles, administrative SSH and the read-only monitoring
  credentials stay separate; nothing here gives a monitoring connection a
  shell.

Navigation:

- The eight technical pages (Console, Task details, Docker, Files,
  Network, SSH, Agent Control, Maintenance) are now one **Tools** group,
  always in the sidebar and collapsed by default, instead of being hidden
  until Settings > Advanced Mode was found. Advanced Mode still adds
  technical detail. Pages joined to Computers, Sharing and Activity by
  tabs keep highlighting their parent while Tools is closed, so switching
  tabs never pops the group open.

Tests: `phase8-ui-qa` P9; `sidebar-navigation-groups-ui-qa` 7/7 (updated
for the visible Tools group); `simple-ui-screenshots-qa` 8/8 (updated for
the new Network section); SSH smokes pass.

Not verified in the app here: typing into a live terminal (this worktree
has no `node_modules`, so xterm.js does not load in its test runs; the
service is covered by `ssh-interactive-session-smoke` against an
in-process SSH server).

### P8-G Remaining polish (this commit)

- The title-bar status chip names what it is about: "OVH: Connected",
  "SSH: no session", "Files: open", "Playit: …", "AMP: …". It used to show
  a bare "Connected" on most pages (several hard-coded it, two page cases
  were unreachable duplicates) and stayed green on My Servers while the
  list was stale; there it now reads "OVH: last known list".

Tests: `phase8-ui-qa` P1 and P6 check the chip; node-state consistency,
node-status classification and UI polish smokes pass.

## P8-H Stabilization and handoff

Commits (local, nothing pushed): `ae816e2b` network telemetry and SSH
privacy fix, `f52721c0` players, `d7596482` My Servers, `f112f412` Docker,
`5c03f585` Files, `665241e3` SSH and Tools, `4501adc9` title-bar chip,
`21cc1434` sign-in hook fix, plus this documentation commit.

Validation (all executed, all passing at the end):

- `node scripts/release-validation.js --tier=feature`: 112 checks. The
  first run stopped on `server-sign-in-smoke`: sorting had renamed a
  parameter that test pins in the source; fixed in `21cc1434`, rerun clean.
- `phase8-ui-qa` 9/9 in the real app: network section and check, SSH
  starts empty, default-page names, players, My Servers sort, bulk
  actions and stale state, Docker sections, Files drop upload, SSH saved
  connections, title-bar chip.
- New smokes: `network-details-smoke` 8, `player-monitor-smoke` 8,
  `files-drop-upload-smoke` 5 (all in both validation tiers).
- Existing UI tests rerun: server view 9/9, instances layout 4/4,
  instances refresh 4/4, sidebar groups 7/7, simple UI 8/8, files layout,
  mobile widths (45 checks, 0 failures; it also reports the two missing
  xterm files below).
- `git diff --check` clean for every commit.

Environment limits (not product failures): this worktree has no
`node_modules`, so xterm.js does not load in its UI test runs (two
"file not found" console errors that also appear on the unchanged code;
`responsive-mobile-ui-qa` and `service-managed-ui-qa` count them as
renderer errors). Docker Desktop is stopped on this PC and was not started.

### Phase 8 acceptance

| Goal | State |
| --- | --- |
| Reliable server lifecycle | Existing services; bulk actions use the same path; stale state fixed |
| Docker management | Page reorganised on the existing backend; live daemon not tested here |
| Safe local/remote files | Drag-and-drop, byte for byte, atomic, no silent overwrite |
| Agent telemetry | Per-adapter network data on Agents and this PC |
| Network diagnostics | Router / name lookup / internet check, on request |
| Real player information | Minecraft, FiveM, Palworld, Valheim, Rust, CS2 |
| Real player ping | FiveM and Palworld (server-reported); "Not supported" elsewhere |
| No redesign of accepted work | Home, Computers, server pages, AnxNet, Phone kept; one Network section and the Players panel added |
| No fabricated data | Unknown values stay "Not reported"/"Not supported" |

### Not done or not verified

- Live checks on real hardware: Docker against a running daemon, an SFTP
  drop upload, typing in a live SSH terminal, players on a real FiveM or
  Palworld server, network telemetry on Anxlab's Linux Agent. Anxlab runs
  live servers and its Agent was not updated (an Agent update stops its
  servers; needs your approval and a quiet moment).
- AMD/Intel GPU usage (still NVIDIA only; others report "unavailable").
- One My Servers list across several computers; server grouping.
- Resuming interrupted transfers; dropping folders.
- Phase 7.1 items still open: real iPhone test, public internet/VPS
  relay, the Windows DNS rule, AnxNet inside Anxlab's Agent.
