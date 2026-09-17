# V2 Wave-2 Implementation Record

**Date:** 2026-09-17
**Milestone:** V2-C follow-on — durable jobs for the full Docker surface + deny-by-default policy, volume protection, and create preflight
**Status:** Implemented on the working tree; validation green; awaiting owner review and commit approval

## Scope

Completes the remaining staged item from `V2_WAVE1_IMPLEMENTATION_RECORD.md`
("V2-C follow-on: compose/images/volumes/networks routes onto the job store;
volume-protection preflight UI") plus the two approved Wave-1 architecture
items that had not landed yet (§3.4 preflight + volume protection, §3.5
policy gating). All work implements owner-approved decisions from
`V2C_CONTAINERS_WAVE1.md` (approved 2026-09-16); no new owner decisions were
required.

## What changed

### 1. Durable job-store wiring (agent routes)

`agent/src/routes/docker.js` now mints V2-A durable jobs
(`agent/src/services/dockerJobService.mintDockerJob`) for every state-changing
operation outside containers, so a client restart can never orphan them:

| Route | Job type | Idempotency |
| --- | --- | --- |
| POST `/docker/compose/up` | `docker.compose.start` | keyed |
| POST `/docker/compose/stop` | `docker.compose.stop` | keyed |
| POST `/docker/compose/restart` | `docker.compose.restart` | keyed |
| POST `/docker/compose/pull` | `docker.compose.pull` | keyed |
| POST `/docker/compose/build` | `docker.compose.build` | keyed |
| POST `/docker/compose/recreate` | `docker.compose.recreate` | keyed |
| POST `/docker/compose/down` | `docker.compose.down` | destructive (refuses keys) |
| DELETE `/docker/images/:image` | `docker.image.delete` | destructive |
| POST `/docker/images/prune` | `docker.image.prune` | destructive |
| POST `/docker/networks` | `docker.network.create` | keyed |
| POST `/docker/networks/:n/connect` | `docker.network.connect` | keyed |
| POST `/docker/networks/:n/disconnect` | `docker.network.disconnect` | keyed |
| DELETE `/docker/networks/:n` | `docker.network.delete` | destructive |
| POST `/docker/networks/prune` | `docker.network.prune` | destructive |
| DELETE `/docker/volumes/:v` | `docker.volume.delete` | destructive |
| POST `/docker/volumes/prune` | `docker.volume.prune` | destructive |
| POST `/docker/cleanup` | `docker.cleanup.run` | destructive |

Responses are additive (`{ ...result, job }`); read-only compose ops
(validate/logs/status), container pause/unpause/kill/rename/exec, and all GET
routes stay direct.

### 2. Deny-by-default policy gate (new `src/shared/dockerPolicy.js`)

`policeContainerRequest(payload)` fails closed on **privileged mode**, **host
networking**, **host path mounts** (`-v` and `--mount type=bind`, POSIX and
Windows drive paths), and **engine-socket mounts** unless the request carries
an explicit per-flag `policyGrant`. `createContainer` enforces the gate
(`DOCKER_POLICY_DENIED`, 403) before any Docker command runs — the renderer
confirmation is presentation, never the boundary. Malformed resource limits
(`INVALID_MEMORY_LIMIT` / `INVALID_CPU_LIMIT`, 400) are rejected pre-engine.

### 3. Volume protection at the engine boundary

`runCleanup` refuses any persistent-data kind (`volumes`) without an explicit
`confirmVolumeDataRemoval: true` (`VOLUME_REMOVAL_CONFIRMATION_REQUIRED`,
400). The classification lives in `dockerPolicy.cleanupAffectsPersistentData`
and must stay in lockstep with `getCleanupPreview`. The renderer passes the
flag only after its existing volume-risk dialog is accepted.

### 4. Create preflight (roadmap: ports / capacity / mounts / limits)

New `POST /api/v1/docker/preflight/container` (`docker.preflight.container`,
read-only, no durable job) served by `preflightContainerCreate` in
`src/shared/dockerService.js`: policy denials (hard), resource-limit
problems (hard), plus best-effort engine checks for host-port conflicts
against live published ports (`rawPorts.PublicPort` only — normalized port
strings mix exposed container ports in and would fabricate conflicts) with an
explicit `engineAvailable` flag. Routed to the desktop through the standard
chain: `agentClient.preflightDockerContainer` → `serviceRouter.preflightDockerContainer`
→ `dockerIpc docker:preflightContainer` (docker:read) → `preload docker.preflightContainer`.
The renderer create flow calls preflight first, surfaces blocked findings and
stops, and shows warnings before the create attempt.

### 5. Renderer (`app.js`)

- `createDockerContainerFromForm`: preflight-first, dangerous options are
  detected once (shared drive-letter-aware parsing with the backend) to drive
  both the existing confirmation dialog and the `policyGrant` attached only
  after confirmation. The old weak regex missed plain host binds
  (`/etc:/victim`); detection is now strictly broader.
- `runDockerCleanupAction`: passes `confirmVolumeDataRemoval` for the
  `volumes` kind after the dialog.

## Validation executed

- `node --check` PASS on every changed JS file: `src/shared/dockerPolicy.js`,
  `src/shared/dockerService.js`, `agent/src/routes/docker.js`,
  `src/services/agentClient.js`, `src/services/serviceRouter.js`,
  `src/ipc/dockerIpc.js`, `preload.js`, `app.js`,
  `scripts/docker-policy-smoke.js`, `scripts/docker-job-lifecycle-smoke.js`.
- `docker:policy:smoke` (new) PASS — pins the policy gate, cleanup
  confirmation, resource-limit validation, host-port parsing, and the
  preflight report; every asserted gate throws before any Docker command, so
  the smoke is hermetic and side-effect-free.
- `docker:job-lifecycle:smoke` PASS — extended to pin Wave-2 keyed types
  (compose start, network connect) and destructive refusal across every
  Wave-2 destructive family; **also newly registered in `package.json`** (it
  existed since Wave 1 but was never wired, so `rc:validate` never ran it).
- `docker:smoke`, `docker:capabilities:smoke`, `docker:route-io:smoke`,
  `docker:hostile-input:smoke`, `docker:ipc-error-contract:smoke`,
  `docker:ipc-authorization:smoke`, `instances:job-lifecycle:smoke`,
  `instances:job-reobservation:smoke` — all PASS (exit 0).
- Full `rc:validate` (now includes the two docker smokes above) — result
  recorded in the delivery report.

## Remaining risks / staged

- Compose-file policy gating (privileged/host-mount/socket inside user
  compose YAML) is a documented follow-on; this wave gates the first-class
  container create API only.
- Live-engine acceptance (real Docker daemon: compose lifecycle, preflight
  port-conflict, cleanup confirm) is contract-covered by smokes but not yet
  exercised against a live engine in a sandbox — same stance as Wave 1.
- Mimosa full re-audit still owed (standing debt).
- The `docker.preflight.container` route is additive to the capabilities
  manifest; `docker-capabilities-smoke` validates manifest integrity
  generically and passes unchanged.

## Notes

- `scripts/docker-job-lifecycle-smoke.js` registration gap found and fixed:
  Wave-1 validation ran it manually; it is now a first-class `rc:validate`
  suite.
- A Mimosa scan false-positive flagged pre-existing line 36 of
  `src/shared/dockerService.js` (the `execFile`-based `exec` wrapper); the
  existing code already uses `execFile` with an args array and no shell, and
  no change was made to that function.
