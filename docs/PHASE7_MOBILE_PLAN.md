# Phase 7: mobile companion, plan and architecture

Last update: 2026-11-12. This continues from the Phase 6.1 checkpoint
(`27f62a1f`).

## Audit

| Area | Found | Decision |
| --- | --- | --- |
| Earlier mobile app | `../AnxOS-Control-Center-Mobile`: a recovered Expo export (Hermes bytecode; source partly lost) plus a separate Python "controller adapter" backend. The desktop's `mobilePairingService` hands an Agent token to that app. | **Not reused.** It is a second backend with its own server logic, and it gave the phone a full Agent credential. The Phase 7 brief rules out a duplicate backend, and the phone should never hold an Agent token. That repository stays untouched. |
| Desktop renderer | `app.js` (about 50k lines) talks to the main process only through `window.anx` (preload / IPC). | It can't run in a phone browser. The mobile UI is a small separate front end. It **reuses the shared rule modules** (`serverViewModel`, `homeDashboardModel`, `shareHealth`) and the AnxOS visual language. |
| Business logic | Main-process services: `serviceRouter` (instances, files, logs, lifecycle, backups), `modManagerService`, `systemService`, `fleetService`, `nodeService`, `anxnetService`. The IPC handlers are thin permission wrappers around them. | The mobile gateway calls **the same services**, behind its own permission checks with the same tier names. No logic is duplicated. |
| Permissions | `securityService.ROLE_PERMISSIONS`: Owner (`*`), Admin, Operator, Viewer, each with the same tier names the IPC uses (`instance:read`, `instance:lifecycle`, `instance:write`, `files:write`, `backups:*`...). | Each paired phone gets a role: **Viewer** (monitor only), **Operator** (start, stop, restart, console reading), or **Owner** (everything the gateway offers). Pairing never grants more than the owner chose. |
| Agent credentials | Saved node credentials decrypt only while AnxOS is unlocked. | Phone access works while AnxOS is running on the computer. When AnxOS is locked, the phone says so plainly. |
| Browser security | Service workers, PWA install, passkeys and `Secure` cookies need HTTPS or localhost. | The gateway serves HTTPS on the LAN with **a certificate from AnxOS's own local certificate authority**, which you install on the phone once (homelab style; no domain, no cloud). There is no plain-HTTP mode. |

## Shape

```
 phone browser / installed PWA ──HTTPS (AnxOS local CA)──► AnxOS mobile gateway (desktop main process, off by default)
                                                           │  session cookie + CSRF header + Origin check
                                                           │  role → permission tier (ROLE_PERMISSIONS)
                                                           ▼
                                   serviceRouter / modManagerService / backups / systemService / anxnetService
                                                           ▼
                                                  Agents (unchanged, never exposed)
```

- **The gateway** (`src/mobile/gateway.js`) is off until the owner turns on
  Phone access. It listens on the LAN with HTTPS only. Agent, SSH and Docker
  endpoints are never exposed; the phone only sees the gateway's own small
  API.
- **Pairing.**
  - The desktop shows a QR code with a one-time code: 128 bits, 5 minutes,
    single use, and a chosen role.
  - The code sits in the URL fragment, so it never crosses the network
    unencrypted.
  - The phone redeems it over HTTPS for a device session: a random 256-bit
    token stored only as a hash. It ends after 14 days without use, or 90
    days after pairing at the latest.
  - Devices are listed on the desktop and can be revoked instantly.
- **Requests.**
  - The cookie is `HttpOnly`, `Secure`, `SameSite=Strict`.
  - Every change also needs the `X-AnxOS-CSRF` header and a same-origin
    `Origin`.
  - There are no CORS headers, a strict CSP, `no-store` on API responses, and
    rate limits on pairing.
- **Interface** (`src/mobile/web/`, no framework).
  - Bottom navigation: Home, Servers, Computers, Sharing, More.
  - Server page with the six Phase 5 tabs.
  - Sheets for confirmations.
  - Polls only while visible, and less often for background data.
- **PWA.**
  - A manifest and a service worker that caches **only the app shell**
    (HTML, CSS, JS, icons), never API responses.
  - Offline, it shows a "can't reach AnxOS" screen.

## Not in this phase, and why

- **SSH terminal on the phone.** It needs a streaming terminal bridge over
  the LAN, which is a new interactive-shell surface. It stays desktop-only
  for now, so the SSH security model is untouched.
- **Remote push notifications.** There is no delivery service; the brief
  says not to promise them. Phase 7 has in-app alerts while the app is open.
- **Access from outside the home network.** This needs AnxNet on the phone
  or an approved remote path. The plain LAN gateway is never published to
  the internet.
- **App Store / Play Store builds.** Not without approval.

## Milestones

| Milestone | Content |
| --- | --- |
| P7-A | Gateway, CA and certificates, pairing, sessions, permissions, read-only shell |
| P7-B | Home, Servers, Computers |
| P7-C | Lifecycle, console, settings, files |
| P7-D | Add-ons, backups |
| P7-E/F | AnxNet status, PWA, alerts, polish |
| P7-G | Tests (gateway security, mobile UI in emulated phones), desktop regressions, handoff |
