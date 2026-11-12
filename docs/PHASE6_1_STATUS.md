# Phase 6.1 status: AnxNet operational integration and hardening

Handover for the next development agent, 2026-11-12, branch
`claude/anxos-control-center-simplify-8080f1`. It builds on the Phase 6
checkpoint (`9c91ec7a`, `0ad350b4`, `1e937dfd`). No AI features. Nothing is
pushed, released or deployed. No OS DNS, firewall or network settings were
changed on this PC.

See also: [ANXNET_ARCHITECTURE.md](ANXNET_ARCHITECTURE.md),
[ANXNET_SECURITY_REVIEW.md](ANXNET_SECURITY_REVIEW.md),
[PHASE6_STATUS.md](PHASE6_STATUS.md).

## Commits

| Commit | What |
| --- | --- |
| `c27730e5` | AnxNet in its own background process (host, client, readiness with Minecraft status ping) |
| `d518ab03` | Approval-gated OS name lookup for `<network>.internal` (Windows NRPT, Linux systemd-resolved) |
| `94975fc8` | Security review fixes (UDP replay and key confirmation, stream ids, service targets, rate limits, edge revocation and grant expiry, connection caps) |
| `c00138cb` | Multi-server gateway checks, availability in the UI, two-machine test script |
| (this commit) | Status, architecture updates |

## Priority 1: background service. Done, verified locally.

- **Runtime.** `src/anxnet/host.js` runs the AnxNet node in a detached
  process as the signed-in user, never as a system service. AnxOS starts it
  with Electron's own runtime (`ELECTRON_RUN_AS_NODE`), so nothing extra is
  installed.
- **Control.**
  - A local pipe with a random token in a 0600 file and an allowlisted
    method table.
  - One host per data folder; a duplicate exits with code 3.
  - It exits by itself when idle and in no network.
- **Key.** It stays encrypted with `safeStorage` on disk. The desktop
  decrypts it and hands it to the host in memory; the host never writes it.
- **Closing the window.** When AnxOS quits, the host keeps running
  (setting: Keep AnxNet running when AnxOS is closed).
- **Restarts.** On the next start AnxOS reconnects and reopens saved public
  routes with fresh grants.
- **Fallback.** If the host can't start, AnxNet runs inside AnxOS and says
  so.
- **Not done:** starting AnxNet at sign-in (before AnxOS opens). That is a
  persistent per-user setting (a startup entry), left for your approval.
- **Agent embedding:** the host module needs only a data folder and a key,
  so the Agent can run it. That needs a new Agent build, which needs
  approval.

## Priority 2: private DNS. Built; the OS change awaits your approval.

- **Audit.** The resolver answers only loopback clients and its own domain,
  and never recurses.
- **Windows.**
  - NRPT can only send to port 53. A normal user may bind `127.77.0.1:53`
    (verified), so the resolver moves there while name lookup is on.
  - The change is one NRPT rule for `.<network>.internal`, tagged
    `AnxNet <networkId>`.
  - It refuses if another program already handles that namespace (your
    Tailscale rules for `100.x` reverse zones and `ts.net` were seen and left
    alone).
  - Removal touches only AnxNet-tagged rules.
- **Linux.** A systemd-resolved routing-only domain on a dummy link, on port
  5353 (no root needed for the resolver), never a default route.
- **How it is applied.** Only from the UI after a confirmation, through
  UAC / pkexec, then verified with the OS resolver (`dns.lookup`, the same
  path games use). Leaving a network offers to remove the rule.
- **Verified.** Windows' own DNS client (`Resolve-DnsName`, `nslookup`)
  resolves device and service names through AnxNet's resolver on port 53;
  unknown names are "does not exist" and other domains are refused
  (`anxnet-dns-smoke` D5).
- **Not verified:** OS-wide resolution after the NRPT rule. Applying it is a
  system change that needs your approval and a UAC click.

## Priority 3: security review. Done.

See [ANXNET_SECURITY_REVIEW.md](ANXNET_SECURITY_REVIEW.md): 10 findings
(F1–F10), all fixed, and covered by `anxnet-smoke` X11 and
`anxnet-host-smoke` H4.

**Main finding:** the custom UDP channel lacked freshness and key
confirmation, so a replayed hello could redirect UDP traffic. It is fixed
with a signed timestamp plus key confirmation.

**Still true:** AnxNet's UDP protocol is unaudited. The recommended next
step is WireGuard (wireguard-go with a userspace netstack, no admin needed)
or QUIC from a mature library, keeping AnxNet's roster and enrollment.

## Priority 4: real multi-computer test. Blocked on one approval.

- **Candidate.** This PC has an Ubuntu 24.04 WSL2 VM: separate Linux, its
  own network stack, behind its own NAT (`192.168.109.111/20`).
- **What's missing.** It has no Node.js. Running the test needs the official
  Node.js Linux build downloaded into that VM (a temporary folder; nothing
  system-wide). That is a download, so it waits for your OK.
- **Prepared.** `scripts/anxnet-two-machine-test.js` runs as owner on one
  machine and member on the other. It checks enrollment, names, 1 MB over
  TCP, UDP, measured round trip, reconnection after interruption, and
  revocation. Verified with both roles on this PC: 7/7 (loopback).
- **Your other computers** (Anxlab, the VPS) are production and weren't
  touched.

## Priority 5: internet P2P, relay and gateway

- **Multiple servers.** X12: two servers on one gateway, 20 concurrent
  players, no cross-traffic; removing one route leaves the other.
- **Readiness.** "Friends can join" for Minecraft now requires a real Server
  List Ping answer through the gateway (version and players read back).
  Other TCP games get a held-connection test; UDP is reported as
  unconfirmed.
- **Cleanup.** Expired grants close routes (X11); routes close on unshare
  and unpublish (X10, X12).
- **Unchanged.** Real internet P2P and a real public gateway need owner
  infrastructure and approval. Playit and Tailscale are unchanged.

## Priority 6: Control Center

Computers > AnxNet now also shows:
- whether Anyone can join and the relay are available right now, from the
  real link state
- open invites, with Cancel
- names on this computer, on or off
- the background process (pid, memory) and the keep-running setting

Phase 4 Home and the Phase 5 server pages are untouched.

## Evidence

| Test | Kind | Result |
| --- | --- | --- |
| `anxnet-smoke` X1–X12 | Real sockets, one host; NAT emulated | 12/12 on Node; X1–X11 also on Electron's Node |
| `anxnet-host-smoke` H1–H6 | Real detached process | 6/6: window-closed serving, duplicate refused, bad token refused, hard-kill recovery, shutdown, idle 0.00% CPU / 68 MB |
| `anxnet-dns-smoke` D1–D5 | Plans and real Windows DNS client queries | 5/5 (no OS change) |
| `anxnet-ui-qa` U1–U7 | Real app, real Agent | 7/7, including U7: the shared server keeps working after AnxOS quits |
| `anxnet-two-machine-test` | Both roles on this PC | 7/7; the real two-machine run is pending |
| `permission-matrix-smoke` | Unit | 391 channels |
| `qa:feature` | Feature tier | 107 checks passed |

## Blocked: needs your approval or hardware

1. **Download Node.js into the WSL VM** for the two-machine test, or give
   another LAN computer with Node.js 20+.
2. **Apply the NRPT rule on this PC** (one UAC click), to verify OS-wide
   name lookup.
3. **Start AnxNet at sign-in:** a per-user startup entry.
4. **Owner edge on the VPS** (relay and gateway) for real internet P2P and
   public hosting: deployment plus a firewall port range.
5. **A new Agent build with AnxNet embedded,** so servers on other computers
   share from their own computer.
