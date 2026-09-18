# V2-A Agent Enrollment & Lifecycle — Design Brief (Wave 0)

**Milestone:** V2-A — Shared platform, identity and agent foundation
**Wave:** 0 (design brief only — no code changes, no commits, no pushes)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review

This brief designs **authenticated agent enrollment, revocation, credential rotation,
and compatibility negotiation** per `docs/MASTER_ROADMAP.md` §6 (V2-A). It is grounded in
the current source so the proposed contracts match reality. It documents the primary
motivating defect (legacy-identity fallback for a standalone Windows agent) and proposes a
minimal, backwards-compatible handshake that closes it cleanly.

---

## 1. Goal & scope

Roadmap V2-A checklist item this brief serves:

> **Establish authenticated agent enrollment, revocation, credential rotation and
> compatibility negotiation.**

Acceptance-gate sentence this brief supports:

> A permitted operation succeeds on the intended node; wrong-node, revoked-agent,
> unauthorized-user and duplicate-request cases fail safely with useful diagnostics.

### In scope

- **Enrollment:** a first-contact handshake that forces an explicit, persistent binding of
  **(node identity, agent runtime version, instance root, protocol version, agent token)**
  before the agent is trusted for any authenticated operation.
- **Identity binding:** enroll on the agent's **device identity** (`deviceId`
  heartbeat/`hostname`/`platform`/`arch` from `device-identity.json`), **not** a legacy
  AnxHub account identity.
- **Instance-root pinning:** record and later re-verify the resolved `instanceRoot` at
  enrollment so a later change/fallback cannot silently target a different tree.
- **Compatibility negotiation:** on version skew, negotiate/refuse at enrollment (protocol
  version + agent API major version + minimum agent version already validated client-side).
- **Credential rotation:** rotate the shared agent bearer token without exposing the raw
  secret in logs, screenshots, diagnostics, or history.
- **Revocation:** an explicit, recorded revoke path that removes trust for a node and
  invalidates its credential server-side.
- **Failure semantics:** wrong-node, revoked-agent, version-mismatch, and
  replay/duplicate-enrollment cases each fail with a distinct, useful error.

### Out of scope (this Wave)

- Node/role/permission matrix (owner/admin/operator/viewer) and per-node workload
  permissions — separate V2-A items.
- Job lifecycle, audit-event schema, cancellation/idempotency — separate V2-A items.
- Multi-node networking/transport hardening (TLS, mTLS) — the current loopback/cleartext
  local design is preserved; only the handshake and its persisted state are added.
- Browser management surface.

---

## 2. Current-state fidelity notes (verified file:line)

All paths relative to repo root. Line numbers verified against working tree on 2026-09-16.

### 2.1 Agent REST server (port `47131`)

- `agent/src/config.js:9` — `DEFAULT_PORT = 47131`.
- `agent/src/server.js` — HTTP server. `getRoutePermission()` returns `null` (public) only
  for `/api/v1/health`; every other route requires authorization.
- `agent/src/auth.js` — `isAuthorized()`: public route set is exactly `{/api/v1/health}`;
  otherwise requires `config.token` supplied via `x-agent-token` header or
  `Authorization: Bearer <token>`; compared with `crypto.timingSafeEqual`.
- `agent/src/config.js:91-120` `getConfig()` — token is resolved by
  `resolveSharedAgentToken({ cwd, environmentToken: process.env.AGENT_TOKEN })`
  (`agent/src/config.js:92-94, 97`). If no usable token exists, one is **generated** and
  persisted (see token store below). This is a shared-symmetric-secret model: whoever
  holds the token is "the agent owner."

### 2.2 Current identity + instance-root derivation

- Identity: `agent/src/services/deviceIdentityService.js`
  - `getIdentityPath()` (lines ~14-16) resolves as:
    `AGENT_IDENTITY_PATH || path.join(ANXHUB_CONFIG_DIR || path.join(process.cwd(),"config"), "device-identity.json")`.
  - `getDeviceIdentity()` (lines ~46-56) returns `{ deviceId, hostname, operatingSystem,
    platform, architecture, agentVersion }`; `deviceId` is `device-<uuid>` (schema v1).
- Instance root: `agent/src/config.js:14` `DEFAULT_INSTANCE_ROOT = "/srv/anxos/instances"`;
  `agent/src/config.js:106` `instanceRoot: process.env.AGENT_INSTANCE_ROOT || DEFAULT_INSTANCE_ROOT`.

### 2.3 How the desktop spawns/talks to the agent

- Desktop spawn env: `src/services/agentControlService.js:108` `agentEnvironment(config)`
  builds the child env: `AGENT_HOST`, `AGENT_PORT`, `AGENT_FILE_ROOTS`,
  `AGENT_INSTANCE_ROOT` (= desktop `getAgentInstancesDirectory()` under userData/agent),
  `AGENT_BACKUP_ROOT`, `AGENT_LOG_DIR`, `AGENT_TEMP_DIR`,
  `AGENT_IDENTITY_PATH` (= desktop userData/agent/device-identity.json),
  `ANXHUB_CONFIG_DIR` (= desktop `getConfigDirectory()`, app userData/config), plus
  `ANXOS_LOCAL_AGENT_RUNTIME_ROOT`/`MANIFEST`.
- Linux systemd user unit duplicates these env vars (`src/services/agentControlService.js:504`).
- Desktop↔agent client: `src/services/agentClient.js` (default URL
  `http://127.0.0.1:47131`); token resolved/shared via `src/shared/agentTokenStore.js`.
- Node modeling: `src/services/nodeService.js` — `nodeIdForDevice()` (line ~139) →
  `agent-<deviceId>`; `SUPPORTED_AGENT_API_MAJOR_VERSIONS = {1}` and
  `MIN_AGENT_PROTOCOL_VERSION = MAX_AGENT_PROTOCOL_VERSION = 1` (lines ~27-30);
  `agent_incompatible` health state and version-compatibility computation (lines ~506-554:
  reported agent version vs `minimumAgentVersion`, protocol-version bounds).

### 2.4 Existing enrollment/pairing and token storage

- Temporary pairing: `agent/src/routes/pairing.js` — `createSession()` +
  `completePairing()`. `completePairing` writes the **permanent** token via
  `writeAgentConfigToken(configPath, permanentToken, {backendMode, agentUrl})`
  (lines ~96-117) but performs **no identity/root/version binding** and records no
  enrollment state. Code schema: `src/shared/agentPairing.js` (payload type
  `anxos-agent-temporary-pairing`, TTL 10 min).
- Permanent token store: `src/shared/agentTokenStore.js` — `generateAgentToken()`
  (`anxos_<32-byte base64url>`), `tokenFingerprint()` (sha256 → first 12 hex), atomic
  0600 writes, `resolveSharedAgentToken()` source order is
  **stored config → env `AGENT_TOKEN` → generated**. `createAgentPairingPayload()` is the
  desktop-side permanent-token container (type `anxos-agent-pairing`).
- Desktop credential storage conventions:
  - `src/services/nodeCredentialStore.js` — per-node agent tokens, encrypted via
    `encryptPayload` (`secureSessionStore`), file `node-agent-credentials.json`, schema v2.
  - `src/services/localAgentPairingService.js` — `SecureSessionStore`
    `local-agent-credentials.json`, loopback-scoped, for the "This PC" local agent.
  - `agent/config/agent.json` in this tree also holds a plaintext `agentToken`; treat any
    such file as a secret store (all artifacts/logs untrusted).
- Redaction utility: `src/shared/redaction.js` — `sanitizeForDiagnostics()`; `SENSITIVE_KEY`
  matches `token|secret|agent_token|password|...`; used by the agent server
  (`agent/src/server.js:6`) for error details. **All logs, screenshots, and generated
  history must route through redaction.**

### 2.5 Legacy-fallback defect (primary motivation, verified)

When a Windows agent is started **without the desktop spawn env**, its configuration
resolves through fallbacks:

1. **Identity** falls back from the desktop-provided `AGENT_IDENTITY_PATH` to
   `ANXHUB_CONFIG_DIR`/`device-identity.json`, or `cwd/config/device-identity.json`
   (`deviceIdentityService.js` `getIdentityPath()`). The legacy standalone Windows install
   sets `ANXHUB_CONFIG_DIR` to `%APPDATA%\AnxHub\config` (legacy AnxHub location;
   referenced throughout `scripts/*.js` and the historical
   `AnxHub\agent\bin\start-local-agent.vbs`), yielding a **legacy AnxHub identity/token**
   instead of a fresh node enrollment.
2. **Instance root** falls back to `DEFAULT_INSTANCE_ROOT = "/srv/anxos/instances"`
   (`agent/src/config.js:14,106`) when `AGENT_INSTANCE_ROOT` is absent — an invalid default
   on Windows.
3. **No binding:** the single shared bearer token alone establishes trust. There is no
   recorded (deviceId, version, instanceRoot, protocolVersion, fingerprint) tuple, so a
   legacy or rogue agent that holds any valid token is indistinguishable from an enrolled
   one. Nothing forces an explicit first-contact enrollment; the agent silently serves as
   a default/legacy identity.

This is the gap the enrollment handshake (Section 3) closes.

---

## 3. Proposed enrollment handshake

Conceptual design; interfaces are specified in Section 4. Preserves backwards
compatibility: when no enrollment record exists, the agent stays in `unpaired`/`unenrolled`
state and **refuses all non-`/health`, non-`/pairing` traffic** until enrollment completes.

### 3.1 States (agent-side persisted record `enrollment.json`, schema v1)

| State | Meaning | Authenticated data endpoints? |
| --- | --- | --- |
| `unenrolled` | No enrollment record yet (fresh or post-revoke). | Refuse (except `/health`, `/pairing/*`). |
| `pending` | Handshake started; nonce/partial state held; not yet trusted. | Refuse. |
| `enrolled` | Record bound; token matches fingerprint; root verified. | Allow per permission. |
| `revoked` | Revoked by owner; only `/health` + a specific revive path allowed. | Refuse. |

The record binds exactly one tuple:

```json
{
  "schemaVersion": 1,
  "state": "enrolled",
  "nodeIdentity": { "deviceId": "device-<uuid>", "hostname": "...", "platform": "...", "architecture": "...", "agentVersion": "..." },
  "instanceRoot": "<abs path captured at enrollment>",
  "protocolVersion": 1,
  "apiMajorVersion": 1,
  "tokenFingerprint": "<sha256[:12]>",
  "ownerFingerprint": "<owner-presented proof, optional>",
  "enrolledAtIso": "...",
  "revokedAtIso": null,
  "revokeReason": null,
  "previousFingerprints": []
}
```

### 3.2 Flow

1. **Discover (public, unauthenticated):** client calls `GET /api/v1/health`. Returns
   `identity` (deviceId, hostname, OS, platform, arch, agentVersion) and `enrollment` state
   (public summary only — never the token or root). Client uses identity to route to the
   correct node record (wrong-node detection starts here).
2. **Negotiate (public):** client calls `POST /api/v1/enroll/start` with its supported
   min/max protocol + API versions and `minimumAgentVersion`. Agent replies with its
   `protocolVersion`, `apiMajorVersion`, `agentVersion`, and a short-lived **enroll nonce**
   (`enrollNonce`, TTL e.g. 5 min, single-use). Version skew is resolved here or refused
   with `AGENT_VERSION_INCOMPATIBLE`/`PROTOCOL_VERSION_UNSUPPORTED` before any credential
   is exchanged.
3. **Bind (public + nonce-protected):** client calls `POST /api/v1/enroll/complete`
   presenting `enrollNonce` + `nonceSignature` (proof it witnessed/created the nonce — see
   open question O1), a fresh/bound **agent token**, and an explicit **pinned instance
   root** that the client asserts (normally the desktop spawn root). Agent:
   - validates the nonce (exists, unexpired, single-use);
   - **repair-authority gate** (V2-I hardening, 2026-09-18): when an enrollment record
     already exists and is not `revoked`, the caller must also prove possession of the
     credential already in force — either the record-bound fingerprint or the agent's live
     credential (accepted spellings: `previousAgentToken` / `previousCredential`, or the
     same token re-presented as `agentToken`). Without it the request is refused with
     `ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL` (403), audited, and **nothing is
     mutated**. Rationale: completion alone accepted any caller-chosen token, so any client
     that could reach the agent port could re-pair and drop its `scopes`, escalating to
     full profile permissions — that made the scoped-token guarantee non-binding. First
     enrollment (no record) and re-enrollment after `revoked` remain open; the latter is
     audited as `ENROLL_REENROLL_AFTER_REVOCATION`.
   - captures its **actual resolved identity** from `deviceIdentityService.getDeviceIdentity()`
     (not anything the client claims) and the **actual** `config.instanceRoot`;
   - verifies the pinned root either matches the actual root or is explicitly accepted as
     an override for this enrollment (see 3.3);
   - stores `tokenFingerprint` (never the raw token), sets state `enrolled`, and attaches
     the binding to the persisted agent config;
   - returns `enrollmentId`, bound identity, root, versions, and a public fingerprint.
   - **Known residual (recorded, owner-scoped follow-up):** a holder of a *scoped*
     credential can still re-pair with that same credential and drop its scopes, because
     "possessing the existing credential" is the accepted authority. Closing that requires
     an owner-authorized scope-change path (owner-tier bearer or a separate approval
     token).
   - **Known residual — P1, proven, NOT closed (2026-09-18):** the gate is
     **defense-in-depth, not an authorization boundary**. `/api/v1/pairing/start` is
     pre-auth and returns the pairing code to the same caller, and
     `/api/v1/pairing/complete` sets `config.token` to a caller-chosen value. An
     unauthenticated client that can reach the agent port can therefore pair (installing a
     credential of its choosing) and then satisfy the gate's live-credential branch. This
     was reproduced end to end by an independent adversarial review: a control re-pair
     without pairing was refused 403, while the pair-then-enroll sequence succeeded 200 and
     rebound the record's `tokenFingerprint` with caller-chosen `scopes`. Closing it
     requires an authorization rule on the **pairing surface itself** (for example: an
     already-enrolled agent accepts a new pairing only from loopback or an
     owner-authenticated desktop request), which is an owner-scoped decision because it
     changes V2-A pairing semantics. Tracked in the security queue of
     `V2_CAMPAIGN_QUEUES.md`.
   - **Why the live credential is accepted at all:** the legitimate repair flow pairs a
     node (rotating the shared config token via `POST /api/v1/pairing/complete`) and then
     completes enrollment with the rotated credential while the persisted record
     fingerprint is still stale. A record-bound-only gate therefore refuses a legitimate
     re-pair: `scripts/multi-node-fleet-smoke.js` exercises that exact sequence and fails
     403 where it asserts 200. That acceptance is pinned in `agent-enroll-smoke.js` so a
     future tightening cannot land silently.
4. **Authenticated use:** every subsequent request presents the token; the agent compares
   fingerprint to the enrollment record **and** re-verifies that `config.instanceRoot` is
   unchanged and the identity deviceId is unchanged. Discrepancy ⇒ `NODE_BINDING_MISMATCH`
   (453) and the agent drops to `unenrolled`.
5. **Rotate (owner-authenticated):** owner calls `POST /api/v1/credentials/rotate` with the
   current token. Agent issues a new token, appends the old fingerprint to
   `previousFingerprints` (kept for a short grace window so in-flight clients can complete),
   and returns the new token. The desktop stores only the new fingerprint in the
   enrollment record and re-encrypts the new token in its credential store. Raw tokens are
   never emitted into logs or diagnostics.
6. **Revoke (owner-authenticated):** owner calls `POST /api/v1/enroll/revoke`. Agent sets
   state `revoked`, `revokedAtIso`, `revokeReason`, clears the active token fingerprint, and
   refuses data endpoints. A subsequent enrollment is a fresh `unenrolled → enrolled` cycle
   (a NEW device-identity binding, not a resume of the old one; see 3.4).

### 3.3 Instance-root pinning rule

- Primary rule: enroll on the **actual** `config.instanceRoot` the agent resolved from its
  spawn env, so the standalone legacy default `/srv/anxos/instances` (Section 2.5) will be
  captured as-is but flagged, not trusted.
- Explicit override: the client may propose a **pinned root**. The agent accepts the pin
  only when (a) the nonce is fresh and (b) the client's pin is a well-formed absolute path
  within the agent's configured allowed folder set (`config.allowedFolders`). The pinned
  root is stored and enforced on every authenticated request.
- Post-enrollment drift (root changed via env at next spawn) ⇒ `NODE_BINDING_MISMATCH`;
  the agent re-enrolls (or the owner re-pins) rather than silently serving a new tree.

### 3.4 Credential rotation without exposing secrets

- Store only `tokenFingerprint` in the enrollment record; never the raw token.
- Follow existing conventions: raw token lives only in the 0600 agent config and the
  desktop's encrypted `nodeCredentialStore`/`SecureSessionStore`.
- Rotation uses a two-token overlap: the new token is usable immediately, the old
  fingerprint remains valid for a configurable grace (default e.g. 60 s) and is removed by
  a later confirmation; this lets already-running clients finish in-flight operations
  without dropping them (matches V2-A "restarting the client must not orphan server
  operations").
- Revocation is permanent: no grace; old fingerprints are not revived.

---

## 4. Interfaces / contracts changes (conceptual)

### 4.1 Agent REST (public where noted, all JSON, `Cache-Control: no-store`)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | public (existing) | Add `enrollment.state`, keep `identity`/`protocolVersion`/`apiVersion`/`tokenFingerprint` (public-safe). |
| `POST /api/v1/enroll/start` | public | Version negotiation; returns `protocolVersion`,`apiMajorVersion`,`agentVersion`,`enrollNonce`,`enrollNonceExpiresAt`. |
| `POST /api/v1/enroll/complete` | nonce-protected | Returns `enrollmentId`, bound identity, instanceRoot, versions, `tokenFingerprint`. |
| `POST /api/v1/credentials/rotate` | bearer (current token) | Returns `token`,`tokenFingerprint`,`previousFingerprint`,`restartRequired`(false unless env-persisted). |
| `POST /api/v1/enroll/revoke` | bearer | Sets `revoked`; returns `enrollmentId`,`state`. |
| `GET /api/v1/enroll/status` | public | Public status summary (state + public identity); used to detect a reused/duplicate node. |

`/api/v1/pairing/*` remains the legacy temporary-code path; on next major version it may be
deprecated in favor of `/enroll/*`.

### 4.2 Desktop IPC (conceptual, non-exhaustive)

- Extend node health classification (`nodeService` `agent_incompatible`) to also surface
  enrollment state: `unenrolled_needs_enrollment`, `enrollment_pending`, `revoked`.
- New owner-triggered actions: enroll node, revoke node, rotate node credential. These reuse
  existing permission-gated IPC patterns (`src/ipc/securityIpc.js`, `src/ipc/*`).

### 4.3 Persisted contracts (conceptual)

- Agent: new `enrollment.json` (schema v1) committed atomically, 0600, alongside the existing
  config store. The enrollment record is the single source of truth for node binding.
- Desktop node record (`nodes.json` via `nodeService`): add `enrollmentState`,
  `enrollmentId`, `instanceRoot`, `enrolledAgentVersion`. Device token remains in
  `nodeCredentialStore` (encrypted).

---

## 5. Failure semantics (distinct, useful errors)

| Case | What happens | Error / state |
| --- | --- | --- |
| **Wrong node** (client targets device B with a token bound to A, or reuses A's deviceId on a different machine) | `/health` identity differs from client's bound node, or token fingerprint not in B's record | `WRONG_NODE` / `NODE_BINDING_MISMATCH` (453); no data endpoints; `agent_incompatible`/`authentication_failed` health. |
| **Revoked agent** | Token fingerprint absent / state `revoked` | `REVOKED` (410); only `/health` + `/enroll/*`; desktop surfaces "Node revoked — re-enroll." |
| **Version mismatch** | Client min > agent, or protocol outside `[1,1]` / API major not in `{1}` | Refused at `/enroll/start` with `AGENT_VERSION_INCOMPATIBLE` / `PROTOCOL_VERSION_UNSUPPORTED`; desktop shows an actionable "update agent/client" state (already modeled by `agent_incompatible`). |
| **Replay / duplicate enrollment** | Old `enrollNonce` replayed | `ENROLL_NONCE_REUSED` (409); nonce single-use. Re-enrolling an already-`enrolled` node over a fresh nonce yields a **new** `enrollmentId`/fingerprint and revokes the previous binding (old token stops working) — duplicate-request case rejected. |
| **Instance-root drift** after enroll | `config.instanceRoot` != pinned | `NODE_BINDING_MISMATCH` (453) on next authed call; agent drops to `unenrolled`. |
| **Missing token / unenrolled** | state `unenrolled` | Existing `AGENT_TOKEN_MISSING` (503) message is reworded to include "enroll this Agent." |

All error bodies pass through `sanitizeForDiagnostics` (`src/shared/redaction.js`) before
logging; never include raw tokens, roots, or private path prefixes except as redacted.

---

## 6. Risks & open questions for the owner

### Open questions

- **O1 — Nonce proof of possession.** Should `/enroll/complete` require a
  cryptographic proof (e.g. client signs the nonce with a per-install keypair) or is a
  fresh random nonce short-TTL session sufficient given the loopback/threat model? A
  keypair would let a future HTTPS/mTLS upgrade reuse the same identity; it also adds key
  management. Recommend: start with nonce-TTL only; add signature binding only if a
  non-loopback transport becomes a goal.
- **O2 — Who may revoke/rotate, and tiering.** The roadmap wants scoped roles
  (owner/admin/operator/viewer). This brief assumes owner-only revoke/rotate. Do admin
  operators get rotate (not revoke)? Should revocation require an extra confirmation
  beyond the existing ADP gates? (Recommend owner-only for revoke; admin may rotate.)
- **O3 — Migration from legacy/duplicate identities.** Existing machines already carry a
  legacy `%APPDATA%\AnxHub\config` identity and possibly old `enrollment`-less tokens.
  Should V2-A **auto-migrate** that legacy binding into an enrollment, or force a fresh
  enrollment (breaking current sessions once) for correctness? The clean fix favors fresh
  enrollment; confirm the user-impact/opt-out.

### Risks / notes for owner

- **Backwards compatibility:** making `unenrolled` refuse data endpoints is a behavior
  change on upgrade for any agent currently authenticated by token alone. Mitigate by
  auto-migrating the current local-agent binding into `enrolled` once (O3), or gate the
  refusal behind the V2-A feature flag.
- **Standalone/default root:** the fixed default `/srv/anxos/instances` must not be
  silently trusted; pinning (3.3) is the control. Windows agents without a desktop spawn
  env must not resolve to that root.
- **Secret hygiene:** a real-looking plaintext `agent/config/agent.json` token is present in
  this tree; confirm it is not a live secret and keep it out of future builds. All token
  values are redacted by `src/shared/redaction.js` from logs/diagnostics.
- **No code/tests were changed in this Wave.** No commits or pushes. The design is ready for
  owner review before any implementation Wave.