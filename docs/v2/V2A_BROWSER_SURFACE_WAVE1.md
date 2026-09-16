# V2-A Browser Management Surface — Design Brief (Wave 1)

**Milestone:** V2-A — Shared platform, identity and agent foundation
**Wave:** 1 (design brief only — no code changes, no commits, no pushes)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This brief designs the **authenticated browser management surface** required
by the final V2-A checklist item, separating management availability from the
desktop client while keeping the exposure boundary explicit. It is grounded in
the shipped V2-A foundation so the proposed contract matches reality.

---

## 1. Goal & scope

Roadmap V2-A checklist item this brief serves
(`docs/MASTER_ROADMAP.md:146`):

> **Separate desktop-client availability from persistent service ownership and
> prepare an authenticated browser management surface.**

Acceptance-gate sentence this brief supports (`MASTER_ROADMAP.md:151`):

> A permitted operation succeeds on the intended node; wrong-node,
> revoked-agent, unauthorized-user and duplicate-request cases fail safely with
> useful diagnostics. Restarting the client does not orphan server operations.

Section 6A maps the "Remote Dashboard" center to V2-A (authenticated browser
surface) → later web/mobile.

### In scope (design)

- An authenticated browser management surface whose availability does **not**
  depend on the desktop client running (persistent service ownership).
- Session model and authorization semantics scoped by the V2-A roles
  (owner/admin/operator/viewer) from `V2A_AUTHORITY_PERMISSIONS.md`.
- Explicit exposure boundary: loopback by default, no automatic public
  exposure, no weakening of the existing shared-token fail-closed model.

### Out of scope (this Wave)

- Any change to the desktop IPC/privilege boundary or the public
  marketing/download website (`website/` is NOT a management surface).
- Mobile app, tunnels, or public-access provisioning (V2-H).
- Per-node/per-workload credentials (deferred to V2-I by Decision 2).

---

## 2. Current-state fidelity notes (verified file:line)

All paths relative to repo root; verified against the working tree on
2026-09-16.

### 2.1 Agent REST server (the only service on the wire today)

- `agent/src/config.js:9-10` — `DEFAULT_HOST = "0.0.0.0"`,
  `DEFAULT_PORT = 47131`. The agent binds all interfaces by default; local
  operations rely on `127.0.0.1:47131` (`src/shared/agentTokenStore.js:10`).
- `agent/src/auth.js:24` — only `/api/v1/health` is public; `isAuthorized`
  (line 37) requires `x-agent-token` or `Authorization: Bearer`.
- `agent/src/auth.js:31` — `SHARED_TOKEN_PRINCIPAL`
  `{ principal: "shared-token", role: null }`: **no session or identity model
  exists on the agent today**.
- `agent/src/routes/enroll.js:20` — `/api/v1/enroll/start|complete|status`
  are nonce/public protected; revoke/rotate stay bearer-gated
  (`agent/src/server.js:200-203,236-237`).
- Fail-closed permissions: `agent/src/permissions.js:11,61` — profiles are
  `local-owner` (wildcard, when spawned with `ANXHUB_CONFIG_DIR`) or
  `restricted` (`[]` default); `AGENT_PERMISSION_PROFILE` can pin either mode.
- Health mode truthfully derives read-only/write-capable from configured
  permissions (`agent/src/routes/health.js`; commit `dc6fce8`).

### 2.2 Desktop → agent spawn contract

- `src/services/agentControlService.js:108` — spawn env sets
  `ANXHUB_CONFIG_DIR`, `AGENT_IDENTITY_PATH`, `AGENT_INSTANCE_ROOT`,
  `AGENT_FILE_ROOTS`, `AGENT_TOKEN`, etc.; comment at line 113 ("desktop
  ALWAYS spawns the agent with ANXHUB_CONFIG_DIR"); required-key check at
  line 118; config-marker comparison at line 176.
- `src/services/localAgentRuntimeService.js:7-9` — packaged agent entrypoint
  (`agent/src/server.js`) and manifest wiring.
- **No desktop-main HTTP management server exists** — verified by grep across
  `main.js` and `src/` (only marketplace example strings / unrelated matches).

### 2.3 Electron IPC boundary (unchanged by this brief)

- `main.js:8-30` registers a broad IPC surface (instances, nodes, marketplace,
  backups, publicAccess, security, ssh, …); handlers wrapped at
  `main.js:103-104`; window-level `ipcMain.on/handle` at `main.js:480-532`.
- Preload bridge: `preload.js:454-458` exposes `anxWindow`/`anx`/`anxhub`/
  `anxos`/`electronAPI`; errors forwarded via `diagnostics:log` (line 18).
- AGENTS.md constraints carry forward: context isolation, no secrets in the
  renderer, redaction via `src/shared/redaction.js` — renderer hiding is
  **presentation only, never a security boundary**.

### 2.4 Website directory (NOT a management surface)

- `website/README.md:1-4` — static marketing/download site deployed to
  Cloudflare Pages; account routes (`/signin`, `/signup`, …) require Supabase
  config. Release metadata (`npm run website:sync` → `website/config.js`) is
  build info, not management API.

---

## 3. Architecture options

### Option A (RECOMMENDED) — Agent-served authenticated management surface

A read/operate HTML surface served from the agent REST server (port 47131) on
loopback, protected by a V2-A session model layered on top of the existing
fail-closed permission engine.

- **Why it fits:** the agent already persists identity + permission
  information, already owns durable job recovery (restarting the desktop does
  not orphan server operations), and is the natural "persistent service
  ownership" point. No second service to supervise.
- Sessions: short-lived cookies issued after owner authentication
  (reuse `/api/v1/enroll/*` + owner unlock semantics), carrying the resolved
  V2-A role for the requesting principal; every request still enforces the
  existing permission map — the session is a *transport* credential, never a
  new authorization source.
- Exposure: loopback-only by default; LAN/public requires an explicit
  opt-in and a firewall/policy decision (V2-H territory).
- Security posture: never places the shared token in the browser surface;
  redacts diagnostics; keeps `/api/v1/health` public and everything else
  closed.

### Option B — Desktop-hosted local management service (REJECTED)

A management HTTP service owned by the desktop process.

- **Rejected because** it re-creates the dependency this milestone exists to
  remove: management would still require the desktop client to be running,
  violating "persistent service ownership".

---

## 4. Owner decisions required

1. **Session/auth model** — short-lived session (cookie + expiry) issued via
   the enrollment/owner-unlock flow, scoped per request by the existing
   permission map (recommended), vs. reusing the bearer token directly
   (not recommended — would spread the shared secret).
2. **Authorization scope in the browser surface** — expose the full V2-A
   role set (owner/admin/operator/viewer) from the start (recommended — the
   roles already exist and are fail-closed), vs. an initial owner/admin subset
   with operator/viewer deferred.
3. **Exposure boundary** — loopback-only with an explicit opt-in for
   LAN/public in a later wave (recommended), vs. designing LAN exposure into
   Wave 1 (not recommended without V2-H network scope).
4. **Bootstrap** — reuse `/api/v1/enroll/*` + the owner unlock flow for first
   session issuance (recommended), vs. a new dedicated session endpoint.