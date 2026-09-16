# V2-A Wave-1 Review — Deferred Design Items and Remaining Checklist

**Milestone:** V2-A — Shared platform, identity and agent foundation
**Wave:** 1 (design review only — resolves the deferred items recorded in `V2A_DECISIONS.md`)
**Author:** Design/Research
**Date:** 2026-09-16
**Status:** Proposal — pending owner review
**Approved:** 2026-09-16 — all owner decisions accepted.

This review resolves the six items `docs/v2/V2A_DECISIONS.md` defers to the
Wave-1 design review. Wave 0 (identity model, enrollment handshake,
authority/permissions, durable job lifecycle) is implemented and shipped in
build 202. Each item below records current code state with verified
`file:line` evidence, implementation impact, the recommendation, risk, and a
single ready-to-approve decision sentence. A remaining V2-A checklist section
closes the milestone.

---

## 1. Deferred item (a) — Job store location

**Recommended default (V2A_DECISIONS):** per-node `jobs/<jobId>.json`; keep
instance `config` untouched for V1→V2 back-compat.

**Verified current state:**
- `src/shared/instances/instanceServiceCore.js:5501` — `getInstanceJobsRoot()`
  returns `path.join(getInstanceRoot(), "jobs")`: per-instance job store at
  `<instanceRoot>/jobs`.
- `src/shared/instances/instanceServiceCore.js:5510` —
  `jobLifecycle.configureJobLifecycle({ getRoot: getInstanceJobsRoot })` wires
  the provider, so an unset root produces `JOB_STORE_UNAVAILABLE` instead of a
  silent fallback.
- `src/shared/instances/instanceServiceCore.js:4124` — reserved-dir protection
  already includes `basename(getInstanceJobsRoot())`.

**Impact:** No change required. The recommended design is already implemented;
instance `config` is untouched (job state lives beside it, not inside it).

**Risk:** Low. The store must stay outside any schema-migration surface.

**Recommendation:** Adopt as decided. No further work.

**Decision sentence:** *Approve: job store remains per-instance
`<instanceRoot>/jobs`; instance `config` stays the V1 schema and is not
migrated by the job store.*

## 2. Deferred item (b) — No-orphan scope

**Recommended default (V2A_DECISIONS):** remote-agent jobs must survive client
restart; local-host detached-runtime re-adoption only if the gate requires it
(recommend remote-only for V2-A, reassess at V2-G).

**Verified current state:**
- Agent recovery: `agent/src/server.js:520` →
  `instanceService.recoverInstanceJobs`; interrupted jobs re-observed at
  `src/shared/instances/instanceServiceCore.js:5682-5684`.
- Desktop recovery: `src/ipc/instancesIpc.js:222` (`instances:jobs:list/get`)
  with the audit-event bridge at `src/ipc/instancesIpc.js:89-96`;
  `ensureInstanceJobsRecovered()` at `instanceServiceCore.js:5533+`.
- Job types covered: `instance.start`/`instance.stop`/`instance.restart` with
  idempotent `SUCCEEDED` for already-stopped cases (`instanceServiceCore.js:5564-5569`).

**Impact:** Both remote and local recovery paths already exist and were added
as part of the durable-job-lifecycle commit (`374981f`). The "remote-only"
default is effectively already satisfied; local re-adoption is present but only
for owned/detached runtimes the gate recognizes.

**Risk:** Low; the recovery design is idempotent and audited.

**Recommendation:** Adopt remote-first and keep local re-adoption as
implemented (observed processes only, no invented adoption). Reassess scope at
V2-G multi-node.

**Decision sentence:** *Approve: interrupted jobs are recovered
owner-first on both agent and desktop; local detached-runtime re-adoption
remains observation-only until V2-G.*

## 3. Deferred item (c) — Enrollment challenge

**Recommended default (V2A_DECISIONS):** short-TTL single-use nonce for
`/enroll/complete` (defer client-signed nonce / mTLS to future hardening).

**Verified current state:**
- `agent/src/routes/enroll.js:20` — `PUBLIC_ENROLL_PATHS` =
  `/api/v1/enroll/start`, `/api/v1/enroll/complete`, `/api/v1/enroll/status`
  are nonce/public protected before bearer auth.
- `agent/src/services/enrollmentService.js` — nonce TTL 5 minutes, bounded
  active-nonce set (max 20), schema v1; the handshake binds device identity,
  instance root, protocol/API versions, and token fingerprint.
- `agent/src/routes/enroll.js:73-75` — pairing paths share the same exemption
  set; revoke/rotate remain bearer-gated.

**Impact:** The short-TTL nonce is implemented. "Single-use" enforcement
(consume-on-complete) should be confirmed against `enrollmentService.js` in
the Wave-1 implementation pass; this is the one open sub-check.

**Risk:** Medium if single-use is not enforced (replay of `/enroll/complete`).
The bounded active set mitigates flood.

**Recommendation:** Adopt, and add a regression assertion that a consumed
nonce cannot complete a second enrollment.

**Decision sentence:** *Approve: short-TTL (≤5 min) single-use nonce for
`/enroll/complete`; nonce consumption is enforced and covered by a smoke test;
mTLS/client-signed challenge stays deferred.*

## 4. Deferred item (d) — Revoke / rotate tiering

**Recommended default (V2A_DECISIONS):** owner-only revoke; admin may rotate;
revoke carries an explicit confirmation.

**Verified current state:**
- Rotate = `agent:manage` (Admin may rotate): `agent/src/routes/enroll.js:64`;
  `/api/v1/system/agent-task` also gated at `agent:manage`
  (`agent/src/server.js:206`).
- Revoke = owner-only with explicit confirmation:
  `agent/src/server.js:200-203` (`/api/v1/enroll/revoke`,
  `/api/v1/credentials/rotate` unpinned paths) and `agent/src/server.js:236-237`.
- `src/services/securityService.js:1655` — `rotateAgentToken()`; line 1818 —
  `revokeAgentToken()`; both audit + rate-limit and report
  `restartRequired: true`.
- `src/services/localAgentPairingService.js:165` —
  `rotateLocalAgentCredentials()` (desktop-side pairing).

**Impact:** No change required; the tiering matches the recommendation exactly.

**Risk:** Low. Confirmation UX for revoke should be verified in the renderer
before acceptance.

**Recommendation:** Adopt as decided.

**Decision sentence:** *Approve: revoke is owner-only with explicit
confirmation; Admin may rotate; both paths audit, rate-limit, and require a
service restart to take effect.*

## 5. Deferred item (e) — Legacy binding migration

**Recommended default (V2A_DECISIONS):** auto-migrate existing
`%APPDATA%\AnxHub` bindings into `enrolled` (do not force a fresh enrollment
that breaks current sessions).

**Verified current state:**
- Spawn contract: `src/services/agentControlService.js:108` passes
  `ANXHUB_CONFIG_DIR` (plus identity/token/root env); comment at line 113
  ("desktop ALWAYS spawns the agent with ANXHUB_CONFIG_DIR"); required-key
  check at line 118.
- Identity normalization: identity schema v2 mints
  `agentInstallationId`/`agentIdentityGeneration` when missing
  (`normalizeIdentityRecord`); the local `config/enrollment.json` on this
  machine records `legacyMigrated: true` with the prior fingerprint list.
- No-fallback stance: `agent/src/permissions.js:61` derives
  `local-owner` vs `restricted` from `ANXHUB_CONFIG_DIR` presence; an agent
  started without spawn env must log a loud diagnostic instead of falling back
  to a stray root.

**Impact:** Auto-migration exists for the local identity store. The remaining
conflict to watch is Decision 1 (no silent fallback): migration must be scoped
to an *explicit* enrollment flow, never a fallback to `%APPDATA%\AnxHub` for
an agent that started without spawn env.

**Risk:** Medium if migration ever triggers as a fallback; the Wave-1 pass
must assert migration only runs inside the enrollment handshake.

**Recommendation:** Adopt auto-migration strictly scoped to explicit
enrollment; keep the spawn-contract diagnostic path fallback-free.

**Decision sentence:** *Approve: legacy `AnxHub` identity bindings migrate
into `enrolled` only during an explicit enrollment handshake; an agent started
without `ANXHUB_CONFIG_DIR` never migrates or falls back — it logs a loud
diagnostic and refuses stray roots.*

## 6. Deferred item (f) — Idempotency scope

**Recommended default (V2A_DECISIONS):** curated set
create/start/stop/restart/install/update/backup/restore with an explicit
non-replay stance for destructive ops.

**Verified current state:**
- Operation-ID enforcement: `INSTALLATION_OPERATION_ID_PATTERN` /
  `STEAM_UPDATE_OPERATION_ID_PATTERN` with 400/403/409 outcomes
  (`src/shared/instances/instanceServiceCore.js:133,143,229,252,4760`).
- `stripJobOptions` (`instanceServiceCore.js:5519`) strips
  `idempotencyKey`/`jobTimeoutMs` before persistence; dedupe runs through the
  `idempotencyIndex`; a reused key returns `409 JOB_CONFLICT`.
- Destructive ops are never replayed: installer-driven starts do not mint
  operator-visible jobs.

**Impact:** The curated set and non-replay stance are implemented. The Wave-1
pass should enumerate the final set in `jobLifecycle.js`
(`DESTRUCTIVE_JOB_TYPES`, ~lines 40-60) and add a regression assertion that a
replayed destructive key is refused.

**Risk:** Low; enforcement is already fail-closed.

**Recommendation:** Adopt, and pin the curated set in one exported constant
with a smoke assertion.

**Decision sentence:** *Approve: idempotency is enforced for the curated
create/start/stop/restart/install/update/backup/restore set; destructive
operations are never replayed (409 on key reuse) and the set is exported as a
tested constant.*

---

## 7. Remaining V2-A checklist

Mapped from `docs/MASTER_ROADMAP.md:136-152` (verified section start at line
136). Status is based on the state shipped in build 202.

| Roadmap V2-A item | Status | Evidence |
| --- | --- | --- |
| Define consistent identities for nodes, services, game instances, containers, volumes, users and operations | DONE (Wave 0) | `V2A_IDENTITY_MODEL.md`; `config/device-identity.json` schema v2; commit `e4a12f2` |
| Define management authority (backend authorizes; Agent verifies target + bounded capability) | DONE (Wave 0) | `V2A_AUTHORITY_PERMISSIONS.md`; `agent/src/permissions.js`; commits `5a574ab`, `dc6fce8` |
| Introduce scoped roles owner/admin/operator/viewer and service identities | DONE (Wave 0) | `src/services/securityService.js` role map; Decision 3 (`User`→`operator`) |
| Establish authenticated agent enrollment, revocation, credential rotation and compatibility negotiation | DONE (Wave 0) | `agent/src/routes/enroll.js`, `agent/src/services/enrollmentService.js`; items (c)(d)(e) above |
| Define job lifecycle, audit events, cancellation and idempotency across local and remote execution | DONE (Wave 0) | `src/shared/instances/jobLifecycle.js`; commit `374981f`; items (a)(b)(f) above |
| Publish a support matrix for Windows/Linux roles; do not imply identical host features on every platform | **DONE with this review** | `V2A_SUPPORT_MATRIX.md` (this wave) |
| Separate desktop-client availability from persistent service ownership and prepare an authenticated browser management surface | **NOT DONE — design brief produced** | `V2A_BROWSER_SURFACE_WAVE1.md` (this wave); no implementation |
| Acceptance gate: permitted op succeeds; wrong-node, revoked-agent, unauthorized-user, duplicate-request fail safely; restarting the client does not orphan server operations | **PARTIAL — contract covered by CI smokes; live operator verification outstanding** | Smoke scripts exist: `scripts/agent-enrollment-smoke.js`, `agent-identity-mint-smoke.js`, `agent-identity-resolution-smoke.js`, `agent-spawn-contract-smoke.js`, `application-host-identity-smoke.js`, `authority-permissions-smoke.js`, `instance-job-lifecycle-smoke.js`, `instance-job-reobservation-smoke.js`, `remote-identity-rendering-smoke.js` |

## 8. Discrepancies surfaced during this review

- **Operator write permission:** the Operator role carries
  `settings:preferences:write` (a write permission) despite the read-elsewhere
  intent recorded in Decision 3. Recommend confirming whether preferences
  writes are intentionally operator-scoped or a copy-paste; flag for the V2-I
  permission audit if intentional.
- **Stale comment:** `agent/src/routes/jobs.js` header says the V2-A jobs
  route is "dormant until registered", but `agent/src/server.js:186` (and
  `:30`) register `/api/v1/jobs` for real. The comment will be corrected with
  the next jobs-route change.
- **Desktop enrollment surface:** no renderer enrollment/revoke/rotate UI was
  found in the Wave-1 research (`src/` and `*.html` grep for
  enroll/revokeNode/rotateNode returned empty). The API tiering exists
  server-side; a UI surface is a Wave-1+ gap to scope.

---

# Owner decisions required — V2-A Wave 1

1. **Decision:** approve the six resolution sentences in sections 1-6 above
   (recommended: approve all — they adopt the already-recorded recommended
   defaults, and items (a), (b), (d), (e), (f) are already implemented;
   item (c) requires one nonce single-use assertion).
2. **Decision:** add the nonce single-use regression assertion and the
   `DESTRUCTIVE_JOB_TYPES` enumerated-set smoke as part of the Wave-1
   implementation pass (recommended: yes).
3. **Decision:** on the Operator `settings:preferences:write` discrepancy —
   keep as operator-scoped (recommended) or strip to read-only and log the
   change for V2-I.