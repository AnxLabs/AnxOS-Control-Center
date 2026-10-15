# AIM Plan — Revision 3.2 Compatibility Addendum (Build 206)

| Field | Value |
| --- | --- |
| Applies to | `docs/v2/V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md`, **revision 3.1 (frozen, unchanged)** published at `afb66a17bfb092126da88d70c73a013b42a61f0e` |
| Prepared | 2026-10-14, on branch `aim/aim-1-inventory` based on `origin/dev` `afb66a1` |
| Scope | Narrow compatibility addendum only: Build 206 service-managed instances and Safe Restart, the committed baseline actually available on `origin/dev`, and the AIM-1 delivery shape. Everything not listed here is governed by revision 3.1 as written. |
| Authority | D1–D5, the V2-L per-action approval rule and the accepted production scopes are **unchanged**. Where an item below conflicts with revision 3.1, the item governs only for the topic it names. |

## A1. Committed baseline correction

Revision 3.1 §1.1 and §3.1 cite several V2-K modules — `src/shared/healthModel.js`,
`src/services/computerService.js`, `connectivityDiagnosticsService.js`,
`endpointService.js`/`endpointStore.js`, `telemetryService.js`,
`operationalNotificationService.js` — as existing components. On 2026-10-14 these
files exist **only as uncommitted changes in the Owner's local working tree**; they
are **not** on `origin/dev` (verified with `ls src/services src/shared` in a clean
worktree of `afb66a1`).

Consequences:

- AIM-1 builds only on committed modules: `nodeService` (node registry and per-node
  credentials), `agentClient.requestJson` (authenticated Agent reads), the
  `fleetService` fan-out pattern (bounded concurrency, degrade per node, never throw
  for one node), `networkInventoryIpc` (guard chain and IPC shape) and the
  `alertService` store pattern (atomic write, corrupt-store quarantine, future-schema
  refusal).
- AIM-1 uses its own small health vocabulary (`healthy`, `degraded`, `failed`,
  `stopped`, `unknown`) mapped from Agent-reported states. It must be reconciled with
  `healthModel.js` if and when the V2-K files are committed.
- No AIM work may depend on uncommitted V2-K files.

## A2. Service-managed (systemd) instance identity — adds a §5.7 row

| Target kind | Identity components (all required) | Identity changes when |
| --- | --- | --- |
| Service-managed instance (`type: "systemd-service"`) | Host identity (§5.7) + AnxOS instance id + systemd unit name (`serviceManager.unit`) | The instance record is removed or recreated, the unit name changes, or the host identity changes. `serviceStatus.externalMainPid` is **informational only and never part of the identity**: systemd owns the process and a restart is expected to change it. |

Additional rules:

- Ownership is recorded as **owned by systemd, observed by the Agent**. The Agent never
  owns the process (Build 206 invariant 1).
- A unit absent from the host's reported `serviceManagedInstances.allowedUnits` is
  shown with a warning; it is still inventoried, never controlled by AIM.
- An unreadable service (`serviceStatus.observed: false`, state `Unknown`) stays
  `unknown`, never `stopped` (Build 206 invariant 3).

## A3. Health fields

- Agent health now reports `capabilities.serviceManagedInstances`
  `{ supported, mechanism, allowedUnits }`. `supportsServiceControl` is still `false`
  and keeps its meaning (host-level service control). Revision 3.1 §1.1 remains
  accurate; AIM-1 records both.
- Service-managed instance status comes from the instance list
  (`serviceStatus.activeState`, `subState`, `unit`, `uptimeSeconds`,
  `restartCount`); AIM-1 reads only that list.

## A4. Safe Restart and the runbook catalog (affects AIM-5, not AIM-1)

- For service-managed instances, revision 3.1 §4.5 catalog item 3 ("restart a crashed
  managed instance" via `POST /api/v1/instances/:id/restart`) is **replaced** by Build
  206 Safe Restart: `POST /api/v1/instances/:id/service/safe-restart` with
  `{ confirm: true, expectedMainPid, expectedUnit }` (`instance:lifecycle`). Its
  preflight and post-restart checks implement the §5.4 precondition re-verification
  for these instances, and `expectedUnit`/`expectedMainPid` carry the expected
  identity to the Agent. Plain restart stays reserved for Agent-owned instances.
- Safe Restart remains subject to per-action Owner approval under V2-L. Nothing here
  makes it automatic.
- AIM-1 does **not** call any service operation route, including the read-only
  `service/overview` and `safe-restart/preflight`. Those read the workload status file
  and player endpoints on production hosts; probing them is deferred to the AIM-2
  functional probes under the §9.1 per-scope opt-in.

## A5. Error codes AIM must map (AIM-4/AIM-5)

`SERVICE_STATE_UNVERIFIED`, `SERVICE_CONTROL_DENIED`, `SERVICE_OPERATION_IN_PROGRESS`,
`SERVICE_SAFE_RESTART_REFUSED`, `SERVICE_SAFE_RESTART_CONFIRMATION_REQUIRED`,
`SERVICE_HISTORY_UNWRITABLE`, `SERVICE_HISTORY_UNREADABLE`,
`SERVICE_MANAGED_OPERATION_UNSUPPORTED`, `SERVICE_MANAGER_UNSUPPORTED`,
`SERVICE_OPERATION_NOT_FOUND`, `SERVICE_OPERATIONS_UNSUPPORTED`,
`RESTART_SCHEDULE_SERVICE_MANAGED_UNSUPPORTED`, `PORT_OWNERSHIP_UNVERIFIABLE`.
Each is a refusal or failure: none may be retried automatically.

## A6. Reusable Build 206 test harnesses

- `scripts/test-helpers/service-managed-agent-fixture.js` starts the **real** Agent
  with a fake systemd and records every control call and every spawned process. AIM-1
  uses it to prove discovery issues **zero** control calls; AIM-5 should reuse it for
  identity-race and refusal tests.
- `service-managed-operations-agent-smoke.js`, `service-managed-mutation-check.js` and
  `service-managed-ui-qa.js` are the patterns for real-Agent, mutation and Electron
  checks.

## A7. AIM-1 delivery shape (deviation from revision 3.1 §4.1)

Revision 3.1 §4.1 proposed a new Agent aggregate route `GET /api/v1/inventory`. AIM-1
instead composes the inventory **desktop-side from existing read-only Agent routes**:

| Data | Existing route | Permission tier |
| --- | --- | --- |
| Host identity, capabilities | `GET /api/v1/health` | public |
| Host summary | `GET /api/v1/system/summary` | `system:read` |
| Listeners | `GET /api/v1/network/inventory` | `system:read` |
| Instances, incl. service-managed | `GET /api/v1/instances` | `instance:read` |
| Containers, compose projects | `GET /api/v1/docker/{containers,compose/projects}` | `docker:read` |
| Full container ID, compose labels, attached volumes (name, driver) and networks (full ID) | `GET /api/v1/docker/containers/:x/inspect` (bounded) | `docker:read` |
| Volume creation time | `GET /api/v1/docker/volumes/:x/inspect` (bounded) | `docker:read` |

`GET /api/v1/docker/volumes` and `/networks` are deliberately not used: on the Agent they
inspect every container, volume and network with unbounded concurrency (PR #4 review, P1).

Reasons: no Agent upgrade or service change is needed to inventory already deployed
Build 205/206 Agents; no new Agent permission family; and the reads are the same ones
the Control Center already performs. The aggregate Agent route is deferred.

Limits carried as known gaps:

- **GPU inventory is deferred.** No committed read route reports GPU model or VRAM
  (only Windows temperature sensors). AIM-1 records host GPU as `not-reported`.
- **Non-container processes stay `unverified`** (revision 3.1 §5.7): listeners carry
  only process ID and name, not executable path or start time.
- Network identity uses the Docker network ID as listed (truncated); networks are
  inventoried but marked `unverified` for action purposes.

## A8. AIM-0 status

The Owner directed AIM-1 to start on 2026-10-14 before the AIM-0 contract documents
were signed off. AIM-1 is read-only discovery, so no AIM-0 safety gate depends on it;
AIM-0 remains open and still gates AIM-4 onward (contracts, production scope
verification, Agent Office and AnxGraph contracts). The Owner's instruction to "verify
discovery against actual supported agents without changing managed services" is the
recorded approval for read-only live AIM-1 inventory runs.
