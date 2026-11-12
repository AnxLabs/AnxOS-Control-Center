# Phase 7 status: phone companion (mobile adaptation)

Last update: 2026-11-12. Builds on the Phase 6.1 checkpoint (`27f62a1f`).
Implementation commit: `6dec0139` (local, not pushed).
Plan and architecture: [PHASE7_MOBILE_PLAN.md](PHASE7_MOBILE_PLAN.md).

## What exists now

AnxOS has a phone app: an installable web app (PWA) served by the desktop
app itself over HTTPS on the home network. It talks to a small, fixed API
in the desktop's main process, which calls the same services the desktop
uses. There is no second backend, no cloud service and no store app.

- **Turn it on:** Security > Devices > Phone Access > Turn on. It is off by
  default and stays off until the owner turns it on.
- **Trust:** AnxOS creates its own local certificate authority (ECDSA P-256).
  You install its certificate on the phone once; the gateway's certificate
  covers this computer's addresses and is renewed automatically.
- **Pair:** choose Viewer, Operator or Owner, scan the QR code. The code works
  once, for 5 minutes. Each paired phone is listed with its role and last
  use, and can be removed at once.
- **Use:** Home, Servers, Computers, Sharing, More, and each server's six
  tabs (Overview, Console, Files, Add-ons, Backups, Settings).

## Milestones

| Milestone | Result |
| --- | --- |
| P7-A Foundation | Local CA and certificates, HTTPS gateway, pairing, sessions, revocation, role checks, read-only shell. Done. |
| P7-B Home, Servers, Computers | Same rules as the desktop (`homeDashboardModel`): live / stale / unavailable readings, sustained-pressure warnings, attention list. Done. |
| P7-C Lifecycle, console, settings, files | Start, stop (with confirmation), restart; console with commands; four safe settings with conflict check; files with binary-safe upload, text view and edit, new folder, rename, delete with confirmation. Done. |
| P7-D Add-ons and backups | Search, plan with dependencies, approved install, update, turn off, roll back, remove; backup now (whole server or world), check, restore with preview and typed RESTORE, download. Done. |
| P7-E/F AnxNet, PWA, polish | Sharing tab shows what this computer's AnxNet node reports. Manifest, shell-only service worker, offline state, in-app alerts. Done. |
| P7-G Verification and handoff | Gateway security smoke (20 checks), phone end to end in emulated phones (17 checks), desktop regressions. This document. |

## Components

| File | Role |
| --- | --- |
| `src/mobile/localCa.js` | Local CA and gateway certificate (DER built by hand, ECDSA P-256 / SHA-256, SAN for this computer's addresses, 397-day leaf, renewed when addresses change or within 30 days of expiry). Addresses are ranked so the home-network adapter comes before VPN and virtual adapters. |
| `src/mobile/sessions.js` | Pairing codes (128-bit, 5 min, single use, memory only), device sessions (256-bit token, stored as SHA-256 only, 14 days idle / 90 days max), CSRF tokens (HMAC), revocation. |
| `src/mobile/api.js` | The route table. Each route = one permission tier + one call into `serviceRouter`, `modManagerService`, `nodeService`, `systemService` or `anxnetService`. Projects responses to what the phone shows. |
| `src/mobile/gateway.js` | HTTPS server: private-address check, Host check, cookie + CSRF + Origin + JSON checks, rate limits, strict CSP and security headers, static app allowlist, no CORS. |
| `src/services/mobileGatewayService.js` | On/off, pairing links and QR, device list, CA export; resumes at app start only if left on. |
| `src/ipc/mobileGatewayIpc.js` | `mobile:*` channels: status is `settings:read`; everything else is owner-only and audited. |
| `src/renderer/phoneAccessPanel.js` | The desktop Phone Access section. |
| `src/mobile/web/` | The phone app: `index.html`, `app.css`, `app.js` (no framework), `manifest.webmanifest`, `sw.js`. |
| `assets/icons/png/192x192.png`, `180x180.png` | PWA and Apple touch icons, downscaled from the 512 px icon. |

Shared rule modules reused unchanged on both sides: `homeDashboardModel.js`,
`serverViewModel.js`, `restorePreview.js`, `redaction.js`.

## Security model

- **Two checks on every request.** The phone's role (from pairing) must
  include the route's permission tier, **and** the computer's own AnxOS
  session must allow it (`requirePermission`). So a phone never does more than
  the person signed in on the computer, and nothing works while AnxOS is
  locked there (the phone shows "locked on the computer"). Phone access is
  refused entirely until AnxOS security (an owner account) is set up.
- **Roles.** Viewer: read only. Operator: also start, stop, restart, check
  backups. Owner: also console commands, settings, files, add-ons, backup
  create, restore and download. Same tier names as the desktop
  (`ROLE_PERMISSIONS`).
- **Not reachable from a phone, whatever the role:** SSH, Docker, arbitrary
  commands on the computer, a server's executable / arguments / working
  folder / environment values, Agent tokens, node credentials, Agent URLs,
  deleting servers. Those routes don't exist; settings accept only name,
  memory, auto-start and restart policy.
- **Browser protections.** Cookie `__Host-anxos-session` (HttpOnly, Secure,
  SameSite=Strict, no Domain). Changes need the `X-AnxOS-CSRF` header, a
  same-origin `Origin` and a JSON body. No CORS headers. CSP
  `default-src 'none'` with `script-src 'self'`. API responses `no-store`.
  The service worker caches only the app shell, never API data.
- **Network.** HTTPS only. Requests from public internet addresses are
  dropped (accepted: RFC 1918, loopback, link-local, 100.64/10, IPv6 ULA and
  link-local). Unknown Host headers are refused (DNS rebinding). AnxOS never
  opens router ports or firewall rules for this.
- **Pairing.** The code is in the URL fragment, so it isn't sent in the
  request line; the page removes it from the address bar at once. Wrong codes
  are rate limited (10 per 5 minutes per address).
- **Audit.** Phone actions are written to the existing audit log with
  `mobile:<deviceId>` as the reason; denials as `mobile.permission`.

## Verification

All commands run on Windows 11 in this worktree.

| Command | Result |
| --- | --- |
| `node scripts/mobile-gateway-smoke.js` | Passed, 20 checks (G1–G20 below). |
| `node scripts/mobile-ui-qa.js` | Passed, 17 checks (M1–M17 below). |
| `node scripts/permission-matrix-smoke.js` | Passed: 78 desktop families (399 channels), 42 Agent REST families. |
| `npm run qa:feature` | Passed, 108 checks (Phase 6.1 had 107; `mobile-gateway-smoke` added to both tiers). Includes `git diff --check`. |
| `node scripts/server-view-ui-qa.js` | Passed, 9 checks (desktop server page, Phase 5). |
| `node scripts/anxnet-ui-qa.js` | Passed, 7 checks (desktop AnxNet, Phase 6.1). |
| `git diff --check` | Clean. |

**Gateway smoke (plain Node, fake services):** G1 TLS chain verifies with only
the AnxOS CA, default trust refuses it · G2 CSP and security headers, no CORS,
shared-module allowlist, path traversal refused, CA download · G3 unknown Host
refused · G4 no session → nothing · G5 wrong / cross-origin / reused / expired
codes refused, cookie flags, token hashed at rest · G6 pairing rate limit ·
G7 capabilities per role · G8 Viewer can't act (audited, services untouched) ·
G9 Operator lifecycle only · G10 CSRF + Origin + JSON required, one console
line per command · G11 settings whitelist and validation · G12 computer
locked → 423, security not set up → 503 · G13 revocation · G14 idle expiry ·
G15 binary upload byte for byte · G16 delete needs the exact path, restore
needs RESTORE · G17 private vs public source addresses · G18 no secrets,
paths, commands or Agent URLs in any response · G19 oversized bodies refused ·
G20 desktop service on/off, pairing link redeemed, port closed when off.

**Phone end to end (real Electron app, real Agent with a stand-in Minecraft
server, Microsoft Edge with phone emulation at 412×915 and 390×844, trusting
only the gateway key):**

| # | Acceptance requirement | Evidence |
| --- | --- | --- |
| 1 | Home accuracy | M2: servers tile = Agent's own count; computers tile = what is actually reachable (see note below). |
| 2 | No horizontal overflow | M3: 360 / 375 / 412 / 430 px, five sections and all six server tabs. |
| 3 | Narrow server Overview | M3 at 360 px; screenshots 03/04. |
| 4 | Start / stop / restart through existing operations | M4, M10 (Agent state checked); G9 (same `serviceRouter` calls). |
| 5 | Console | M5: command reached the server; its answer streamed in. |
| 6 | Binary uploads | M7 (40 KB on the server's disk, identical); G15. |
| 7 | Settings safety | M6 (invalid refused, valid saved, stale save refused); G11. |
| 8 | Add-ons | M8: search, plan with dependency, approved install of verified files. |
| 9 | Backup preview and restore confirmation | M9 (preview, RESTORE required, Cancel changes nothing); G16. |
| 10 | Live / stale / unavailable data | M13 (banner with the data's age); rules shared with the desktop; values hidden after 5 minutes without contact. |
| 11 | Unauthenticated clients blocked | G4, G5. |
| 12 | Read-only users blocked from privileged actions | M11 (UI disabled and direct API call refused); G8. |
| 13 | Revocable sessions | M12 (removed on the desktop → phone loses access); G13, G14. |
| 14 | Network loss and reconnect | M13. |
| 15 | Closing the phone doesn't affect servers | M15 (server still running 5 s after the browser closed). |
| 16 | Desktop regressions | Feature tier 108/108, permission matrix, M17 (no desktop renderer errors), server-page and AnxNet UI tests. |
| 17 | PWA install | M16: manifest valid, service worker registered; Chrome's installability check reports only "in-incognito" (the test browser's private profile). A real home-screen install was not performed. |
| 18 | Honest AnxNet status | Sharing shows only what the node reports; public addresses are described as set up, not as reachable, and the phone never tests them. |

Also checked: M14 locking AnxOS on the computer blocks the phone and unlocking
restores it; M17 no page errors or CSP violations in the phone app.

Screenshots from the last run (desktop Phone Access, phone Home, server
running, console, settings conflict, files, add-on plan, restore preview,
Viewer, offline, locked, stop confirmation) are written by the test to a
temporary folder it prints; they are not committed.

**Note on Home accuracy.** In the isolated test profile the desktop's own Home
showed "0 of 2 online" for the reachable test computer until its node list
was refreshed (then "1 of 2", matching the phone). The phone runs the same
health check the fleet summary uses before reporting a computer, so it does
not depend on that refresh. The desktop behaviour predates Phase 7 and was
not changed here.

## Not done, and why

- **Real phones.** Nothing was run on a physical iPhone or Android phone.
  Everything above is desktop Edge with phone emulation. Not verified:
  installing the certificate on iOS / Android, Safari's handling of the
  service worker and home-screen install, real touch, and reaching the
  gateway from another device over Wi-Fi (the tests connect over loopback on
  this computer).
- **Firewall.** On Windows, the first time Phone Access listens on the LAN,
  Windows may ask whether to allow AnxOS through the firewall. AnxOS doesn't
  change firewall rules itself; that choice stays with the owner. Automated
  tests listen on loopback only.
- **SSH on the phone.** Deferred: it needs an interactive terminal bridge, a
  new shell surface; the SSH model is unchanged.
- **Push notifications.** No delivery service exists; alerts show only while
  the app is open, and the app says so.
- **Access from outside the home network.** Needs AnxNet on the phone or
  another approved path; the LAN gateway is never published.
- **Store builds.** None, by design.
- **File downloads.** Text files up to 1 MB can be viewed and edited; binary
  files can be uploaded but not downloaded from the phone (the existing file
  read service returns text only). Backups can be downloaded.
- **Biometric unlock.** Not added. Device sessions are the server-side check;
  a biometric gate would only be a local convenience and was left out rather
  than invent one.

## Handoff

1. Try it on a real phone: Security > Phone Access > Turn on, install the
   certificate (step 1 on that page), pair as Viewer first, then as Owner.
   Report anything that differs on iOS or Android.
2. If Windows asks about the firewall when Phone Access starts, allow it on
   private networks only.
3. Re-run `node scripts/mobile-ui-qa.js` after changes to the phone app or the
   gateway; it needs Microsoft Edge installed.
