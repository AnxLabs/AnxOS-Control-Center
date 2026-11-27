# AnxNet infrastructure on anxoscontrolcenter.org (217-D investigation)

**Status: investigation only (Build 217, 2026-11-27).** Nothing here is
built, deployed or configured. No DNS record, public port, gateway or paid
service was added. Each step in "Proposal" needs its own owner approval.

Question from the Build 217 brief: could `net.`, `relay.` and
`edge.anxoscontrolcenter.org` host optional AnxNet infrastructure? And can
AnxNet support configurable DNS suffixes and user-owned domains while keeping
`.internal`, keeping private records out of public DNS, and preserving
encryption, enrollment, isolation and authorization?

## How AnxNet works today (read from the code)

| Part | What it does | Where |
| --- | --- | --- |
| Names | Every network has the private domain `<network>.internal` (for example `anx-frost72.internal`). Devices are `<device>.<network>.internal` and services are `<service>.<device>.<network>.internal`. | `src/anxnet/names.js` |
| Addresses | Each member gets a loopback address `127.77.x.y` from its roster slot. `127.77.0.1` is the node's own resolver. Nothing touches routes or real interfaces. | `src/anxnet/names.js` (`addressForSlot`) |
| Resolver | A small DNS server on `127.77.0.1` answers only for the network's domain (NXDOMAIN inside it, no forwarding). | `src/anxnet/dns.js` |
| OS integration | Windows: one NRPT rule for `.<network>.internal`. Linux: a `systemd-resolved` link `anxnet0` with the routing-only domain `~<network>.internal`. Both apply only to that suffix, and only domains matching `anx-*.internal` are accepted. | `src/anxnet/dnsIntegration.js` |
| Membership | An owner-signed roster lists the devices and services. Every peer checks the owner's signature and the roster version. | `src/anxnet/roster.js`, `identity.js` |
| Transport | Members connect with mutual TLS 1.3, and every peer and edge is **pinned by its key fingerprint**. WebPKI and DNS names play no part in trust. | `src/anxnet/node.js` |
| Edge (optional) | A separate program that a network owner runs on a reachable machine (`src/anxnet/bin/anxnet-edge.js`). **Relay** joins two members' TLS streams and sees only ciphertext. **Gateway** publishes an approved service on a public port, and only with a grant the owner signed for that gateway's fingerprint. The edge serves a static list of up to 32 networks (`networks[]`, each with the owner's public key). It has limits per network and per session, and its config check refuses management ports. | `src/anxnet/edge.js`, `edgeConfig.js` |

Consequences:

- **Private names never leave the machine.** Each node answers
  `.internal` names locally. No AnxNet record is published in any public
  zone, and none needs to be.
- **A public DNS name for an edge is only an address.** Trust comes from the
  fingerprint pinned in the invite or roster, so a hijacked or wrong DNS
  record cannot impersonate an edge. It can only make it unreachable
  (availability, not confidentiality).

## Findings

1. **Hosting a relay or edge under `anxoscontrolcenter.org` needs no code
   change for names.** An owner can already enter any host name for their
   edge. `relay.anxoscontrolcenter.org` would simply be one more address
   with a pinned fingerprint.
2. **An AnxLabs-run shared edge is a different product.** Today's edge
   serves a fixed list of networks that its operator configured. A shared
   edge would have to accept networks dynamically. That needs:
   - an enrollment step that proves the network owner asked for the service;
   - per-network quotas that persist;
   - abuse handling;
   - storage of owner keys.

   None of that exists. Building it is not refinement work.
3. **A public gateway under an AnxLabs domain makes AnxLabs the visible
   origin of game traffic.** Abuse reports, DDoS and port scanning would be
   aimed at AnxLabs' address and domain. That needs:
   - an abuse policy and contact;
   - rate limits at the network edge, not only in the process;
   - logging that respects privacy;
   - a plan for when the edge is down.
4. **`.internal` is hard-coded in three places.** `names.networkDomain`,
   `dnsIntegration`'s domain check (`/^anx-[a-z0-9-]{2,40}\.internal$/`) and
   the resolver's zone come from it. A configurable suffix touches all three,
   as well as the roster (all members must agree on it) and invites.
5. **A user-owned domain can work safely as split-horizon only.** Example:
   `game.example.com` resolved by AnxNet on members' machines. The NRPT and
   `systemd-resolved` rules would claim that suffix locally, exactly as they
   do for `.internal`. The risk is shadowing: claiming a suffix that also has
   real public records hides them on members' machines. So a custom suffix
   must be a subdomain the owner controls and does not use publicly (for
   example `lan.example.com`), never an apex or a public suffix.

## Proposal (each step needs its own approval)

| Step | Scope | Risk | Needs |
| --- | --- | --- | --- |
| P1. Configurable suffix (code) | A network may carry `domainSuffix` in its signed roster, defaulting to `internal`. Old members ignore the field and keep `.internal`, which still resolves, so new names are additions. Validate the suffix: labels only, at least 2 labels for a custom domain, no public suffix and no apex, not `local`, `localhost`, `onion`, `arpa` or `test`. `dnsIntegration` accepts exactly the roster's suffix. | Low; local only. | A Build 218+ item, and a security review of the suffix validation and NRPT/resolved rules. |
| P2. User-owned domain verification (optional) | Before accepting a custom suffix, check a TXT record (`_anxnet.<suffix>` = owner fingerprint) through the public resolver. This proves control without publishing private records. | Low. One public DNS read. | P1. |
| P3. Self-hosted edge under a user's own domain | Already possible. Document it: the edge's public name is only an address, and the fingerprint is the trust. | None. | Docs only. |
| P4. AnxLabs relay at `relay.anxoscontrolcenter.org` (relay only, no gateway) | A ciphertext-only relay with dynamic enrollment: the owner signs a "use this relay" grant, with quotas per network and per device, and the relay fingerprint ships with the app. | Medium. Bandwidth cost and abuse reports, but no public game ports. | Owner approval, a host and cost decision, the enrollment design, a security review, an abuse policy, and the DNS record. |
| P5. AnxLabs gateway at `edge.`/`gw.anxoscontrolcenter.org` | Public game ports on AnxLabs infrastructure. | High. Public attack surface and abuse. | Everything in P4, plus a DDoS posture, port policy and incident process. **Not recommended before P4 has run for a while.** |

Rules for any step:

- **Legacy duties first.** Never shadow or redirect the paths installed apps
  use on `anxoscontrolcenter.org`: `/config.js`, `/release-notes.json`,
  `/api/download/*`, the sign-in pages and the IndexNow key. New services
  live only on their own subdomains.
- **Opt-in.** Self-hosted edges stay first-class, and an AnxLabs relay is
  never the default without the owner's choice.
- **No private record in public DNS**, ever. Only the edge's own A/AAAA
  record would be public.
- **Encryption, enrollment, isolation and authorization stay as they are:**
  end-to-end TLS 1.3 with pinned fingerprints, owner-signed rosters and
  grants, and per-network separation on the edge.

## Abuse and security review (summary)

| Threat | Today | With P4/P5 |
| --- | --- | --- |
| Relay reads traffic | Not possible (inner TLS, pinned peers) | Same |
| Someone uses the relay without being a member | Refused (roster check) | Needs the enrollment grant; refuse unknown networks |
| Bandwidth exhaustion | Per-session and per-network limits in the process | Plus quotas per enrolled network, network-level rate limits and a kill switch |
| Public game port abused (P5) | Only on the owner's own edge | AnxLabs' address receives abuse reports and attacks; needs a DDoS posture |
| DNS hijack of `relay.` | n/a | Availability only: the pinned fingerprint fails, so nothing is impersonated |
| Name shadowing via a custom suffix | n/a (`.internal` only) | Validation in P1; verification in P2 |

**Recommendation:** do P1 to P3 as a normal feature in a later build. Treat
P4 as a separate infrastructure project with its own approval and budget.
Do not do P5 until a relay has run. In Build 217, the change is this
document only.
