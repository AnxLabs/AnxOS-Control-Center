# AnxNet security review (Phase 6.1)

This is an internal review of the code in `src/anxnet` (2026-11-12) by the
development agent. It is **not** an independent audit. AnxNet's UDP channel
is a protocol written for AnxOS from standard primitives. Treat it as
unaudited until a qualified reviewer has looked at it.

Severity is for AnxNet as built: private networks between invited devices,
and an optional owner-run edge.

## Fixed in Phase 6.1

The fixes are covered by `scripts/anxnet-smoke.js` X11 unless another test is
named.

| # | Area | Finding | Severity | Fix |
| --- | --- | --- | --- | --- |
| F1 | UDP channel | **Hello replay.** Hellos had no freshness and no key confirmation. A captured signed hello replayed from another address could make the receiver send UDP game traffic there. The attacker can't decrypt it, but the traffic is lost (redirect / denial of service). | Medium | The signed transcript now includes a timestamp, and hellos older than 60 s are refused. A session carries data only after the peer sent an authenticated packet with its keys (key confirmation). A session built from a replay is never confirmed. |
| F2 | UDP channel | **No rekeying.** A session past its rekey limit (10 min or 2^32 packets) stayed in place unused, so no fresh key exchange ever happened. | Low | The session is dropped, and the next use punches again with new keys. |
| F3 | Multiplexer | **Stream id reuse.** A peer could reuse a live stream id in OPEN. The first connection to the service then leaked (stayed open, untracked). | Low | An OPEN for an id in use is refused with CLOSE. |
| F4 | Services | **Proxy abuse.** A member could share a "service" pointing at any host, including internet hosts, turning other members' traffic into a proxy through that device. | Medium | Targets must be loopback or private IPv4 literals: 10/8, 172.16/12, 192.168/16, 100.64/10 or 127/8. Hostnames and public addresses are refused. |
| F5 | Coordinator | **No abuse limits.** No request rate limit on members' control sessions, no per-device service cap (each change re-signs and pushes the roster to everyone), and no throttle on wrong invite codes. | Medium | 20 requests/s per session (burst 40); 20 services per member; after 10 wrong invite codes in a minute from one address, that address is refused for the rest of the minute. |
| F6 | Edge | **Stale revocations.** The edge learned about revocations only when some member reconnected. | Medium | The owner's node keeps a link to every configured relay and gateway, and pushes each new roster to it. |
| F7 | Edge | **Long-lived grants.** Gateway grants lasted 30 days and were checked only when a route opened. | Low | Grants last 7 days, re-signed when AnxOS reopens a route. The edge closes routes whose grant has expired (sweep every 30 s). |
| F8 | Node and edge | **No global connection caps.** There was no cap on simultaneous TLS connections. | Low | Node: 256. Edge: 1024. |
| F9 | Electron | **Runtime differences.** Electron's BoringSSL needs explicit `sigalgs` for Ed25519 TLS and doesn't expose ChaCha20-Poly1305. | Compatibility (fixed in Phase 6) | Explicit sigalgs; the UDP channel uses AES-256-GCM. The smoke runs on both Node and Electron's Node. |
| F10 | Background host | **New local control surface.** The host is controlled over a local pipe. | Design | A 32-byte random token in a file only the user can read; constant-time comparison; an allowlist of methods; at most 8 clients and 128 KB per request. A wrong token is refused (`anxnet-host-smoke` H4). |

## Reviewed, no change needed

- **Peer identity.**
  - TLS 1.3 with self-signed Ed25519 certificates. Trust comes only from the
    certificate key matching a non-revoked device in the owner-signed roster.
  - Clients verify before sending anything; servers verify before reading
    anything except the first line.
  - Certificate expiry and names aren't used, by design.
- **Rosters.**
  - Signature from the pinned owner key; version must increase (no
    rollback).
  - A damaged state file is discarded, not trusted.
- **Invites.**
  - 128-bit secrets, stored as SHA-256 hashes, compared in constant time.
  - Expiring, single use by default, revocable; owner approval unless
    pre-approved.
  - The invite pins the owner's key fingerprint, so a fake coordinator is
    refused.
- **Revocation.**
  - Live sessions are closed, new handshakes refused, and forwards removed;
    edges are told (X6, X9).
  - A member that was offline during the revocation keeps its old roster
    until it reconnects. Other members refuse it as soon as they hold the
    newer roster.
- **Parsing.**
  - Frames are at most 64 KB and the reader holds at most one frame.
  - Control lines are capped at 256 KB (512 KB at the edge).
  - DNS answers only loopback clients and its own domain, never recursing.
  - The UDP control packet parser rejects anything malformed.
- **Resources.**
  - Per-peer stream cap (512), per-service UDP flow cap (256) with idle
    expiry, pending-device cap (20).
  - Relay and gateway session, flow and bandwidth limits; bounded write
    queues.
- **Public exposure.**
  - Gateway routes need an owner-signed grant for that exact gateway,
    service, protocol and validity period.
  - Management ports are refused at the roster and again at the edge.
  - The UI asks first and says "Friends can join" only after a real test.
    For Minecraft that is a status reply through the gateway.
- **Secrets in logs.** Keys, tokens, invite secrets and rosters are never
  logged. The host log records codes only.

## Known weaknesses (accepted for now, documented)

1. **Custom UDP protocol.** The signed-ephemeral X25519 exchange uses standard
   primitives (X25519, Ed25519, HKDF-SHA256, AES-256-GCM), but the protocol
   around them is AnxOS's own.
   - Recommendation: move the UDP data plane to **WireGuard** (wireguard-go
     with a userspace netstack, which needs no admin rights) or **QUIC** from
     a mature library, keeping AnxNet's roster and enrollment.
   - This also removes the TCP-over-relay limitation for devices behind NAT.
2. **Owner key.** The owner's key is a single point of trust, with no key
   rotation or recovery. Losing it means creating a new network.
3. **Owner offline.** While the owner's computer is offline, nobody can join
   and roster changes can't spread. Existing members keep working with what
   they know.
4. **Local pipe access.** On Windows the pipe uses Windows' default access
   control. Another local account could connect but can't act without the
   token, which lives in the user's own profile folder.
5. **Hole punching** is only tested against emulated NAT. Real home routers
   and CGNAT may behave differently (see the status document).
6. **TLS handshake cost.** Strangers can still open TLS handshakes to a node's
   port (capped at 256 connections). That costs CPU, not access.
