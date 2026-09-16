# V2-A Authority & Permission Model — Design Brief

**Wave 0 · Milestone V2-A (Shared platform, identity and agent foundation)**
**Status:** Design brief (docs only — no code, no build, no commit)
**Owner decision required:** See [§6 Risks & Open Questions](#6-risks--open-questions-needing-the-owners-decision)

This brief describes the *target* management-authority and role/permission model for AnxOS Control Center. It maps to the V2-A checklist in `docs/MASTER_ROADMAP.md`, grounds every proposal in the actual code (`file:line` pointers in §2), and reuses the existing "Local Owner unlock" architecture instead of building a parallel system. **This document is a proposal; nothing changes behavior until the owner approves the model and scopes implementation waves.**

---

## 1. Goal & Scope

### 1.1 Roadmap mapping

The following V2-A checklist items from `docs/MASTER_ROADMAP.md` are the direct targets of this brief:

- **"Define management authority: the backend authorizes actions; an Agent verifies the target and bounded capability before execution."** (Roadmap line 141) — addressed in §3.1, §4.
- **"Introduce scoped roles for owner/admin/operator/viewer and service identities, with explicit node/workload permissions."** (Roadmap line 142) — addressed in §3.2, §3.3, §3.4.
- **"Define consistent identities for nodes, services, game instances, containers, volumes, users and operations."** (Roadmap line 140) — addressed in §3.3, §3.4 (identity namespace + per-target permission tokens).
- **"Establish authenticated agent enrollment, revocation, credential rotation and compatibility negotiation."** (Roadmap line 143) — the enrollment/rotation seams already exist (see §2); the brief adds capability-provisioning and revocation to the existing token lifecycle.
- **"Define job lifecycle, audit events, cancellation and idempotency across local and remote execution."** (Roadmap line 144) — `sec. 5` (Security review) covers duplicate-request/idempotency failure semantics; a full job-lifecycle brief is out of scope here and should be a sibling Wave-0 brief.
- **Acceptance gate: "A permitted operation succeeds on the intended node; wrong-node, revoked-agent, unauthorized-user and duplicate-request cases fail safely with useful diagnostics. Restarting the client does not orphan server operations."** (Roadmap line 148) — §5 is written directly against each of these named failure cases.

In scope: the authority-split (who authorizes vs who verifies), role definitions, per-node/per-workload permission schema, reuse of the owner gate, IPC + Agent REST contract deltas (conceptual), and the four failure modes in the acceptance gate.

Out of scope (listed so scope stays bounded): the full V2-B/C dashboard and container lifecycle tracks, the complete distributed job-lifecycle engine, the browser management surface, and platform/support-matrix publication. Each deserves its own Wave-0 brief; this brief only defines the authority foundation they depend on.

### 1.2 Design intent

The invariant the whole model rests on (already partially implemented, see §2.4):

> The **backend** (Electron main process / Control Center service) decides *who* may act (an authenticated principal with a role → effective permission set). The **Agent** on each node decides *what* the credentialed caller may touch on that node (a concrete target + a bounded capability), and refuses anything not scoped to it. Both sides must agree, independently, or the operation fails closed.

---

## 2. Current-State Fidelity Notes (verified code pointers)

All pointers verified against the working tree at the time of writing. These are the real seams the design reuses.

### 2.1 Owner gate / "Unlock Anxos" — the architectural anchor to reuse

- `src/services/securityService.js:1561` — `requireLocalOwnerAuthenticated(target, message)` throws `AUTH_UNLOCK_REQUIRED` unless the local owner unlock has completed. This is the choke point already enforced across node, agent-control, and settings IPC.
- `src/services/securityService.js:1511` — `requirePermission(permission, target, options)` is the single authorization entry point used by the IPC surface. Behaviors observed:
  - owner with `ownerAuthorized === true` → returns `permissions: ["*"]` (line 1516-1521);
  - no admin/owner configured yet (`setupRequired`) → falls back to `localMode` with `permissions: ["local:*"]` (line 1523-1531);
  - a signed-in non-owner → checked against `ROLE_PERMISSIONS` via `userHasPermission` (line 1498, 1539).
- `src/services/securityService.js:1498` — `userHasPermission(user, permission)`: `ROLE_PERMISSIONS[user.role]` includes a literal `"*"` passthrough. **Note:** this is a code bug caught by inspection — an unknown/typeless role yields `[]` which then correctly denies, but the `"*"` passthrough means "grant everything" semantics exist and must be the exclusive preserve of Owner.
- `src/services/securityService.js:40-65` — **`ROLE_PERMISSIONS` map: three roles today**, `Owner` (`["*"]`), `Admin` (11 capabilities), `User` (11 read-ish capabilities). **There is currently no `operator` or `viewer` role and no `service` identity class.** This is the exact seam the V2-A role expansion must change. Note that in `userHasPermission`, `Owner`’s `["*"]` matches every permission string, so `Owner` is already wildcard.
- `src/services/securityService.js:1236` — `setupAdmin` seeds the **first** user as `role: "Owner"` (line 1259), password hashed with bcrypt. This is the "local owner setup prompt" first-run path.
- `src/services/securityService.js:1323` — `login`/`finalizeLocalOwnerAuthentication` (line 1272) establish the runtime session, set `authRecovery.enterUnlocked({ provider: "local-owner" })` and `localOwnerAuthenticated = true`. This is the state `requireLocalOwnerAuthenticated` reads.
- `src/services/securityService.js:1760` — `lockOwnerWorkspace()` re-locks owner-only state; wired via `security:lockOwnerWorkspace` (`src/ipc/securityIpc.js:69`).
- `src/services/securityService.js:1188` — `getStatus()` returns `roles: Object.keys(ROLE_PERMISSIONS)`, the caller’s `permissions`, `localMode`, `setupRequired`, `ownerWorkspaceAvailable`. The renderer keyed to the "Unlock Anxos" gate at `index.html:39` (`<h1 data-security-title>Unlock Anxos</h1>`) and the "Local Owner Login" button at `index.html:81`.
- `src/ipc/securityIpc.js` — full security IPC surface (`security:getStatus`, `setupAdmin`, `login`, `lockOwnerWorkspace`, `rotateAgentToken`, `revokeAgentToken`, `emergencyAction`, ...). `security:setupAdmin` and `security:login` are the IPC events the renderer already calls.

**Conclusion:** the local Owner gate is already *the* authorization seam. V2-A must *extend* `ROLE_PERMISSIONS` + `requirePermission`, *not* introduce a new gate.

### 2.2 Desktop IPC authorization pattern (per-operation, per-target)

Every IPC handler imports `requirePermission` from `securityService` and passes both a capability and a concrete target:

- `src/ipc/instancesIpc.js:74-144` — `instances:list/create/update/rename/duplicate/start/stop/restart/forceKill/delete/...` each call `requirePermission("instance:read" | "instance:write" | "instance:lifecycle" | "instance:delete", <instanceId>)` and `audit(...)`. This is the per-**workload** (instance) target surface that V2-A per-workload permissions must generalize.
- `src/ipc/dockerIpc.js:49-209` — `docker:read`, `instance:write`, `instance:lifecycle`, `instance:delete` for containers/images/volumes/networks/compose, with a concrete target (name/image/volume/network/project).
- `src/ipc/marketplaceIpc.js:295-384` — `marketplace:read` and `marketplace:install` (install/steamcmd-update/manual-import/download-cancel), again per-target.
- `src/ipc/dependenciesIpc.js:41-67` — `dependencies:read`, `instance:write` for catalog/install.
- `src/ipc/ampIpc.js:10`, `src/ipc/backupsIpc.js`, `src/ipc/settingsPermissionService.js:87` — same `requirePermission`/`requireLocalOwnerAuthenticated` pattern.

### 2.3 Node targeting is already mandatory (no silent fallback)

- `src/ipc/nodeContext.js:3` — `requireNodeContext(payload, operation)` throws `NODE_REQUIRED` (and leaves an audit trail) whenever a node-aware IPC arrives without `nodeId`. This is the "wrong-node / missing-node must fail safely" primitive already in place for the desktop.
- `src/services/nodeService.js` — `nodeIdForDevice(deviceId)` (`:139`) derives a stable `agent-<deviceId>` node id; agents carry a persistent `deviceId` (`agent/src/services/deviceIdentityService.js:44`, stored in `device-identity.json`). Node records map `nodeId`/`agentUrl`/`agentUrls` (`nodeService.js:152-174`). So a node identity already exists and is stable across restarts.

### 2.4 Agent REST server (port 47131) — current auth model and its gap

- `agent/src/server.js:350` — `handleRequest` is the single guard: rate-limits → pairing route → `isAuthorized` → `authorizeApiPermission(getRoutePermission(...))` → `routeRequest`.
- `agent/src/auth.js:27` — `isAuthorized`: `/api/v1/health` is public; everything else requires a single shared token via `x-agent-token` header or `Authorization: Bearer …`, compared with `crypto.timingSafeEqual` (line 12). **There is exactly one token and one permission set for the whole Agent.** It authenticates *the client* but carries no user identity, no role, and no per-target scope.
- `agent/src/permissions.js` — capability parsing:
  - `getConfiguredPermissions()` reads env vars `AGENT_ACTION_PERMISSIONS | AGENT_ALLOWED_PERMISSIONS | ANX_AGENT_ACTION_PERMISSIONS`, defaulting to `["docker:write"]` (line 1). Supports `*`, `docker:*`, `docker.write`→`docker:write` normalization (lines 11-34).
  - `getConfiguredApiPermissions()` reads `AGENT_API_PERMISSIONS`, defaulting to `["*"]` (line 2, 52-58).
  - `authorizeApiPermission` (line 60) and `authorizeAction` (line 71) return explicit `*_PERMISSION_DENIED` / `*_AUTHORIZED` codes.
- `agent/src/server.js:165` — `getRoutePermission(request, pathname)` maps each REST path to a capability token (e.g. `instance:lifecycle`, `instance:delete`, `dependencies:write`, `backups:restore`, `owner` for diagnostics). So the Agent already has a **capability dimension**.
- **What the Agent does NOT do today:** validate the *target* (e.g., that an `instance_id` in the URL belongs to this node / is in-scope), associate a *user identity + role* with the call, or narrow permissions per principal/target from the backend. It authorizes against one global static set, not against per-request scoped grants. This is the core gap §3/§4 close.

### 2.5 Agent-side audit & health

- `agent/src/audit/auditLogger.js` — `auditAction(request, event)` logs `scope: agent_action_audit` with actor (redacted remoteAddress/userAgent), actionId, permission, outcome, reason. Health is the only public route (`auth.js:23`).
- `agent/src/routes/pairing.js:74` — `completePairing` writes the permanent token via `writeAgentConfigToken` and immediately sets `config.token`. Enrollment today = "whoever holds the one-time pairing code and supplies a ≥32-char token is the client." There is no role or capability binding at enrollment time.

### 2.6 Token & enrolment seams that already exist (reuse, don’t rebuild)

- Token resolution shared token store: `agent/src/config.js:93` → `resolveSharedAgentToken` from `src/shared/agentTokenStore.js`; rotation `src/services/securityService.js:1578` / `src/ipc/securityIpc.js:59`.
- Revocation: `revokeAgentToken` (`securityService.js:1741`, `security:revokeAgentToken` at `securityIpc.js:67`) and per-device revocation of the local token via `src/services/localAgentPairingService.js:165` (`rotateLocalAgentCredentials`).
- Remote-node credential storage: `src/services/nodeCredentialStore.js` + `nodeService.getNodeToken/setNodeToken/deleteNodeToken` (`nodeService.js:59-99`).
- One-agent-per-node architecture doc: `docs/ONE_AGENT_PER_NODE_ARCHITECTURE.md` (existing intent to align with).
- Security/audit model doc: `docs/SECURITY_BOUNDARIES.md`, `docs/SECURITY_NOTES.md`; account-owner identity in `src/services/ownerAccountConfig.js` (`isOwnerAccount`, line 87).

---

## 3. Proposed Authority Model

### 3.1 The authority split: backend authorizes, Agent verifies target + bounded capability

Split into two independent, complementary checks. **Both must pass; either failing closes the operation.**

1. **Backend authorization (policy):** a signed-in principal wishes to perform an action scoped to a target. The backend:
   - authenticates the principal (existing local Owner session / future account session);
   - resolves role → role capability set (extended `ROLE_PERMISSIONS`);
   - intersects with any per-node and per-workload grants that are narrower than the role;
   - synthesizes a **short-lived, single-use, target-bounded grant** (a capability token for exactly `<nodeId, targetId, action>`), records an audit event, and passes the grant to the Agent with the request.

2. **Agent verification (enforcement on the node):** the Agent on the target node:
   - verifies the presented grant is signed / issued by the trusted backend (the shared secret / per-node key) and not expired or revoked;
   - verifies the grant’s `nodeId` equals its own identity (`deviceId`-derived), rejecting any mismatch as **wrong-node**;
   - verifies the grant’s `targetId` exists and is in scope on this node (rejecting an in-scope capability aimed at an out-of-scope workload);
   - verifies the grant’s action matches the requested route (the existing `getRoutePermission` capability check, now tied to the grant instead of a global static set);
   - executes only that one bounded action, then consumes the grant (single-use) and audits.

The Agent never trusts a client’s claimed role; it trusts only the backend-issued, limited grant presented with the request. Client identity alone buys nothing on the node.

**Why this shape:** it reuses the existing split — the desktop already authorizes (`requirePermission`) and the Agent already enforces route capabilities (`authorizeApiPermission`); the delta is to bind the Agent’s check to a concrete per-request target/identity/expiry rather than one global token.

### 3.2 Role definitions (extend `ROLE_PERMISSIONS`)

Proposed roles replace today’s three (`Owner`, `Admin`, `User`) with the roadmap’s four human roles + service identities. The `"*"` passthrough in `userHasPermission` (`securityService.js:1507-1508`) applies to `Owner` only.

| Role | Principle | Capability profile | Typical grants |
| --- | --- | --- | --- |
| **owner** | Full authority; config, identity, security, revoke; `permissions: ["*"]` | everything, incl. provisioning grants, revoking agents/users, role assignment | `*` |
| **admin** | Manage workloads but not account/security configuration | current `Admin` set, minus security/identity-only rights | `instance:*`, `docker:*`, `marketplace:install`, `backups:restore`, `files:write`, `nodes:read`, `system:read`, `public-access:write`, `dependencies:*`, `jobs:*` |
| **operator** (new) | Operate the day-to-day lifecycle of assigned workloads, read-only elsewhere | **lifecycle/start/stop/restart + logs + status** on granted targets; no delete, no install, no config-write | `instance:read`, `instance:lifecycle` on granted workloads; `backups:read`; `console:read`; `jobs:execute` on granted targets |
| **viewer** (new) | Read-only observability of granted targets | `*:read`-only; no lifecycle/write/delete anywhere | `instance:read`, `system:read`, `backups:read`, `console:read`, `nodes:read` on granted scope only |
| **service** (service identity) | Machine credential for an automation/integration; carries **explicit node/workload permissions only**, no interactive login | a non-personalized identity with a fixed capability + target allowlist; must be narrow (defense-in-depth against the default `AGENT_API_PERMISSIONS=["*"]`) | e.g. `{node:X, targets:[inst-a], caps:["instance:lifecycle","console:write"]}` |

Notes:
- Keep backward compatibility: today’s `User` maps onto the new `viewer` profile (read-ish) with an explicit owner decision on whether legacy `User` sessions keep any lifecycle rights. `Admin` maps onto new `admin`.
- `owner` and `admin` are the only roles allowed to **provision grants and change assignments**; `operator`/`viewer`/`service` can only ever receive narrower grants, never expand them.
- The renderer and `.env`/config surfaces already carry `roles` and `permissions` in `getStatus()` (`securityService.js:1219-1220`); extend `ROLE_PERMISSIONS` and that status payload together.

### 3.3 Identity namespace & the per-node/per-workload permission schema

Consistent identifiers (Roadmap line 140) with a stable namespace so a grant is unambiguous:

- **Principal id:** local owner `user.id` (uuid, `securityService.js:1257`); future account `openid`/unique id; `service` identities get generated `svc-<uuid>`.
- **Node id:** existing `agent-<deviceId>` (`nodeService.js:139`), stable across restarts (`device-identity.json`, `deviceIdentityService.js:44`).
- **Workload ids:** instance id (`instancesIpc`), container name/image, volume, network, compose project, dependency catalog entry, marketplace template/download — reuse the exact target strings the IPC handlers already pass to `requirePermission(…, target).
- **Operation (capability) tokens:** reuse the existing vocabulary from `agent/src/permissions.js` + `server.js:getRoutePermission` (`instance:read/write/lifecycle/delete`, `docker:*`, `files:*`, `console:*`, `backups:*`, `dependencies:*`, `marketplace:install`, `public-access:*`, `system:read`, `owner`) plus new `roles:manage`, `grants:issue`, `grants:revoke` reserved for owner/admin.

**Grant object (conceptual contract):**

```
{
  "version": 1,
  "grantId": "<uuid>",            // single-use, audited
  "issuer": "<principal>",
  "nodeId": "agent-<deviceId>",   // Agent rejects mismatch -> wrong-node
  "targets": ["<workload-ids>"],  // concretely scoped; may be ["*"] only for owner
  "capabilities": ["instance:lifecycle", "console:write"], // bounded
  "expiresAt": "<ISO>",           // short TTL
  "notBefore": "<ISO>",
  "nonce": "<random>",            // binds single-use / duplicate detection
  "signature": "<hmac>",          // over all fields, key = per-node shared secret
}
```

**Per-node, per-workload grants** are exactly the `requirePermission` target-scoped principle (`securityService.js:1514`, `instancesIpc.js:74`) lifted into a first-class, persisted, revocable structure. A principal’s *effective* capability at any instant is `intersect(ROLE_PERMISSIONS[role], union(grants))`, evaluated by the backend at authorization time.

### 3.4 How the existing owner gate maps to the owner role

Reuse, don’t fork:
- The first-run **local owner setup prompt** (`security:setupAdmin`, `securityService.js:1236`) already establishes an `Owner`-role principal → this becomes the seed identity for the `owner` role.
- The **"Local Owner Login" / "Unlock AnxOS"** path (`security:login`, `login()`→`finalizeLocalOwnerAuthentication`, `index.html:81/39`) already establishes `localOwnerAuthenticated`, and `requireOwner`/`requireLocalOwnerAuthenticated` (`securityService.js:1549/1561`) already gate owner-only operations. V2-A keeps these as **the** owner-authentication mechanism; the only change is that the backend now also derives the owner’s capability set through `ROLE_PERMISSIONS["owner"]=["*"]` and is the only role allowed to issue/revoke grants and service identities.
- `lockOwnerWorkspace` (`securityService.js:1760`) remains the owner-only re-lock; the design must ensure **lock / re-auth invalidates outstanding grants issued while unlocked** (revocation-on-lock, see §5).
- No parallel "owner system" is proposed; the role model is a superset of the current gate.

---

## 4. Interfaces / Contracts Changes (conceptual only — no implementation)

### 4.1 Desktop IPC (`src/ipc/*`, `securityService.js`)

- **Extend `ROLE_PERMISSIONS`** to owner/admin/operator/viewer/service (schema §3.2); keep `Owner`/`Admin`/`User` name mapping for compatibility.
- **Add grant-management IPC**, owner/admin only, mirroring the existing `security:*` style:
  - `security:listGrants`, `security:issueGrant` (returns the grant for the chosen principal×node×targets×caps), `security:revokeGrant`, `security:listServiceIdentities`, `security:createServiceIdentity`, `security:rotateServiceCredential`, `security:revokeServiceIdentity`.
  - Every grant mutate operation calls `requirePermission("grants:issue" | "grants:revoke", <nodeId> + <target>)` and writes an audit event (existing `audit(...)` pattern used by `instancesIpc.js`).
- **Narrow `requirePermission` for non-owner roles:** the target argument becomes load-bearing — a principal may only act on a target that appears in an active grant for that principal×node. Current code passes `target` only for auditing; V2-A makes it enforce the grant intersection (fail-closed, `PERMISSION_DENIED`).
- **Status/payload:** extend `getStatus()` (`securityService.js:1188`) to expose the caller’s active grants + `serviceIdentity` flag; renderer continue to key off the existing owner-gate flags.
- **Lock coupling:** `lockOwnerWorkspace` / logout / ownership re-auth cascade → revoke the issuing principal’s outstanding grants (see §5).

### 4.2 Agent REST (`agent/src/*`)

- **Request auth pass:** keep `isAuthorized` token check but reinterpret the credential as "a principal identity + capability set" rather than one global token:
  - `auth.js` `isAuthorized` returns the resolved principal + enrolled capability set (from a per-node credential record) instead of a bare `ok`.
  - `permissions.js`: replace the global env defaults (`AGENT_API_PERMISSIONS=["*"]`, `AGENT_ACTION_PERMISSIONS=["docker:write"]`) with per-credential capability sets. **Remove/implicitly-supersede the `["*"]` default so a fresh or mis-provisioned agent does not silently allow everything.** (Owner decision on migration accepted under §6.)
  - **New target check** after capability check in `server.js:handleRequest` / per-route handlers: verify the requested target (instance id / container / path under instanceRoot / dependency / marketplace item) is within the grant’s `targets[]` and belongs to this node. Any miss → `403 TARGET_OUT_OF_SCOPE` with a diagnostic. This is the missing piece identified in §2.4.
  - **Grant binding:** the per-principal credential carries the backend-issued grant; the Agent verifies `nodeId == its deviceId`, nonce not replayed (in-memory + best-effort audit), `expiresAt` not past, and signature over the request.
- **Pairing/enrollment (`routes/pairing.js:74`):** `completePairing` gains a capability/role/country scope field so enrollment can bind a service identity or a role-limited principal, and a **compatibility-negotiation** field (agent schema/capability version) to satisfy Roadmap line 143. Revocation/rotation stays on existing `security:rotateAgentToken`/`security:revokeAgentToken` + `localAgentPairingService`; a revoked token makes the node reject with `UNAUTHORIZED` + an actionable message (already partially in `server.js:getAuthErrorMessage`).
- **New routes (owner/admin only, conceptual):** `POST /api/v1/grants/provision`, `POST /api/v1/grants/revoke`, and a `GET /api/v1/capabilities` (compatibility negotiation) describing which capabilities+target types this agent supports. Keep `/health` public.
- **Audit:** extend `auditLogger.js` so the existing `agent_action_audit` line records `grantId` + `nodeId` + asserted `targetId` on every action (already has permission/outcome/reason).

### 4.3 Data / config seams (no schema chosen, direction only)

- Extend the per-node credential record (`localAgentPairingService.js:buildCredentialRecord`) and node records (`nodeService.js`) with an `enrolledCapabilities` + `serviceIdentity` + `revokedAt` field set, and store granted permissions next to node credentials (the existing `nodeCredentialStore.js` / secure-session-store pattern) so they decrypt only after owner unlock.
- Grants are short-lived and re-provisioned per action; only the capability *profile* per identity×node persists.

---

## 5. Security Review Notes (must fail safely with useful diagnostics)

Each bullet = one named acceptance-gate failure case (Roadmap line 148), the expected failure mode, and the diagnostic contract.

1. **Wrong-node.** A grant issued for node A is presented to node B.
   - Behavior: Agent B validates `nodeId != deviceId` → reject before any route logic. HTTP `403 NODE_MISMATCH`, body includes only `{nodeId, expectedNodeId}` (no secrets).
   - Diagnostic: `agent_action_audit` `outcome:"denied", reason:"NODE_MISMATCH"`; backend audit `grants.mismatch`. No state change on either node.
2. **Revoked agent.** A previously-enrolled agent token (or principal credential) has been revoked.
   - Behavior: `isAuthorized` fails (token/signature invalidated on revocation), HTTP `401 UNAUTHORIZED` with the existing actionable message from `server.js:getAuthErrorMessage` ("re-pair… rotate the node credential").
   - Diagnostic: `agent_action_audit` `reason:"UNAUTHORIZED"`; backend audit `agent.token.revoke` (`securityService.js:78`) already logs the revoked fingerprint. A revoked service identity must also invalidate any still-unexpired grants bearing that principal.
3. **Unauthorized user.** A signed-in non-owner whose role/grants do not cover the action×target.
   - Behavior: backend `requirePermission` throws `PERMISSION_DENIED` (`securityService.js:1542`, already audited `security.permission` at line 1540) before any IPC handler runs; if a grant somehow reaches the Agent, the Agent independently re-checks capability×target and returns `403 API_PERMISSION_DENIED` / `403 TARGET_OUT_OF_SCOPE`.
   - Diagnostic: never reveal *why* other than "not allowed" + the denied capability name (already the pattern at `authorizeApiPermission`). Full reason only in audits.
4. **Duplicate request (idempotency / replay).**
   - Behavior: each grant is single-use (`nonce` + consumed-on-execution). A replayed identical request fails with `409 GRANT_ALREADY_USED` (or `403 EXPIRED` / `400 STALE_NONCE`) and the target is *not* re-executed — critical for destructive/lifecycle actions. Destructive handlers additionally keep the existing per-action audit and target-scoping so a replay cannot delete/overwrite a second time.
   - Diagnostic: audit `grants.replay` with grantId; the API returns a stable reason code so the client can distinguish "already done, inspect result" from "not done".
5. **Restart must not orphan or widen.** Restarting the desktop client re-locks owner state (`lockOwnerWorkspace`/recovery) — outstanding short-lived grants already expire by TTL; restarting the Agent reverts it to the persisted per-node credential record (only enrolled capabilies, never a live session grant wider than persisted). Neither restart ever *widens* a principal’s authority; it can only narrow it. The Agent’s `recoverIncompleteInstallations` (`server.js:464`) continues to repair interrupted installs but must do so under the same target-scoping rules.
6. **Principle of least privilege by default.** The default `AGENT_API_PERMISSIONS=["*"]` and `AGENT_ACTION_PERMISSIONS=["docker:write"]` must be superseded by explicit per-principal capabilities; a node with no provisioned grant for a principal denies everything except `/health`.

---

## 6. Risks & Open Questions Needing the Owner's Decision

1. **Legacy `User` role mapping.** Should the existing `User` role (currently includes `instance:read` + `instance:lifecycle`) migrate to the new read-only `viewer` (losing lifecycle), or to a lifecycle-capable `operator`? Changing it is a behavioral compatibility break for any current account-based users (currently only Owner is used in practice). Recommendation: migrate `User` → `viewer` for security, but this needs an explicit call.
2. **Replace the Agent `["*"]` global default vs. preserve it for single-node/single-owner setups.** The current local agent ships with `AGENT_API_PERMISSIONS=["*"]` so the default-installed local agent works. Making the default fail-closed (require explicit grants) is the secure posture but changes what "works out of the box" looks like and may require a migration/flag for existing installs. Must decide: secure-by-default vs compat-by-default (recommend: secure-by-default under owner, with a one-time migration that grants owner `*` to the local node it already owns).
3. **Service-identity credential model & lifetime.** Are service identities long-lived secrets (rotatable like agent tokens via `security:rotateAgentToken`) or short-lived machine tokens that the parent automation refreshes (OAuth-style client-credentials)? This decides revocation latency, TTL defaults, and whether a `service` identity can hold a durable `*` on a dedicated node. Recommendation: short-lived grants with a durable narrow profile, so a leaked service credential cannot be escalated.
4. *(Deferred to owner if useful)* Compatibility-negotiation scope (Roadmap line 143): define the agent capability/schema version handshake now (so an old Agent can be told "this grant references capabilities you don't support") or defer via the companion job-lifecycle/enrollment brief.

---

## Appendix — Files referenced (absolute paths)

- `C:\Users\anjor\Documents\AnxOS-Control-Center\docs\MASTER_ROADMAP.md` (V2-A lines 136-148, dependency map lines 59-61)
- `C:\Users\anjor\Documents\AnxOS-Control-Center\src\services\securityService.js` (ROLE_PERMISSIONS 40-65; requirePermission 1511; requireOwner 1549; requireLocalOwnerAuthenticated 1561; setupAdmin 1236; login 1323; getStatus 1188; lockOwnerWorkspace 1760)
- `C:\Users\anjor\Documents\AnxOS-Control-Center\src\ipc\securityIpc.js`, `src\ipc\nodeContext.js`, `src\ipc\instancesIpc.js`, `src\ipc\dockerIpc.js`, `src\ipc\marketplaceIpc.js`, `src\ipc\dependenciesIpc.js`, `src\ipc\ampIpc.js`
- `C:\Users\anjor\Documents\AnxOS-Control-Center\src\services\ownerAccountConfig.js`, `src\services\nodeService.js`, `src\services\localAgentPairingService.js`, `src\services\nodeCredentialStore.js`, `src\services\settingsPermissionService.js`
- `C:\Users\anjor\Documents\AnxOS-Control-Center\agent\src\auth.js`, `agent\src\permissions.js`, `agent\src\server.js`, `agent\src\config.js`, `agent\src\routes\pairing.js`, `agent\src\audit\auditLogger.js`, `agent\src\services\deviceIdentityService.js`
- `C:\Users\anjor\Documents\AnxOS-Control-Center\index.html` (owner gate 39/81)