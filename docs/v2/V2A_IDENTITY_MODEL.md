# V2-A Identity Model — Design Brief

**Wave 0 · V2-A · docs only (no code, no commits, no pushes)**

- **Milestone framing:** `docs/MASTER_ROADMAP.md` §6 *V2-A — Shared platform, identity and agent foundation* and the §9 decision register ("Decide V2-A service ownership and permission contracts").
- **Status labels per roadmap §1.2:** Current-state notes below are **verified against this checkout** (`git rev f44ff2b`, 2026-09-16). Section 3 and beyond are `RECONSTRUCTED / PROPOSED` — a design to be reconciled by the owner before implementation.

---

## 1. Goal & scope

V2-A acceptance gate (from `docs/MASTER_ROADMAP.md` §6):

> A **permitted operation succeeds on the intended node**; wrong-node, revoked-agent, unauthorized-user and duplicate-request cases fail safely with useful diagnostics. Restarting the client does not orphan server operations.

This brief defines the **identity model** that the V2-A gate and the §6 checklist depend on:

- [ ] Define consistent identities for **nodes, services, game instances, containers, volumes, users and operations**.
- [ ] Define management authority: the **backend authorizes actions; an Agent verifies the target and bounded capability** before execution.
- [ ] Introduce scoped roles for **owner/admin/operator/viewer** and service identities, with explicit node/workload permissions.
- [ ] Establish authenticated **agent enrollment, revocation, credential rotation** and compatibility negotiation.
- [ ] Define **job lifecycle, audit events, cancellation and idempotency** across local and remote execution.
- [ ] Separate desktop-client availability from persistent service ownership; prepare an authenticated browser surface.

**Explicit scope decisions for this brief:**

1. **Fit onto the existing identity machinery; do not invent a second authorization system.** The desktop owner-unlock gate (`src/services/securityService.js` — local owner users plus optional AnxOS cloud account allowlist) and the agent single-shared-token auth are the seams to formalize, not replace.
2. **Backwards-compatible on-disk identities.** The instance directory name **is** the instance id today; node ids derive deterministically from the agent device id; user ids are UUIDs. The model formalizes these rather than re-keying data (which would break V1 → V2 migration, roadmap §8 A12 / §6 V2-K).
3. **Docs only.** No source changes, no `.dev-logs` writes, no commit. All proposed contracts below are conceptual descriptions awaiting owner approval.

---

## 2. Current-state fidelity notes (verified against checkout)

### 2.1 Desktop IPC routing layer

- `serviceRouter` lives at `src/services/serviceRouter.js`. It is the single seam where every node-aware service operation (instances, docker, backups, dependencies, amp, playit, files) chooses a local (application-host) vs agent execution target via `shouldUseLocalInstances` / `shouldUseLocalDocker` (`serviceRouter.js:280–286`) and `isApplicationHostTarget` (`:523`).
- Node targeting is resolved by `getRequestNodeId` (`:467`) → `getOptionalNodeConfig` (`:442`) which returns `target.config` + `nodeId` and throws `NODE_DISABLED` (403) for disabled nodes. Agent responses are stamped with the node via `withNodeContext` (`:482`, adds `nodeId` to the payload and to nested `containers/images/volumes/networks/backups/jobs`).
- The implicit-node fallback is blocked at a single shared point: `src/ipc/nodeContext.js` `requireNodeContext` throws `NODE_REQUIRED` (400) instead of silently using a global agent config, and logs `implicit-node-fallback-blocked`.
- IPC handlers (`src/ipc/securityIpc.js:53–76`, `instancesIpc.js:74+`, `dependenciesIpc.js`) wrap every operation in `requirePermission(role-permission, target)` from `securityService`, and require `requireNodeContext(payload, channel)`.
- Agent-specific IPC lives in `src/ipc/agentControlIpc.js` and `nodesIpc.js`; node targeting/health is driven from `nodeService` (`checkNodeHealth`, `withDiscoveredLocalAgent`).

### 2.2 Agent REST API (the local/node agent)

- Server: `agent/src/server.js`. Public, no-token route: `GET /api/v1/health` (`auth.js isPublicRoute :23`; `health.js`). All other routes are authenticated by `isAuthorized` in `agent/src/auth.js`, which timing-safe-compares one shared `config.token` (`:44–52`) and returns `AGENT_TOKEN_MISSING` (503) when no token is configured, `UNAUTHORIZED` (401) on mismatch.
- **Capability / role mapping lives in the agent**: `getRoutePermission` (`server.js:165–191`) maps each path to a permission string (e.g. `instance:read`, `instance:lifecycle`, `instance:delete`, `files:write`, `owner` for `/diagnostics`), then `authorizeApiPermission` (`agent/src/permissions.js`) enforces that the presented credential scope allows it. This is exactly the "Agent verifies the target and bounded capability" half of V2-A — it is the existing hook to extend.
- Health (`agent/src/routes/health.js:29–54`) returns: `identity` (deviceId, hostname, OS, platform, arch, agentVersion), `capabilities`, `tokenConfigured`, `tokenFingerprint`, `apiVersion: "v1"`, `protocolVersion: 1`, `process`/uptime.
- Pairing: `agent/src/routes/pairing.js` with temporary one-time codes (`start`/`status`/`complete`/`cancel`), capped attempt rate (`PAIRING_RATE_LIMITED`), writes a permanent token via `writeAgentConfigToken`, and returns `identity` + `tokenFingerprint`.
- Defaults that cause the known drift issues below: `agent/src/config.js:9` port `47131`; `:14` `DEFAULT_INSTANCE_ROOT = "/srv/anxos/instances"`; `:106` `instanceRoot: AGENT_INSTANCE_ROOT || DEFAULT_INSTANCE_ROOT` — i.e. **the `/srv` root applies on Windows too when no spawn env is set**.

### 2.3 Identity stores (what exists today)

| Identity | Format today | Where minted | Store file |
| --- | --- | --- | --- |
| Agent **deviceId** | `device-<uuid>` | Agent — `agent/src/services/deviceIdentityService.js:16` | `device-identity.json` (schema v1) at `%ANXHUB_CONFIG_DIR%` or `<cwd>/config` (`:10`) |
| Application-host **hostId** | `host-<uuid>` | Desktop — `src/services/applicationHostService.js:24` | app host identity file |
| Node **nodeId** | `agent-<sanitized deviceId[:56]>` (`nodeIdForDevice`, `src/services/nodeService.js:139`) | Desktop derives deterministically from deviceId | `nodes.json` (schema v3, `:22`) |
| Instance **id** | user-supplied slug `/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/` (`src/shared/instances/instanceServiceCore.js:595`) — **the on-disk directory name** | Desktop UI / marketplace passes it; agent stores it | instance `config.json` under instance root |
| Local owner **user** | `id: crypto.randomUUID()` (`securityService.js:1256`) ; roles Owner/Admin/User from `ROLE_PERMISSIONS` (`:40–65`) | Desktop `security:setupAdmin` / `security:login` | `security.json` (schema v1) |
| AnxOS cloud **account** | Supabase user UUID/email allowlist — `src/services/ownerAccountConfig.js` (`isOwnerAccount :87`, `owner-accounts.json`) | Cloud; desktop only records allowlist | `owner-accounts.json` + env `ANXOS_OWNER_*` |
| Agent **token** | `anxos_<base64url(32B)>` (`src/shared/agentTokenStore.js:22`) fingerprint = sha256[:12] | Desktop `rotateAgentToken` / `generateReplacementAgentToken` (`securityService:1578`, `:1756`) or pairing | `config/agent.json` (schema v1) + `security.json.agentTokens[fingerprint]` |
| **Persistent session / trusted device** | UUID session id, sha256-derived device id (`securityService.js:622`) | Desktop | `security.json` + encrypted `session.dat` |

### 2.4 Identity resolution and the wrong-node guard (already strong)

- `resolveNodeForAgentIdentity` (`nodeService.js:1369–1408`) deduplicates an agent identity onto one node by precedence: `agentInstallationId` → `agentIdentityId` → `deviceId` → `nodeId` → normalized URL. Ambiguity throws `NODE_IDENTITY_AMBIGUOUS`; no match throws `NODE_IDENTITY_NOT_REGISTERED` (`recordAuthenticatedNodeHealth :1124–1134`).
- `saveNode`/`pairNodeFromCode` require a real `deviceId` from health (`AGENT_IDENTITY_MISSING`) and reject duplicate URLs (`DUPLICATE_NODE_URL`).
- Compatibility negotiation exists: `getAgentCompatibilityReport` (`nodeService.js:504`) checks reported `apiVersion` major (supported `{1}`), `protocolVersion` (1), and a `minimumAgentVersion`. Health is stamped on the node and drives `agent_incompatible` state.

### 2.5 Known tickets this design should make cleaner (verified symptoms)

1. **Agent runs with a legacy/separate identity when NOT spawned by the desktop.** `deviceIdentityService.getIdentityPath` (`agent/src/services/deviceIdentityService.js:10`) resolves `%ANXHUB_CONFIG_DIR%` only if it is set in the agent process env. When the agent starts standalone, `ANXHUB_CONFIG_DIR` is unset, so it falls back to `<agent-cwd>/config/device-identity.json` — a **different tree** from the desktop's `%APPDATA%\AnxHub`. Result: two device-id lineages (desktop-spawned vs standalone), node re-derivation surprises, and identity drift on re-pair (`agentInstallationId`/`agentIdentityId` are read in `nodeService` yet **never minted** by the agent).
2. **Agent default instance root is Linux `/srv/anxos/instances` even on Windows** when no spawn env is set (`agent/src/config.js:14,106`). On a standalone Windows agent this root is wrong/inaccessible; the "instances appear missing" class of bug.
3. **`listInstances` silently drops unreadable configs.** `src/shared/instances/instanceServiceCore.js:4130–4148` iterates all directories under the instance root and `continue`s on any conversion error (`:4145–4147`). An operator sees fewer instances than exist with no diagnostic.

These three are **not fixed here**; the model below introduces identity + self-description hooks that make their symptoms (a) detectable and (b) surfaced honestly rather than silently wrong.

---

## 3. Proposed identity model

### 3.1 Core principle: mint once, derive deterministically everywhere else

One process mints each identity; every other layer derives or references it. No layer invents its own key for the same entity. This keeps reinstall/restore/migration semantics predictable and matches how node ids are already derived from device ids.

### 3.2 Entity → format → minted-by table (proposed)

| Entity | Stable ID (candidate format) | Minted by | Survives reinstall? | Survives restore/migrate? |
| --- | --- | --- | --- | --- |
| **Device (agent installation)** | `device-<uuid>` (existing) | Agent (`deviceIdentityService`) | Yes, if the agent config dir (`device-identity.json`) is preserved; **no** if the agent is wiped without a migration step | Preserved with device-identity.json |
| **Node** | `agent-<slug(deviceId)>` (existing `nodeIdForDevice`) | Desktop, deterministic from deviceId | Yes (re-derivable from deviceId) | Re-derivable; `nodes.json` carries the mapping |
| **Agent installation lineage** | `agenti-<uuid>` (new; one permanent per installation) | Agent, alongside deviceId | Yes (same store as deviceId) | Preserved; primary disambiguator for re-pair |
| **Agent identity generation** | `agentn-<uuid>` (new; rotated on re-pair/credential change) | Agent on each enrollment/re-pair | No (rotates intentionally) | Recorded in node history |
| **Application host (desktop "This PC")** | `host-<uuid>` (existing) | Desktop | Yes | Preserved with app data |
| **Game instance / service / workload** | keep on-disk slug as the canonical id (existing), **plus** a namespaced machine id `workload-<uuid>` for audit/correlation (new, metadata-only) | Slug: provided at create; `workload-` id: minted by agent at create | Yes — the slug is the data directory name; survives because data survives | Yes with instance data; re-imported with backup/restore |
| **Container / volume / network** | Docker engine ids remain authoritative; wrap with `nodeId + engineId` composite for routing | Docker engine; desktop only composes | No (Docker engine state) | Only via engine-level backup/move |
| **User (local)** | `usr-<uuid>` (normalize from current `randomUUID` user id) | Desktop (`securityService.setupAdmin`) | Yes | Positive; legacy-owner migration already exists (`securityService.migrateLegacyOwnerUsers`) |
| **User (cloud / optional)** | Supabase account UUID (keep as-is) | Cloud; desktop records allowlist | n/a | `owner-accounts.json` allowlist |
| **Operation / job** | `op-<uuid>` (new) | Backend (desktop) at enqueue; echoed to agent | No (ephemeral) | Audit trail in `audit.log` carries it |
| **Service token / agent token** | `anxos_<base64url>` (existing) | Desktop (rotation) or pairing | No (rotatable) | Not preserved on reinstall (by design) |

### 3.3 What is minted where (explicit)

- **Agent mints:** `deviceId` (exists), and the new `agentInstallationId` (permanent, per install) and `agentIdentityGeneration` (per re-pair). These are returned in `/api/v1/health` identity and written atomically to `device-identity.json` with a schema bump.
- **Desktop backend mints:** `hostId`, derived `nodeId`, local `usr-<uuid>`, persistent session ids, `op-<uuid>` operation ids, and agent tokens/pairing codes (all already mint there today).
- **Agent backend mints:** the workload-scoped `workload-<uuid>` metadata id for game instances at create (slug stays canonical for on-disk layout and all existing callers).
- **Nothing mints an entity id in the renderer.** Renderer only supplies opaque references it received; validation of their shape happens in main/agent.

### 3.4 Idempotency implications

- **Create semantics:** today `createInstance` returns `INSTANCE_ALREADY_EXISTS` (409) when `config.json` exists (`instanceServiceCore.js:4159–4161`). Keep this. Add an **operation key** to create/enqueue calls so a replayed UI double-click or a retried job yields one entity (see §4.5).
- **Node change detect:** derived node id + `agentIdentityGeneration` gives a cheap "same node, new key" signal; `uproot`/re-pair bumps the generation so stale tokens fail with `UNAUTHORIZED` rather than accidentally hitting a node that reused a URL.
- **Rotation:** rotating an agent token must leave device/node/instance ids untouched (they are keyed off device identity and on-disk data, not the token). Revocation (see §4.4) only invalidates the credential, never the workload identity. This preserves V1 → V2 migration (roadmap §8 A12).

### 3.5 What survives reinstall / restore / migration

- Survives: `device-identity.json` (→ node/nodeId/workload lineage), instance data (→ workload ids), `security.json` local owner users, `owner-accounts.json` allowlist, `nodes.json` structural mapping.
- Does **not** survive (by design): `session.dat`, agent tokens, `agentIdentityGeneration`. These are re-established by owner re-unlock + pairing + token rotation.
- The three drift tickets in §2.5 are reduced by making the agent *self-describe* (`agentInstallationId`, instance root, capabilities) so the desktop can (a) detect a standalone-identity mismatch and offer re-enrollment, (b) refuse or flag a `/srv` instance root on Windows, and (c) surface unreadable instance configs instead of dropping them.

---

## 4. Interfaces / contracts changes (conceptual — NOT implemented)

All additions are backward-compatible extensions of existing envelopes. No existing field is removed in this wave.

### 4.1 `GET /api/v1/health` (agent) — extend identity

Today (`agent/src/routes/health.js:30`) returns `identity { deviceId, hostname, ... }`. Add:

```jsonc
{
  "identity": {
    "deviceId": "device-...",            // existing
    "agentInstallationId": "agenti-...", // new, stable per install
    "agentIdentityGeneration": "agentn-...", // new, bumped on re-pair
    "instanceRoot": "C:\\AnxHub\\instances",  // new: actual resolved root
    "spawnedByDesktop": true              // new: whether ANXHUB_CONFIG_DIR was injected
  }
}
```

`identity.instanceRoot` and `spawnedByDesktop` make the two agent-side drift bugs (Linux root on Windows, standalone identity) legible to the desk客户端 and to diagnostics.

### 4.2 Pairing (agent) — capture identity lineage

`POST /api/v1/pairing/complete` (`agent/src/routes/pairing.js:74`) already stores the permanent token and returns `identity`. Change: persist `agentInstallationId` (minted once at first run of that install) and increment/rotate `agentIdentityGeneration` on each successful complete/cancel/re-pair. Return both in the response so the desktop can record them on the node (`nodeService.pairNodeFromCode` already writes `agentIdentity`).

### 4.3 Node/instance targeting (desktop inner-IPC)

- Keep `requireNodeContext` + `withNodeContext` as the enforcement points. **Add** an explicit `target` envelope on mutating messages so an operation carries its intent end-to-end.

```jsonc
{
  "opId": "op-<uuid>",        // minted by backend at enqueue
  "actorId": "usr-<uuid>",    // resolved local owner or cloud account id
  "target": {
    "nodeId": "agent-...",
    "hostId": "host-...",     // for application-host-local operations
    "workloadId": "workload-...", // when an instance is the object
    "engineRef": { "containerId": "...", "volumeId": "..." } // passthrough, agent-owned
  },
  "opKey": "instance.start:agent-...:workload-...:1"  // idempotency dedup key
}
```

- The desktop derives `nodeId`/`workloadId` from its own stores (never trusts renderer-supplied `nodeId` as authoritative for routing beyond selecting the target); `agentIdentityGeneration` is compared on arrival to catch stale routing.

### 4.4 Revocation / rotation / unauthorized (conceptual contracts)

- **Revoke agent:** reuses `security:revokeAgentToken` (`securityIpc.js:67`) / `rotateAgentToken`. On the agent, `UNAUTHORIZED` (401) is returned by `auth.js` for any authenticated route after the token is revoked. **Add**: the agent reports a revoked/none generation in health so the desktop marks the node `authentication_failed` and offers re-enrollment rather than leaving it silently offline.
- **Unauthorized user:** enforced on the desktop by `requirePermission` (`securityService.js:1511`) against `ROLE_PERMISSIONS`, and echoed by the agent's `authorizeApiPermission`. `PERMISSION_DENIED` is the canonical code; targets/actors are attributable through `opId` + `actorId`.

### 4.5 Job lifecycle / idempotency (conceptual contracts)

- Introduce a backend job envelope: `opId` + `opKey`. The backend keeps a short-lived dedup table keyed by `opKey` (e.g. `instance.start:<node>:<workload>`) so repeated start/stop/restart/install events collapse to one in-flight job. Cancel is by `opId`; audit events append `opId` so a timeline can be reconstructed.
- Idempotent create: the `opKey` route for create carries the chosen slug; a retry that already landed returns the existing `workload` + `INSTANCE_ALREADY_EXISTS`-equivalent info instead of erroring blindly.
- Restarting the desktop client (roadmap gate: "does not orphan server operations") is handled because jobs/operations live on the **agent** (which preserves workload state in its own data root) and the desktop only tracks `opId` for UI correlation; on client restart the agent's `recoverIncompleteInstallations`/`recoverBackupArtifacts` (`server.js:463–471`) already resume the source-of-truth.

### 4.6 Browser/remote surface (V2-A "prepare")

Keep the agent as the operator of record. The authenticated browser surface calls the same agent REST + desktop backend authority; identity comes from `opId`/`actorId`/`target`, not from a second desktop session token. No new authz system is introduced.

---

## 5. Acceptance mapping to the V2-A gate

| V2-A acceptance case | Existing mechanism | Identity-model guarantee to verify |
| --- | --- | --- |
| **Permitted operation succeeds on the intended node** | `getRequestNodeId`/`getOptionalNodeConfig`/`withNodeContext` + agent `getRoutePermission` | Every mutation carries `target.nodeId`/`hostId`; agent re-verifies capability and scope. New `agentInstallationId` confirms the arriving node is the enrolled one. |
| **Wrong-node** | `resolveNodeForAgentIdentity` (`NODE_IDENTITY_AMBIGUOUS`/`NODE_IDENTITY_NOT_REGISTERED`) + `DUPLICATE_NODE_URL` | Node id is **derived from deviceId**, so a request bound to node A cannot be applied to node B; the agent enforces path-bound instance access (already does: instance routes keyed off instance id under its own root). Verify a cross-node operation attempt yields a defined `WRONG_NODE`/`NODE_IDENTITY_*` diagnostic. |
| **Revoked agent** | `revokeAgentToken`/`rotateAgentToken` + agent `auth.js` 401 `UNAUTHORIZED` | After revocation, the node transitions to `authentication_failed`; the new `agentIdentityGeneration` makes re-pair unambiguous. Verify a revoked agent's token cannot issue any non-`/health` route. |
| **Unauthorized user** | `requirePermission` + `ROLE_PERMISSIONS` + agent `authorizeApiPermission` | `actorId` + `opId` make every denial attributable; `PERMISSION_DENIED` is returned consistently from both desktop and agent. Verify owner/admin/operator/viewer matrix incl. direct API denial (roadmap §8 A06, §6 V2-I). |
| **Duplicate request** | `INSTANCE_ALREADY_EXISTS` (409) + `instanceForgetService` tombstones + agent dedup on recover | `opKey` dedup collapses replayed start/stop/install. Verify a replayed create/start yields one entity and one audit timeline, not a second operation. |
| **Client restart orphans nothing** | agent is source of truth; `recoverIncompleteInstallations`/`recoverBackupArtifacts` at agent startup | `opId` correlation survives client restart; verify a running workload keeps running and reconnect does not duplicate work (roadmap §8 A05). |

Acceptance evidence format follows `docs/MASTER_ROADMAP.md` §8 (candidate/version; host + agent identity; scenario; expected/observed; automated + live evidence; date; reviewer; pass/fail).

---

## 6. Risks & open questions (owner decision required)

These block a faithful implementation and cannot be resolved from the code or the roadmap alone.

1. **Identity location for standalone agents (must-decide).** The legacy `%APPDATA%\AnxHub` default means standalone agents mint a separate identity tree. Should V2-A (a) require the desktop spawn contract to always inject `ANXHUB_CONFIG_DIR` so there is one canonical identity, or (b) formalize a new agent-local identity dir (e.g. XDG/`/etc/anxos` on Linux, `%PROGRAMDATA%` on Windows) independent of the desktop? This changes §3.5 "survives reinstall" guarantees.

2. **Whether to mint `agentInstallationId` + `agentIdentityGeneration` now.** The agent currently only mints `deviceId`; `nodeService` already reads (but never populates) these keys. Adopting them strengthens re-pair/revoke disambiguation (§4.1/§4.2), but is an agent data-model addition. The owner must approve the schema-v2 `device-identity.json` shape and the rotation policy for `agentIdentityGeneration` (bump on every re-pair? on credential rotate?).

3. **Instance-root and platform-scope decision.** The `/srv/anxos/instances` default on Windows (`config.js:14,106`) must be resolved: per-platform defaults, always-desktop-injected, or explicit error when unset. This directly affects how many "missing instances" complaints V2-A eliminates on Windows.

4. **`listInstances` error visibility.** §3.4/§4 note surfacing-unreadable-configs, but the owner must pick the failure policy: a partial-listing envelope with per-instance `error` detail (recommended) versus a hard failure of the whole list. This changes the agent REST contract shape.

5. **Operation-id minting authority.** Whether `opId`/`opKey` dedup is owned entirely by the desktop backend, or whether the agent should also accept an `opKey` from a non-desktop (browser/API) caller — affects the "prepare a browser management surface" goal and needs an authority decision.

6. **Token↔node binding strength.** Token is a global shared secret on the agent (`config.token`), not yet bound to a scope/permission set beyond the agent's own `permissions.js` table. V2-A's "scoped roles + bounded capability per node/workload" implies per-node or per-scope credentials; the owner must decide whether this wave introduces scoped agent credentials or keeps the single shared token and defers scoping to V2-I. This is the largest scope question in §6.

---

**Recommended next action:** Owner reviews §6 decisions 1, 2, 3, and 6 (the four that change data models or contracts); then converts the approved sections into a scoped V2-A implementation plan. No code, commit, or push is performed in this wave.