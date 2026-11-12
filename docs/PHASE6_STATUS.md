# Phase 6 status: AnxNet

Handover for the next development agent, 2026-11-12, branch
`claude/anxos-control-center-simplify-8080f1`. No AI features. Nothing is
pushed, released or deployed. Design and threat model:
[ANXNET_ARCHITECTURE.md](ANXNET_ARCHITECTURE.md).

## Commits

| Commit | What |
| --- | --- |
| `250b4b7a`, `aae3b0ef`, `4f3c66d5` | Phase 5 checkpoint (add-ons, server pages, docs) |
| `9c91ec7a` | AnxNet core: identities, signed roster, invites, coordinator, multiplexer, UDP secure channel, private DNS, relay and gateway edge |
| `0ad350b4` | AnxNet in the app: main-process service, IPC, Computers page, Share dialog, Electron compatibility |
| (this commit) | Measurements, validation registration, status |

## Milestones

| Milestone | State |
| --- | --- |
| P6-A architecture and core | Done |
| P6-B private network | Done and verified on one machine; real two-computer LAN not run (see Blocked) |
| P6-C internet connectivity | Coordination, hole punching and relay are built and verified against emulated NAT on one machine. Real internet P2P is blocked: it needs a reachable coordinator or edge. |
| P6-D public gateway | Built and verified locally with plain TCP/UDP clients. A real public endpoint is blocked: it needs owner infrastructure and approval. |
| P6-E UI integration | Done, verified in the real app |
| P6-F stabilization | Done: regressions, measurements, docs |

## What the app does now

**Computers > AnxNet**
- **Network:** create a network (name like `anx-comet27`, domain
  `anx-comet27.internal`).
- **Invites:** a one-time code that works once and expires in 1 hour. The
  owner approves each new device.
- **Devices:**
  - each device's name, hostname, how it is connected (directly, through
    the relay, or UDP) and measured latency
  - Test a device, remove it, rename the network, or leave the network
- **Shared servers:** the servers shared on the network.
- **Relay and gateway:** settings for the owner's edge server, and a
  "relay only" mode.

**Share dialog**
- **Invite only:** after approval, devices in the network reach the server
  at its AnxNet address.
- **Anyone can join:**
  - Uses the network's AnxNet gateway, after an explicit approval that names
    the gateway and the port.
  - "Friends can join" appears only when a test connection through the
    gateway reached the server.
  - Without a gateway it says what is needed and points to Playit.
- **Playit and Tailscale:** unchanged, still offered below.

**Background**
- **Starts only when used:** nothing listens until the computer is in a
  network.
- **Device key:** encrypted with `safeStorage`.
- **Ports:** listens on `0.0.0.0:47710` so LAN devices can connect directly.
  Windows asks once to allow it through the firewall; AnxOS never changes
  firewall rules itself.

## Evidence

| Test | Kind | What it shows |
| --- | --- | --- |
| `scripts/anxnet-smoke.js` (X1–X10) | Real sockets, one host; NAT emulated | **X1:** names, signatures, invites, management ports. **X2:** enrollment and approval. **X3:** DNS answers, and 600 KB intact over TCP. **X4:** UDP over the multiplexer. **X5:** strangers and disallowed services refused. **X6:** revocation cuts live connections and blocks cached config. **X7:** reconnect after an owner restart. **X8:** hole punching works through cone NAT and fails clearly through symmetric NAT. **X9:** the relay carries only ciphertext (a plaintext marker never crossed it) and cuts revoked devices. **X10:** the gateway serves plain TCP (3 at once) and UDP clients, refuses forged and wrong-gateway grants, and closes ports on unpublish and unshare. **Runs and passes on both Node (OpenSSL) and Electron's Node (BoringSSL).** |
| `scripts/anxnet-ui-qa.js` (U1–U6) | Real Electron app, real Agent, real sockets | **U1:** create from the UI. **U2:** invite, approval, connected directly. **U3:** Invite only reaches the server. **U4:** Anyone can join: a plain client reached the server through the gateway; "Friends can join" shown only after the test; turning it off closed the port. **U5:** removal cuts access. **U6:** no renderer errors. |
| `scripts/anxnet-perf.js` | Two separate OS processes, loopback | Numbers below |
| Permission matrix | Unit | 18 new channels: status at `public-access:read`; the rest owner-only `instance:write`, audited |

## Measured (this PC, loopback, separate processes)

AMD Ryzen 5 5600X, Windows 11, Node 24. Loopback shows AnxNet's own
overhead only, not internet latency.

| | Direct | Through AnxNet |
| --- | --- | --- |
| Peer session set-up | | 4.6 ms |
| TCP round trip (median / p95) | 0.066 / 0.134 ms | 0.317 / 0.500 ms |
| TCP throughput (64 MB) | 696 MB/s | 148 MB/s |
| UDP round trip (median / p95) | | 0.396 / 0.673 ms |
| Idle CPU over 10 s | | 0.00 % per node |
| Memory | | ~70 MB per standalone node process; in the app it shares the main process |

## Acceptance tests (from the brief)

| # | Test | Result |
| --- | --- | --- |
| 1 | Network without a domain | Real (in-app U1) |
| 2 | Unique private hostnames | Real (X1, X2, U1) |
| 3 | Enroll through approved invitation | Real (U2, X2) |
| 4 | Encrypted communication between two computers | Real between separate processes on one computer (X3, perf). A second physical computer was not used. |
| 5 | Resolve and reach AnxNet addresses | Real through the AnxNet resolver (X3). OS DNS integration is not done (blocked). |
| 6 | Revoke and confirm access removed | Real (X6, U5) |
| 7 | Recover after interruption | Real (X7) |
| 8 | Direct internet P2P | **Blocked:** no second network or reachable coordinator. Hole punching verified only against emulated NAT (X8). |
| 9 | Relay when direct fails | Real relay on loopback (X9). A device in relay-only mode stands in for an unreachable one. |
| 10 | Minecraft server for invited clients | A stand-in Minecraft server was reached by an invited device (U3). No real Minecraft client was used. |
| 11 | TCP through a test gateway | Real on loopback (X10, U4) |
| 12 | UDP through a test gateway | Real on loopback (X10) |
| 13 | Ordinary client through a real public endpoint | **Blocked:** needs a public server and approval |
| 14 | Unauthorized devices can't reach services | Real (X5, X6, X9) |
| 15 | Public exposure needs approval | Real (U4; owner-signed grant, X10) |
| 16 | Management ports never exposed | Real (X1; Share guard reused) |
| 17 | Turning sharing off removes routes | Real (X10, U4) |
| 18 | Playit and Tailscale preserved | Unchanged code paths; Share and UI tests pass |
| 19 | Offline, stale and failed states | Coordinator states (connected, reconnecting, removed, pending) and per-device connection errors (X6, X7). Devices not currently connected show "Not connected right now". |
| 20 | Existing server management works | Regression runs below |

## Regressions run in Phase 6

- `npm run qa:feature` (now with `anxnet-smoke`), `permission-matrix-smoke`.
- Real-app UI tests: `simple-ui-screenshots-qa`, `server-view-ui-qa`,
  `instances-layout-ui-qa`, `anxnet-ui-qa`.

Results, all passing:
- `qa:feature`: 105 checks
- `permission-matrix-smoke`: 77 desktop families, 387 channels
- `simple-ui-screenshots-qa`: 8 checks
- `server-view-ui-qa`: 9 checks
- `instances-layout-ui-qa`: 4 checks
- `anxnet-ui-qa`: 6 checks
- `anxnet-smoke`: 10 checks, on both Node and Electron

## Blocked: needs hardware, infrastructure or approval

- **A second computer on a real LAN.** Your fleet computers are production,
  so they weren't touched.
- **Real internet P2P and real NAT.** Needs two networks and a reachable
  coordinator: the owner's edge on a public server.
- **A public gateway.** It means running `src/anxnet/bin/anxnet-edge.js` on
  an owner server (for example the VPS) with a public port range. That needs
  deployment approval and firewall changes on that server.
- **OS DNS integration for `.internal`.** Windows NRPT or systemd-resolved
  changes need elevation, which needs an approved, signed helper.
- **Kernel WireGuard / a virtual interface.** Same reason.
- **AnxNet inside the Agent**, so servers on remote computers can be shared
  from their own computer. Needs the next Agent build and its approval.

## Known limits

- **Remote servers.** The desktop's AnxNet can share servers running on this
  computer or one it can reach on its network. A server on a remote Agent
  needs AnxNet on that computer (Agent build).
- **TCP between devices behind NAT** goes through the relay. Hole punching
  only carries UDP services; TCP over UDP needs a userspace transport.
- **Anyone can join** requires the network owner, who signs the gateway
  grant.
- **Owner offline.** When the owner's computer is offline, new devices can't
  join and roster updates wait. Existing members keep direct connections
  they can make.
- **The in-app public route test** runs from this computer through the
  gateway. A friend's own network could still block them.
