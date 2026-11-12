# AnxNet architecture (Phase 6)

AnxNet is AnxLabs' own networking for AnxOS. It covers:
- private networks between your devices
- generated private hostnames
- encrypted peer connections, direct when possible and relayed when not
- an approved public gateway so ordinary game clients can join a server

Playit.gg and Tailscale stay as optional alternatives. Neither is required.

This document records what is built, the design decisions, and what each
part can and cannot do.

## 1. Audit of what existed

| Area | Found | Reuse |
| --- | --- | --- |
| Sharing | Agent Public Access providers: Playit, Tailscale and Cloudflare Tunnel (`publicAccessProviderService`, `providerIntegrationService`). The Share dialog uses `createAccessServiceForInstance`, which holds the management-port guard and the approval step. | AnxNet sharing goes through the same guard (`AnxShareHealth.getManagementPortName`) and the same explicit approval. |
| Tunnels | `nodeTunnelService` runs app-managed SSH tunnels to Agents, bound to loopback, with keepalive and backoff. | The same loopback-only listener rule and the same backoff shape. |
| Identity | The Agent has `deviceIdentityService` (deviceId, installation id, generation) and `enrollmentService` (nonce, scoped enrollment, revocation). | The same ideas: stable device id, short-lived single-use secrets, revocation by generation. |
| Secrets | `secureSessionStore` uses Electron `safeStorage`. | The AnxNet device key is stored through `safeStorage` on the desktop. |
| SSH | Host-key approval, unattended key-only rule, restricted monitoring credentials. | Untouched. AnxNet never uses SSH credentials. |
| Crypto available | Node 24 / OpenSSL 3.5: TLS 1.3, Ed25519, X25519, HKDF, AES-GCM. Electron 43 uses BoringSSL: Ed25519 TLS works only with explicit `sigalgs`, and ChaCha20-Poly1305 isn't exposed. No X.509 builder in direct dependencies. | Used as is; no new dependency. Both runtimes are tested. |
| WireGuard | Not installed. A WireGuard interface needs admin rights and changes OS routing and DNS. | Not used yet; see section 9. |

## 2. Shape

```
           control plane (TLS 1.3, pinned keys)
   ┌──────────────┐◄──────────────────────────►┌──────────────┐
   │ AnxNet node  │      data plane (mux)       │ AnxNet node  │
   │ (owner =     │◄───── direct TLS ──────────►│ (member)     │
   │  coordinator)│◄── UDP secure channel ─────►│              │
   └──────┬───────┘                             └──────┬───────┘
          │            ┌────────────────────┐          │
          └── TLS ────►│ AnxNet edge        │◄── TLS ──┘
                       │  relay  (opaque)   │
   game client ──TCP/UDP► gateway (public)  │
                       └────────────────────┘
```

- **AnxNet node** (`src/anxnet/node.js`)
  - One per device.
  - Hosted in the desktop's main process (`src/services/anxnetService.js`).
    The same module runs headless for tests and, later, inside the Agent.
  - Listens on one TCP port (TLS) and one UDP port.
  - The owner's node is also the network's **coordinator**: enrollment, the
    signed roster, and the endpoint registry.
- **AnxNet edge** (`src/anxnet/edge.js`, CLI `src/anxnet/bin/anxnet-edge.js`)
  - An optional, self-hostable server with two independent roles:
    - **Relay:** joins two peers' byte streams. It carries only end-to-end
      TLS ciphertext.
    - **Gateway:** public TCP/UDP ports forwarded to an approved game
      service.
  - It needs a reachable machine the owner provides.

## 3. Identities

- **Device identity.**
  - An Ed25519 key pair, generated locally and never leaving the device.
  - `deviceId = "dev-" + base32(sha256(publicKey))[0..16]`.
  - The private key is encrypted with Electron `safeStorage` on the desktop,
    or stored in a 0600 file for headless nodes.
- **Network identity.**
  - `networkId = "net-" + base32(16 random bytes)`.
  - The owner's device key signs the roster; members pin that key at
    enrollment.
  - A memorable name such as `anx-frost72` is generated, with a 6-character
    collision tag kept in the identity.
- **Certificates.** Each node presents a self-signed X.509 certificate for
  its Ed25519 key (`src/anxnet/certs.js`, a small DER encoder). Trust never
  comes from the certificate itself: a peer is accepted only when the
  certificate's public key matches a non-revoked device in the
  owner-signed roster.

## 4. Roster, enrollment, revocation (`src/anxnet/roster.js`)

**The roster** is one JSON document, signed by the owner, with a version
that only moves up. It holds:
- devices: id, public key, name, hostname, address, role, permissions
- revoked device ids
- shared services

A node accepts a roster only if it is signed by the pinned owner key and
its version is newer than the one it holds.

**Invitations.**
- 128-bit random secrets, shown once.
- Stored only as a SHA-256 hash, with an expiry (default 1 hour), a use
  limit (default one), and revocable.
- The invite code carries the network id, the owner key fingerprint, the
  coordinator endpoints and the secret.
- A joining device proves it holds its key through the TLS handshake. The
  owner then approves it, or the invite is pre-approved.

**Revocation.**
- The owner bumps the roster with the device in `revoked`, and every
  connected node gets the new roster.
- On every roster update a node closes sessions with any device that is no
  longer allowed. It refuses new handshakes from revoked keys, both on
  direct connections and inside the relay.
- A node that was offline is caught up when it next reaches the coordinator.

**Permissions.**
- Joining a network grants network membership only.
- Admin actions (invite, approve, revoke, rename) are owner-only and checked
  on the coordinator.
- Reaching a service needs the service's `allow` list to include the device
  (`"members"` or explicit ids).
- Membership never grants control of the host: no AnxOS Agent, SSH or
  management access.

## 5. Data plane

- **Direct and relayed TCP.** TLS 1.3 with both sides presenting certificates
  and checked against the roster. Over it runs a small multiplexer
  (`src/anxnet/frames.js`):
  - OPEN, DATA, CLOSE for TCP streams; DGRAM for UDP flows; PING/PONG for
    latency; CTRL for JSON.
  - Frames are bounded (64 KB payload).
  - Each stream has a send window, and sockets are paused when buffers fill.
- **UDP secure channel** (`src/anxnet/secureUdp.js`). Used when two nodes can
  reach each other over UDP (LAN, public IPs, or after hole punching).
  - **Key exchange:** signed ephemeral X25519. Each side signs its ephemeral
    key together with both device ids and the network id, using its
    roster-pinned Ed25519 key.
  - **Keys:** HKDF-SHA256 over the shared secret and the transcript gives one
    AES-256-GCM key per direction. ChaCha20-Poly1305 was the first choice,
    but Electron's BoringSSL doesn't expose it, so AES-GCM is used in both
    runtimes.
  - **Nonces and replay:** a 64-bit counter nonce with a 2048-packet replay
    window.
  - **Rekeying:** after 2^32 packets or 10 minutes.
  - **What it carries:** DGRAM frames, meaning UDP game traffic.
  - **Basis:** established primitives only, in a SIGMA-style signed
    Diffie-Hellman pattern.
- **Service forwarding.**
  - A device shares a named service: host, port, protocol, and who may use
    it.
  - Every other allowed device gets a listener on that device's AnxNet
    address (see section 6) and port, TCP and/or UDP, bound to loopback only.
  - Connections are carried to the host node, which connects only to the
    declared target.
  - Undeclared ports are unreachable, and management ports (22, 2375, 2376,
    3389, 5900, 5985, 5986, 6566) can't be declared.

## 6. Private names and addresses (`src/anxnet/dns.js`)

- **Namespace:** `<network>.internal`, for example `anx-frost72.internal`.
  No domain is bought. `.internal` is reserved for private use (ICANN, 2024).
- **Names:**
  - device names like `mini-pc.anx-frost72.internal`
  - service aliases like `minecraft.mini-pc.anx-frost72.internal`
  - Collisions get a numeric suffix (`desktop-2`).
- **Addresses:**
  - Each device gets an address `127.77.<n>`. It is the same on every
    member, from the device's slot in the roster.
  - All of 127/8 is loopback on Windows and Linux, so connecting to it
    reaches this node's local listener, which tunnels to the real device.
  - No routing table or virtual interface is touched.
- **DNS server:**
  - The node answers A queries for its own network's names, and only for
    devices and services this device may use.
  - It answers nothing else: no recursion and no other domains.
  - It listens on `127.77.0.1:5353` (loopback, unprivileged port).
- **OS integration is not done.** Making Windows or Linux send
  `*.internal` lookups to that resolver needs a scoped rule: a Windows NRPT
  rule for `.anx-<name>.internal`, or a systemd-resolved per-link domain.
  Both need elevation, so they wait for an approved helper; section 9 lists
  them. Until then the app shows the address and port directly (for example
  `127.77.0.3:25565`), and the resolver is used by the app and the tests.

## 7. Coordination, NAT traversal and relay

**Coordination** happens on the owner's node over TLS. Members register:
- their TCP listen endpoints (LAN and any configured public address)
- their UDP endpoint as seen by the coordinator (server-reflexive)

Members can then look up a peer's candidates. The coordinator never carries
peer data, and it is not a mandatory relay.

**Connection order:**
1. direct TLS to each candidate (LAN, then public)
2. UDP hole punching through the coordinator, which sends both sides each
   other's reflexive address and starts simultaneous punch packets; this
   gives a UDP secure channel for UDP services
3. the relay, if the network has one configured
4. otherwise, a clear "no path" error saying which steps failed

**Limits:**
- Attempts are bounded: 3 tries per candidate, exponential backoff capped at
  60 s, and a 10 s handshake timeout.
- Hole punching cannot traverse symmetric NAT, CGNAT that rewrites ports per
  destination, or firewalls that drop unsolicited UDP. AnxNet reports
  "direct path failed" and uses the relay, or says no path exists. It never
  reports a connection that didn't happen.
- Members on unrelated networks need a coordinator both can reach: a public
  IP, a forwarded port, or the owner's edge server. LAN discovery alone
  cannot do this.

**The relay:**
- Authenticates each node with TLS: the node's key must be in a roster
  signed by an owner the relay was configured to serve.
- Pairs two peers by session id and pipes raw bytes. The peers then run
  their own TLS end to end, so the relay sees only ciphertext.
- Enforces per-network session limits, per-session bandwidth (token
  bucket), idle timeouts, and a global connection cap.
- Never starts on a user's computer by itself.

## 8. Public game gateway ("Anyone can join")

The gateway is the edge's second role.

**Setup:**
1. The host's node connects over TLS.
2. It proves its key is in a roster the gateway accepts.
3. It requests a route:
   - protocol: tcp, udp or both
   - the service id
   - a public port from the gateway's allowed range
   - an approval token for that route

**What a route does:**
- Ordinary clients connect to `gateway-ip:port` and need no AnxNet.
- TCP: each inbound connection is announced to the host, which opens a data
  stream to the declared local target.
- UDP: datagrams are keyed by client address into flows with an idle expiry
  and a per-route flow cap.

**Limits:**
- Routes are removed when sharing stops, when the host disconnects (after a
  grace period), or when the gateway stops.
- Per route: connections, flows and bandwidth. The gateway also has a
  global cap.

**Addresses:**
- Public addresses are real `ip:port` pairs. A private `.internal` name is
  never shown as a public address.
- "Friends can join" is shown only when a test connection through the
  gateway reached the game. A running process or open listener is not
  enough.

A host behind CGNAT can only be reached from the internet through a gateway
on a machine with an inbound-reachable address. No local program can
change that.

## 9. Not built, and why

| Item | Why | Needs |
| --- | --- | --- |
| Kernel WireGuard / virtual interface | Admin rights and OS routing changes | Approved, signed helper; owner approval |
| OS DNS integration for `.internal` | NRPT / systemd-resolved changes need elevation | Same helper; restore on disconnect is designed (scoped rule only) |
| TCP over hole-punched UDP | Needs a reliable transport over UDP (userspace TCP) | WireGuard + netstack, or QUIC, later |
| Internet coordinator / relay / gateway | Needs a reachable machine | Owner-provided server and deployment approval |
| AnxNet inside the Agent | Agent build and deployment | Approval of the next Agent build |

## 10. Threats and answers

| Threat | Answer |
| --- | --- |
| Stranger connects to a node | TLS handshake completes, then the peer key must be in the signed roster; otherwise the socket is closed before any frame is read |
| Forged roster | Only the pinned owner key's signature and a higher version are accepted |
| Stolen invite | Hash-only storage, 1 h expiry, single use, revocable, owner approval unless pre-approved |
| Revoked device with cached config | Peers drop and refuse it on the newer roster; the relay and gateway re-check membership on every session |
| Relay reads traffic | It only pipes the peers' inner TLS |
| Exposing unrelated services | Only declared services are reachable; management ports cannot be declared; listeners bind loopback |
| Public exposure by accident | Gateway routes need explicit approval (the same dialog as other sharing) and a route token |
| Resource abuse | Frame and window bounds, connection and flow caps, token-bucket bandwidth, idle expiry |
| Secrets in logs | Keys, invite secrets and tokens are never logged; invite codes are shown once |
