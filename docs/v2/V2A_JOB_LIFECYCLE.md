# V2-A Job Lifecycle — Design Brief

**Wave 0 · V2-A · docs only (no code, no commits, no pushes)**

- **Milestone framing:** `docs/MASTER_ROADMAP.md` §6 *V2-A — Shared platform, identity and agent foundation*, checklist item *"Define job lifecycle, audit events, cancellation and idempotency across local and remote execution."* and the acceptance gate *"Restarting the client does not orphan server operations."*
- **Status labels per roadmap §1.2:** §2 current-state notes are **verified against this checkout** (`git rev f44ff2b`, 2026-09-16). §3+ are `RECONSTRUCTED / PROPOSED` — a design to be reconciled by the owner before implementation. This brief is a sibling of `docs/v2/V2A_IDENTITY_MODEL.md`, `docs/v2/V2A_AUTHORITY_PERMISSIONS.md`, and `docs/v2/V2A_AGENT_ENROLLMENT.md`.

---

## 1. Goal & Scope

V2-A requires a **job lifecycle** that spans local (application-host) and remote (Agent) execution, with audit events, cancellation, and idempotency, such that **restarting the desktop client never orphans a server-side operation**.

Concretely, this brief proposes:

- A first-class **job record** with a stable id, target, owner, state machine, timestamps, error/exit detail, and a persistent audit-event log that both local and remote execution append to.
- **Idempotency keys** so a duplicate request (retry after timeout, double-click, network replay) cannot run a destructive operation twice.
- A **cancellation path** for both local (child process kill / session cancel) and remote (Agent REST cancel) execution.
- The key ownership invariant that makes *"client restart does not orphan server operations"* hold: **job ownership and re-adoption live server/agent-side** (persisted PID + identity verification in the process that owns the child), never in the renderer.

**Explicit scope decisions for this brief:**

1. **Do not invent a new scheduler.** The existing `setInterval`/`setTimeout` ownership in `src/shared/instances/instanceServiceCore.js` and the Agent's installation-session model (`beginInstallationSession`/`cancelInstallationSession`) are the seams to formalize, not replace.
2. **Reuse the existing audit path.** Desktop audit already appends structured, redacted records to `audit.log` via `securityService.audit()`; the Agent already emits `scope: "agent_action_audit"` JSON lines. The job-lifecycle audit-event log extends these, it does not add a third parallel store.
3. **Backwards compatible.** Existing installs/instances and their on-disk `config.json` `state`/`pid` fields remain valid and continue to be reconciled by the current code; the new job record is additive.
4. **Docs only.** No source changes, no `.dev-logs` writes, no commit. Contracts in §4 are conceptual.

---

## 2. Current-State Fidelity Notes (verified against checkout)

### 2.1 Renderer polling model (the "1.4s" claim, corrected)

The premise in the task brief that the desktop "polls `instances:list` ~every 1.4s" is **not what the code does**. Verified in `app.js`:

- `const INSTANCE_PAGE_REFRESH_INTERVAL_MS = 5000;` (`app.js:1125`) — the Instances page refresh runs on a **5s** `window.setInterval`. The poller `startInstancesPagePolling()` (`app.js:19002`) calls `refreshInstances()` each tick, and **only while the Instances page is active**, not continuously (`startInstancesPagePolling` `app.js:19006–19016`; it self-stops when the user leaves the page).
- `const CONSOLE_LOG_REFRESH_INTERVAL_MS = 2000;` (`app.js:1124`) — console log polling is 2s.
- The only numeric `1400` values found are unrelated UI timeouts (copy-button reset `app.js:10962`, settings highlight `app.js:34950`), not polling.
- `refreshInstances()` (`app.js:18829`) skips hidden tabs, deduplicates in-flight requests (`instanceActionRequestInFlight` guards), and honors agent polling backoff.

Implication for the design: read-side polling is **renderer-driven and page-scoped**. That is fine for observability; the job lifecycle must **not** depend on the renderer polling to stay alive. Rendering is presentation, never the source of truth for job state.

### 2.2 The routing seam (local vs remote)

- `src/services/serviceRouter.js` is the single seam choosing local vs Agent execution. For instances: `shouldUseLocalInstances` `serviceRouter.js:284–286` returns `isApplicationHostTarget(options)` (`:523`, i.e. deployment type `application-host`); otherwise requests go to `getAgentNodeClient(options)` (`:462`, e.g. `listInstances()` `:527–542`).
- Agent responses are stamped with the node via `withNodeContext` (`serviceRouter.js:482–521`), which already has a **`jobs`** field path (`:508–510`) — a sign the design anticipated job-shaped payloads; today no route produces jobs that flow through it except the dependency installer.
- Desktop IPC handlers (`src/ipc/instancesIpc.js`) each wrap the service call in `requirePermission(...)` + `audit({ action, target })` (`instancesIpc.js:74–195`; e.g. `instances:create` audits `instance.create` `:77`, `instances:start` audits `instance.start` `:115`).

### 2.3 Dual instance-root / local agent instances

- Desktop local instances: `src/services/localInstanceService.js:5–15` resolves the root from `process.env.AGENT_INSTANCE_ROOT`, else `app.getPath("userData")` + `/instances` (`localInstanceService.js:11`), and calls `instanceService.configureInstanceService({ getConfig })`.
- Same core (`src/shared/instances/instanceServiceCore.js`) is reused by the **Agent**: `agent/src/services/instances/instanceService.js` is a thin wrapper that does `instanceService.configureInstanceService({ getConfig })` against the Agent's `config` (default instance root `/srv/anxos/instances`, `agent/src/config.js`). So the process-lifetime model below is **shared** between local-host and remote-Agent — a single implementation owns the process lifecycle in both modes.

### 2.4 Process/timer ownership — the "no orphan" anchor

- `instanceServiceCore.js:109` `runningProcesses = new Map()` — child processes are owned in the **process that spawned them** (desktop main for local-host; Agent process for remote).
- Reconciliation on restart exists and re-adopts surviving processes: `reconcileConfigState` (`instanceServiceCore.js:3979`) reads `runningProcesses.get(id).child.pid` or the **persisted `config.pid`**, checks `isProcessAlive(pid)`, then `verifyPersistedRuntimeIdentity(config, pid)` (`:4005–4025`) to reject PID-reuse/mismatch. This is the exact kernel of the acceptance-gate guarantee: **persisted PID + identity verification, owned where the child lives**.
- `discoverDetachedRuntime`/`adoptDiscoveredRuntime` (`:3969–3967`, `:3980`) let a service restarted after a crash re-adopt a server process it no longer has a tracked child for.
- Timer ownership: `timely` lifecycle uses `setInterval`/`setTimeout` (readiness port timer `:5123`, auto-restart timers `restartTimers`, `versionRefreshTimers`, backoff `restartBackoffStates`). Commit **c1b48de** ("fix(instances): release owned timers after shutdown race", `git show c1b48de`) hardened `shutdownInstanceService` (`:2421`) to re-clear those owned timers after the children stop, because a readiness/version-refresh event can re-arrive from a child stdout stream during teardown and re-arm a timer after `dispose()`.
- Agent graceful shutdown does the same: `agent/src/server.js:484–504` (`SIGTERM`/`SIGINT`) → `instanceService.shutdownInstanceService({ timeoutMs: 5000 })` then `process.exit(0)`. Crash recovery on next boot calls `recoverIncompleteInstallations()` (`server.js:464`).

### 2.5 Existing cancellation / session model (the nearest precedent)

The Agent already has a **tokenized operation session** for Marketplace installs:

- `beginInstallationSession` (`instanceServiceCore.js:233–264`): validates instance `installationState === "installing"`, a config-pinned `operationId` (`INSTALLATION_OPERATION_ID_PATTERN`, config `installationOperationId`), an allowance via `INSTALLER_PHASES[installerFamily]`, rejects conflicts with `INSTALLATION_SESSION_CONFLICT` (409), and returns `{ operationId, token, status: "ready" }`.
- `executeInstallationPhase` (`:292–356`) spawns the child, installs `session.cancel = () => child.kill("SIGKILL")` (`:332–335`), enforces a phase timeout → `INSTALLER_TIMEOUT` (504), and maps cancel/timeout/nonzero-exit distinctly.
- `closeInstallationSession` (`:358–365`) / `cancelInstallationSession` (`:367–374`) — both validate session+operationId+token via `validateInstallationSession` (`:217–231`), which distinguishes *no token* (`INSTALLATION_SESSION_TOKEN_REQUIRED`, 400) from *wrong args* (`INSTALLATION_SESSION_INVALID`, 403) from *already closed* (`INSTALLATION_SESSION_CLOSED`, 409).
- `beginSteamCmdUpdateSession` (`:376+`) is the same pattern for steamcmd updates.
- All installation sessions live in an **in-memory** `installationSessions = new Map()` (`:114`) — they are NOT persisted, so they do **not** survive an agent/desktop process restart by themselves. On the Agent, `shutdownInstanceService` terminates sessions (`:2398`); recovery (`recoverIncompleteInstallations` `:4442`) handles the post-crash durable state.

### 2.6 Idempotency / job records — verified: none (except a partial seam)

- **No general job record, no idempotency key, and no durable audit-event-per-job exists today.** Verified searches across `src/` and `agent/src/` (excluding tests/smokes) found no `idempoten*` token and no `jobs.json`/job store.
- The nearest existing "job" is the **dependency installer** in the Agent: `agent/src/services/dependencyService.js` `createJobId` (`:35`) → `dependencyJob()` (`:52`) returns a job-shaped object (`id`, `dependencyId`, `nodeId`, `state`, `stage`, `progressPercent`, `events`, `output`, `cancellationSupported`, …), keyed in an in-memory map. **This is in-memory only and keyed by nothing dedup-safe** — a retry can mint a new id.
- Idempotency-adjacent behavior exists for `startInstance` (the guard at `instanceServiceCore.js:115–118` documents that concurrent starts for the same id must not orphan a child) and in the "correct answer is 404 rather than misleading idempotent success" comment (`:4371`) for delete/forget.
- Desktop audit (`src/services/securityService.js`) is a **write-only append log**: `audit({ action, outcome, target, reason, actor })` → `fs.appendFileSync(getAuditPath(), JSON + "\n", { mode: 0o600 })`, `getAuditPath()` = `security.json` dir + `audit.log` (`:576–589`). Events are `{ at, actor, action, outcome, target, reason }`. There is deliberately **no cross-referencable id** linking an audit record to a specific operation run — a job record gives us that id.

### 2.7 Observability / audit conventions

- `.dev-logs/` (desktop `diagnosticsService.getDirectory()` `:17`): `latest-error.json` (write `:50`), `runtime-state.json` (snapshot `:39`), and per-subsystem `*.log` (`instances.log`, `agent.log`, `ipc.log`, `live.log`, `operations.log`, `auth.log`, …). Diagnostics export feeds everything through `sanitizeForDiagnostics` (`:83`).
- Shared redaction: `src/shared/redaction.js` — `sanitize/sanitizeForDiagnostics/redactString` redact bearer tokens, JWTs, secret assignments, command-line secrets, URL credentials, private keys, private paths, and large base64. `SENSITIVE_KEY` (`:1`) redacts whole keys named `token|secret|password|…|session|…|ciphertext`. Agent side uses `sanitizeForDiagnostics` too (`agent/src/server.js:2,108`) and the audit logger `redact()` (`agent/src/audit/auditLogger.js:1–6`) for the actor/user-agent.

---

## 3. Proposed Job Lifecycle

### 3.1 Key invariant

> **A job's lifecycle is owned by the process that executes it (the Agent for remote execution, the desktop main/service for the local host). The desktop renderer and any other client are observers and requesters only. Job state is reconstructed from server/agent-side persisted state (config `state`/`pid`, or a new durable job record), so a client restart — or a detached-runtime re-adoption — can never lose or orphan an in-flight operation.**

### 3.2 Job record (durable, additive)

A new per-node durable file recommended as `<instance-or-target-root>/jobs/<jobId>.json` (or a single `jobs.json` index) so it survives process restart. Conceptually:

```jsonc
{
  "id": "job_<26-char base64url>",
  "idempotencyKey": "create:instance:web-01:abc123def",   // dedupe/return-previous
  "type": "instance.start",                               // action namespacing
  "target": { "nodeId": "agent-…", "instanceId": "web-01" },
  "owner": { "actorId": "…", "role": "owner" },           // redacted actor
  "state": "enqueued",                                    // see state machine
  "stage": "Preparing to start",
  "pid": 12345,                                           // where applicable, persisted for re-adoption
  "enqueuedAt": "<iso>", "startedAt": null, "completedAt": null,
  "timeoutMs": 300000,
  "attempts": 1,
  "exitCode": null, "error": { "code": null, "message": null },
  "cancellation": { "requestedAt": null, "reason": null, "supported": true },
  "progress": { "mode": "determinate", "percent": null },
  "createdByRenderer": "<render-session-id>",             // informational only, never authoritative
  "auditRef": "audit-<hash>"                              // correlation to audit.log
}
```

Minimal additions to honor backwards compatibility: reuse existing `state` values where the process model already defines them; do not re-key instance identity.

### 3.3 State machine

```
                    ┌──────────────────────────────────────────────┐
 enqueued ──accept─► running ──exit 0───────────────────────────► succeeded
    │                │  │                                          
    │ reject         │  ├─ non-zero / signal ───────────────────► failed
    │  (duplicate)   │  ├─ cancel requested ────────────────────► cancelled
    timeout/reroute  │  ├─ timeoutMs elapsed ───────────────────► timeout
    to running       │  └─ process exits, PID gone → reconcile ─► (failed|succeeded by identity)
    v                v
 duplicate → returns existing job (not a new one)
```

States (canonical superset of the current process model):

- **`enqueued`** — accepted, not yet executing (desktop-side persist-then-dispatch). Idempotency applied here.
- **`running`** — child spawned / session begun; PID and/or session token recorded.
- **`cancelled`** — explicitly cancelled by an authorized requester (see §3.6).
- **`failed`** — non-zero exit or raised error (`INSTANCE_STATE_FAILED`, installer non-zero, etc.).
- **`succeeded`** — clean completion.
- **`timeout`** — distinct from failure; jobs that exceed `timeoutMs` (mirrors `INSTALLER_TIMEOUT` 504). Kept separate from `failed` so the operator can distinguish "hung" from "errored".
- Terminal states are **immutable** once written (append-only transition log).

Transitions are recorded as **audit events** (§3.4), not just as a single mutable `state` field — so an aborted client still leaves a verifiable trail.

### 3.4 Audit-event log

Extend the two existing audit seams so every transition is observable and redacted:

- **Local:** each IPC mutation (`instancesIpc.js`) already calls `audit({ action, target })`. Add `id` (the job id / idempotency-derived hash), `action: "job.<state>"` or keep the existing `action` and add `jobId`, and an `outcome` mapping (`succeeded`→`ok`, `failed/cancel/timeout`→ `failed|cancelled|timeout`). Records still append to `getAuditPath()` (`.0o600`) — nothing new to secure.
- **Remote (Agent):** the Agent already writes `scope: "agent_action_audit"` JSON via `auditAction` (`agent/src/audit/auditLogger.js:15`). For job-bearing endpoints, include `jobId` so a client can join desktop audit to agent audit. Keep `actor` derived from the request socket + redacted user-agent (do not carry raw credentials).
- **Redaction rule:** job `output`, `error.message`, and `event.details` pass through `src/shared/redaction.js` `sanitizeForDiagnostics` (and Agent-side `redact()`) before any write. Never store plaintext `token`, `authorization`, `password`, or the installation-session `token`.

### 3.5 Idempotency keys (dedupe duplicate requests)

- Each **mutation** operation carries an optional `idempotencyKey` supplied by the client (or derived deterministically by the server for non-destructive-looking actions). Recommendation: server-derived `type:<target>:<stable-arg-hash>` where a stable key exists (e.g. create-from-template), client-supplied where the client chooses the run (e.g. `restart` with a user-generated nonce).
- **Lookup-first semantics:** on `enqueue`, resolve `idempotencyKey`; if a job with that key already exists and is non-terminal → return the **existing** job (200/202, not a new 201/429). If it is terminal → return the prior terminal result with a `replayed: true` flag and a distinct audit line (`job.replay`), **without re-executing**. Destructive operations (delete/forget/force-kill) should **not** silently replay; for those a duplicate *should* surface as `JOB_CONFLICT`/`CONFLICTING_REQUEST` unless the operator explicitly confirms — see §5.2.
- Idempotency keys are **per-target + per-node** — a key minted for one node cannot dedupe a request for another (ties into `V2A_AUTHORITY_PERMISSIONS.md`, wrong-node fails closed).
- Keep the in-memory `seenKeys` TTL-capped, but durable terminal results derive from the job record itself (idempotent by construction: same `jobId`).

### 3.6 Cancellation path

- **Local (application-host):** cancel chooses the right primitive based on job type:
  - Marketplace/installer session → reuse `cancelInstallationSession` (`instanceServiceCore.js:367`): validates session+`operationId`+`token`, invokes `session.cancel()` (SIGKILL), marks `closed`, and returns `{ cancelled: true, operationId }`. Route is `POST …/installation/cancel` (Agent) or the analogous shared-service call locally.
  - Generic running child → `stopInstance`/`forceKillInstance` path already modeled (`instances:stop`, `instances:forceKill` in `instancesIpc.js`); the job record's `terminate()` calls the same underpinning.
- **Remote (Agent):** add/confirm `POST /api/v1/instances/:id/jobs/:jobId/cancel` (or reuse `/installation/cancel` for installer jobs) that authorizes via `instance:lifecycle` (or `backups:*`/`dependencies:write` per route, `agent/src/server.js:165–191`), validates the job/session, and returns the terminal/cancelling state. Cancellation must be **idempotent**: a second cancel of an already-`cancelled`/terminal job returns `200 { cancelled: true, alreadyTerminal: true }` with the existing result, never a new side effect.
- Cancel is a **targeted** capability: the requester must hold the permission for the operation's target; with `V2A_AUTHORITY_PERMISSIONS.md` scope, `owner`/`admin` may cancel broadly, `operator` only where scoped.

### 3.7 "Client restart does not orphan server operations" — how it is guaranteed

1. **Ownership is process-side, not renderer-side.** The child/session lives in the desktop service (local-host) or the Agent (remote). The renderer only fires requests and reads state.
2. **The server is the durable agent-of-record.** Instance runtime state/pids already persist to instance `config.json`; the new job record persists to the node's `jobs/` store. A desktop restart does not stop an Agent-managed child, and re-adopts local children via `reconcileConfigState` + `verifyPersistedRuntimeIdentity` (`instanceServiceCore.js:3979–4034`).
3. **No kill-on-disconnect.** The desktop must **not** terminate in-flight jobs merely because a renderer disconnected or its process exited. (This contrasts with today's local model where the desktop main *itself* owns local children and its graceful shutdown does stop them — that is correct because the desktop is the server for the local host. For remote Agent jobs, the Agent owns the child and outlives the client.)
4. **Reconnect/reconcile, don't restart.** On client restart, the desktop re-lists jobs from the node (`withNodeContext` already maps a `jobs` array, `serviceRouter.js:508`); agents re-adopt tracked/detached processes; interrupted installs go through `recoverIncompleteInstallations`; orphaned/unknown pids are verified and either re-adopted or failed with `PID_IDENTITY_MISMATCH`.
5. **Timer hygiene.** The V1-A/c1b48de lesson is codified: any timer a job owns must be released when its parent lifecycle is disposed, and re-arm races (events arriving during teardown) must be tolerated. The job engine should own/dispose its timers the same way `shutdownInstanceService` clears `restartTimers`/`versionRefreshTimers`/`restartBackoffStates` (`:2421–2431`).

---

## 4. Interfaces / Contracts Changes (conceptual only)

### 4.1 Desktop IPC (main-process / `src/ipc/*`)

- **`jobs:list`** → returns node-scoped jobs (with `requirePermission`, `requireNodeContext`), driving the reconnect view.
- **`jobs:cancel`** (`{ jobId | (type,target), nodeId, reason }`) → `requirePermission(action-permission, target)` then server-side cancel; also `audit({ action: "job.cancel", target, jobId })`.
- **`jobs:get`** (`{ jobId, nodeId }`) → single record + transition audit trail.
- **Mutation handlers evolve:** each existing `instances:*`/`dependencies:*`/`backups:*` write adds an optional `idempotencyKey` passthrough and returns either the synchronous result (fast ops) or a `{ jobId, state: "enqueued"|"running" }` handle for long ops. `withNodeContext`'s existing `jobs` mapping is the natural place these appear.
- All handlers keep the existing `requirePermission` + `audit` + `invokeInstanceOperation` wrapper contract (`instancesIpc.js`), only now carrying a `jobId` correlation id.

### 4.2 Agent REST (port 47131, `agent/src/server.js` router)

- Extend `getRoutePermission` (`server.js:165`) so job paths map to the existing capability buckets (e.g. `POST …/instances/:id/jobs/:jobId/cancel` → `instance:lifecycle`; `GET …/instances/:id/jobs` → `instance:read`).
- Add/reconcile:
  - `GET /api/v1/instances/:id/jobs` — list job records + audit trail for the node.
  - `POST /api/v1/instances/:id/jobs/:jobId/cancel` — idempotent cancel (return prior terminal if already terminal).
  - Keep `POST …/installation/session`, `POST …/installation/cancel`, `POST …/installation/close`, and the steamcmd session endpoints as the concrete session backing for installer jobs (`routeRequest` already dispatches `server.js:224,381–399`).
- New job body fields flow through `sanitizeErrorDetails`/`sanitizeForDiagnostics` (`server.js:106–121`) so job `error.details`/`output` are redacted before any `sendJson`.
- Auth unchanged: single shared token over the authenticated seam; capability already enforced by `authorizeApiPermission`. No new credential type.

### 4.3 Agent audit contract

Continue `agent_action_audit` JSON lines, now including `jobId`. Fields: `{ scope, at, actor: { remoteAddress, userAgent(redacted) }, actionId | jobId | type, permission, outcome, reason }`. Do not add credentials.

---

## 5. Failure Semantics

### 5.1 Duplicate request
- Non-destructive + idempotencyKey present → return existing/non-terminal job (202) or replay terminal (200, `replayed: true`, `job.replay` audit). No re-execution.
- No idempotencyKey, non-concurrent (e.g. two `start` for the same instance) → the existing `startInstance` guard (concurrent-invocation barrier) rejects/returns conflict so no second child orphaning occurs.
- Destructive duplicate (delete/forget/force-kill) → **fail closed** with a conflict/job-in-flight error unless the operator explicitly re-confirms post-terminal. This preserves the current "404 rather than misleading idempotent success" behavior (`:4371`) and V1-A's "prevent duplicate destructive execution".

### 5.2 Client crash mid-job
- Remote: Agent continues owning/running the job; its state is durable on the node. On next client start, `jobs:list` rehydrates; no orphaning, no auto-kill. If the agent itself crashed and the process survived, `reconcileConfigState`/`adoptDiscoveredRuntime` re-adopts; otherwise `recoverIncompleteInstallations` fails the install with a durable `lastInstallError` (`:4478`).
- Local-host: the desktop service owns the child; its graceful shutdown stops children (by design). An **abrupt** desktop crash leaves the OS child; on next boot reconciliation re-adopts (if identity matches) or marks it accordingly.

### 5.3 Agent disconnected
- Desktop cannot reach the Agent (`AGENT_UNAVAILABLE` 503 / `NETWORK_ERROR`, `serviceRouter.js:26–33,812`). Any pending `enqueued` job that never transferred → desktop marks it `failed`/`not-confirmed` with a clear `error.code` and keeps the audit line; it must **not** auto-retry a destructive op without confirmation. Jobs already `running` on the Agent are unaffected by the disconnect (they are Agent-owned); they become visible again on reconnect.

### 5.4 Timeout expiry
- A `running` job exceeding `timeoutMs` transitions to `timeout` (distinct from `failed`), the child is killed (SIGKILL like `INSTALLER_TIMEOUT`, `instanceServiceCore.js:340–343`), and the audit trail records the timeout arm+fire. `idempotencyKey` still matches the original key so a post-timeout retry can either replay the fixed operation under the same key or, if the operator wants, a fresh key → new job (never a silent double-run).

---

## 6. Risks & Open Questions for the Owner

1. **Durable job store location & migration.** Where should the job record live (per-node `jobs/<jobId>.json` vs a single `jobs.json` vs reusing the instance `config` `state`/`pid` plus an index)? This determines V1→V2 back-compat for in-flight installs and how much of §3.2 must ship. *(Recommendation: additive `jobs/` directory on the node, keyed by `jobId`, with the instance record as the primary care target.)*
2. **Kill-on-disconnect policy for the local host.** For remote Agent jobs the answer is clear (Agent owns, survives client). For the **local application-host**, today the desktop *is* the server and graceful shutdown stops children. Should a *crash* ever auto-kill local jobs, or should we adopt detached-runtime/identity re-adoption so local jobs also survive a client crash? This decides how far the "no orphan" gate extends to the local path.
3. **Scope of idempotency application.** Is idempotency gated to a curated set (create/start/stop/restart/install/update/backup/restore) with explicit non-replay for destructive ops, or universal? The risk is silent-replay of destructive actions; we need the owner to confirm the "do-not-replay-destructive" stance and the exact conflict error codes.
4. **Audit-event join key.** Confirm that adding a `jobId` (and desktop → agent correlation) to the existing append-only `audit.log` + `agent_action_audit` streams is acceptable, versus introducing a dedicated audit-event store. This affects retention, redaction scope, and the `audit.log` `.0o600` convention.
5. **How this pre-wires Automation Engine / V2-M.** A durable, server-owned job record with a stable state machine, audit trail, cancellation, and idempotency is exactly the substrate a future scheduled/automation engine (cron-style triggers, `listFunctionTriggers`-like schedules hinted at in `serviceRouter.js:511–512`) needs. The owner should confirm that the job record is designed as a **general operation ledger** (not instance-only) so V2-B/C/D workloads and later V2-M automation reuse it rather than forking a second model. The existing `withNodeContext` `jobs` mapping (`serviceRouter.js:508`) is the forward-looking hook.

---

## 7. Definition of Done (for the eventual implementation wave)

- [ ] Job record persisted on the executing node; survives process restart.
- [ ] State machine with immutable terminal states; every transition recorded as a redacted audit event.
- [ ] Idempotency applied to the curated set; destructive ops never silently replayed.
- [ ] Cancellation works local (service) and remote (Agent REST) and is idempotent.
- [ ] Client restart and Agent disconnect leave jobs owned server/agent-side; reconciliation re-adopts or fails with a useful code (`PID_IDENTITY_MISMATCH`, `AGENT_UNAVAILABLE`, `JOB_CONFLICT`).
- [ ] Timeout is a distinct state; child SIGKILL + audit trail on fire.
- [ ] All job `output`/`error`/`event.details` pass through `sanitizeForDiagnostics`; no credentials/tokens persisted.
- [ ] Acceptance gate exercised: kill the client mid-job, restart it, confirm the job completed/continues, and no orphaned process remains.