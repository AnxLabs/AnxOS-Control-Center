# V2 API / IPC Surface Contract

This reference lists the Agent REST endpoints and desktop IPC channels added or
extended by the V2 engineering campaign, with the permission tier each surface
enforces. It is traceable to `agent/src/server.js` (Agent permission mapping),
`agent/src/routes/*.js`, `src/ipc/*.js`, and `preload.js`. Where a surface has no
renderer control yet, that is noted.

Two tiers are always enforced independently:

- **Agent tier** — the Agent's central permission gate in `agent/src/server.js`,
  resolved once per request from the bearer credential's permission set.
- **Desktop tier** — `requirePermission(...)` in the owning IPC handler, plus
  `requireLocalOwnerAuthenticated(...)` where stated. Desktop permission names
  are a separate namespace from Agent tiers; both must allow the call.

Errors follow `docs/ERROR_CONTRACT.md` (stable `code`, user-safe `message`,
sanitized `details`).

## 1. Agent REST endpoints

### Network inventory

| Method | Path | Tier | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/network/inventory` | `system:read` | Read-only. Optional `?checkPort=<port>&protocol=tcp\|udp` adds a bound check. See `docs/OPERATOR_NOTES_V2.md` §7. |

### Runtime pins

| Method | Path | Tier | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/dependencies/runtime-pins` | `dependencies:read` | Optional `dependencyId` / `instanceId` filters. |
| DELETE | `/api/v1/dependencies/runtime-pins` | `dependencies:write` | Body `{ dependencyId, instanceId }` or `{ dependencyId, all: true }`. No desktop IPC/UI yet; see §2. |

### Scheduled restarts

All under the instance path, so the tier split mirrors the instance family.

| Method | Path | Tier | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/instances/:id/restart-schedules` | `instance:read` | Lists the instance's schedules. |
| POST | `/api/v1/instances/:id/restart-schedules` | `instance:write` | Creates a schedule (201). |
| POST | `/api/v1/instances/:id/restart-schedules/evaluate` | `instance:write` | Runs the shared due-schedule evaluation immediately. |
| PATCH / PUT | `/api/v1/instances/:id/restart-schedules/:scheduleId` | `instance:write` | Verifies the schedule belongs to `:id`. |
| DELETE | `/api/v1/instances/:id/restart-schedules/:scheduleId` | `instance:delete` | Verifies the schedule belongs to `:id`. |

### Backup destinations

| Method | Path | Tier | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/backups/destinations` | `backups:read` | Local + SFTP destinations (no secrets). |
| POST | `/api/v1/backups/destinations` | `backups:write` | Creates/updates an SFTP destination. |
| DELETE | `/api/v1/backups/destinations/:destinationId` | `backups:write` | Refuses the built-in local destination. |
| POST | `/api/v1/backups/:backupId/push` | `backups:write` | Pushes one backup to a destination. Push failure does not fail the local backup. |
| POST | `/api/v1/backups/:backupId/destinations/:destinationId/restore` | `backups:restore` | The trailing `/restore` selects this tier. Downloads, decrypts, and verifies the digest before mutation. |

### Enrollment

| Method | Path | Tier | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/enroll/revoke` | `owner` | Requires explicit confirmation. Restricted credentials are refused 403; this is expected and surfaced, never claimed as revoked. |

### Health capability

`GET /api/v1/health` is unauthenticated and returns a `capabilities` block
including `agentUpdate`:

- Windows: `{ supported: true, mechanism: "windows-scheduled-task" }`
- Linux with systemd: `{ supported: true, mechanism: "linux-systemd" }`
- Linux without systemd, or another platform: `{ supported: false, mechanism: null }`

### Job expiry semantics (no new endpoint)

Job expiry adds no route; it changes how existing job routes report state.

- A pending non-destructive job minted with `expiresAt` (or under a configured
  default pending TTL) settles `FAILED` with code `JOB_EXPIRED` and
  `expired: true` once the deadline passes. Destructive job types do not lapse
  by default.
- `GET /api/v1/jobs` and `GET /api/v1/jobs/:jobId` (tier `instance:read`) and
  `POST /api/v1/jobs/:jobId/cancel` (tier `instance:lifecycle`) observe the
  settled record; a keyed repeat request observes the settled result instead of
  replaying it. A running job never expires mid-run.

## 2. Desktop IPC channels

### Network inventory

| Channel | Desktop guard | Agent tier | Renderer |
| --- | --- | --- | --- |
| `networkInventory:get` | local owner + `nodes:read` (node context) | `system:read` | Nodes page network-inventory card (`index.html:4189`; `app.js:35216`). |

### Scheduled restarts

| Channel | Desktop guard | Agent tier |
| --- | --- | --- |
| `instances:listRestartSchedules` | node context + `instance:read` | `instance:read` |
| `instances:createRestartSchedule` | node context + `instance:write` | `instance:write` |
| `instances:updateRestartSchedule` | node context + `instance:write` | `instance:write` |
| `instances:deleteRestartSchedule` | node context + `instance:delete` | `instance:delete` |
| `instances:evaluateRestartSchedules` | node context + `instance:write` | `instance:write` |

Creates, updates, deletes, and evaluations are audited
(`instance.restartSchedule.*`). The renderer consumes these channels.

### Node lifecycle

| Channel | Desktop guard | Notes |
| --- | --- | --- |
| `nodes:disconnect` | local owner + `settings:write` (node context) | Sets the persistent manual-disconnect flag; audited `node.disconnect`. |
| `nodes:reconnect` | local owner + `settings:write` (node context) | Clears the flag and re-checks health; audited `node.reconnect`. |
| `nodes:delete` | local owner + `settings:write` (node context) | Runs best-effort enrollment revocation first; audited `node.delete`. The result carries `revocation { attempted, revoked, code?, reason? }`. |

### Backup destinations

| Channel | Desktop guard | Agent tier |
| --- | --- | --- |
| `backups:listDestinations` | `backups:read` (node context) | `backups:read` |
| `backups:saveDestination` | `backups:write` (node context) | `backups:write` |
| `backups:deleteDestination` | `backups:write` (node context) | `backups:write` |
| `backups:pushDestination` | `backups:write` (node context) | `backups:write` |
| `backups:restoreFromDestination` | `backups:restore` (node context) | `backups:restore` |

Save, delete, push, and remote restore are audited
(`backup.destination.*`, `backup.restore.remote`). No renderer control yet.

### Workload transfer

| Channel | Desktop guard | Notes |
| --- | --- | --- |
| `workload:transferPreview` | local owner + `settings:write` | Runs the pipeline up to the target restore preview. **Write tier**, because it creates a source backup, pulls and imports the archive, and registers a target placeholder. |
| `workload:transfer` | local owner + `settings:write` | Confirmed destructive phase on the target. |

Both channels audit the outer action and every recorded transfer step
(`workload.transfer.*`). No renderer control yet.

### Runtime pins

No desktop IPC channel exists. Listing and unpinning are Agent REST operations
(§1). This is intentional in the current slice, not an oversight: there is no
renderer or main-process wrapper for pins today.

### Alerts

Desktop-only; adds no Agent route. Both channels are local-owner gated and audit
their action.

| Channel | Desktop guard | Notes |
| --- | --- | --- |
| `alerts:list` | local owner + `nodes:read` | Returns the persisted active-alert state. Audited `alerts.list`. |
| `alerts:acknowledge` | local owner + `settings:write` | Acknowledges one alert by `id`/`alertId`; the acknowledgement label is set desktop-side. Audited `alerts.acknowledge`. |

Source: `src/ipc/alertsIpc.js:24-40` (registered at `main.js:1050`). As of the
audited SHA `4749e56` these channels have **no preload exposure and no renderer
caller** — the alert engine itself is wired to a bounded evaluation loop, but
the desktop alert surface is **unreachable** from the UI. A separate lane is
wiring them; until that lands, treat them as unreachable.

### Instance jobs

Desktop-only wrappers over the durable job store; no new Agent route.

| Channel | Desktop guard | Notes |
| --- | --- | --- |
| `instances:jobs:list` | `instance:read` | Lists the instance's durable jobs; optional `limit` / `type`. |
| `instances:jobs:get` | `instance:read` | Returns one job; `JOB_NOT_FOUND` (404) when absent. |
| `instances:jobs:cancel` | `instance:lifecycle` | Cancels one job; audited `job.cancel`; `JOB_NOT_FOUND` (404) when absent. |

Source: `src/ipc/instancesIpc.js:265-289`. As of the audited SHA `4749e56`
these channels have **no preload exposure and no renderer caller** — registered
and permission-matrix-covered, but **unreachable at the audited SHA**.

## 3. Change control

The V2-I permission-matrix harness (`test-helpers/permission-matrix.js`,
`permission-matrix-smoke`) enumerates the registered desktop channels and Agent
REST families and fails when a channel or route is not covered by a row. Any new
endpoint or channel added to these surfaces must be added to the matrix, and the
tier recorded above must match `agent/src/server.js` — the two must not drift.

The `alerts:*` (§2, `test-helpers/permission-matrix.js:618,625`) and
`instances:jobs:*` (§2, `test-helpers/permission-matrix.js:278,297`) families
were registered and matrix-covered before they were recorded here; this revision
adds the missing rows.
