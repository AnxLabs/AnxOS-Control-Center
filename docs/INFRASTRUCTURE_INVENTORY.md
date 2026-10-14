# Infrastructure Inventory (AIM-1)

Read-only discovery and inventory of every registered Agent node: hosts, AnxOS
instances, systemd service-managed instances (Build 206), Docker containers,
volumes, networks, compose projects and listening ports. Delivered as AIM-1 of
`docs/v2/V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md` (revision 3.1, frozen) as amended
by `docs/v2/V2_AUTONOMOUS_INFRASTRUCTURE_PLAN_R3_2_ADDENDUM.md`.

**AIM-1 is discovery only.** It never starts, stops, restarts, edits or deletes
anything, and it adds no repair or automation capability.

## Where it lives

| Layer | File |
| --- | --- |
| Model (pure, shared) | `src/shared/infraInventoryModel.js` |
| Service (main process) | `src/services/infrastructureInventoryService.js` |
| IPC | `src/ipc/infrastructureInventoryIpc.js` — `infrastructureInventory:get`, `infrastructureInventory:refresh` |
| Bridge | `preload.js` — `infrastructureInventory.get()`, `.refresh({ force })` |
| UI | Nodes page → **Infrastructure Inventory** panel (`index.html`, `app.js`) |
| Store | `<config>/infrastructure-inventory.json` (override: `ANXOS_INVENTORY_STORE`) |

Both channels require an unlocked Local Owner and `nodes:read`, the same guard
chain and tier as `networkInventory:get` (permission matrix family
`infrastructure-inventory`).

## How discovery works

Discovery runs desktop-side over **existing read-only Agent routes**, so already
deployed Agents need no upgrade (addendum A7):

| Data | Route |
| --- | --- |
| Host identity and capabilities | `GET /api/v1/health` (public) |
| Host summary | `GET /api/v1/system/summary` |
| Listening ports | `GET /api/v1/network/inventory` |
| Instances, including systemd service-managed | `GET /api/v1/instances` |
| Containers, volumes, networks, compose projects | `GET /api/v1/docker/{containers,volumes,networks,compose/projects}` |
| Full container ID, compose labels, volume creation time | `GET /api/v1/docker/{containers,volumes}/:x/inspect` |

Every request passes `assertReadRoute`: only `GET`, only these exact routes.
Anything else (including Safe Restart and service overview routes) is refused
with `INVENTORY_ROUTE_NOT_ALLOWED` before a request is made.

Opening the panel reads only the stored snapshot. Live discovery runs only when
the operator presses **Refresh Inventory**.

## What is recorded per resource

`key`, `kind`, node(s), name, **identity** (`verified` + components + reason),
**ownership**, **source** (`agent-observed`), **health**
(`healthy|degraded|failed|stopped|unknown`), **capabilities**, **protection**,
`firstSeen`, `lastSeen`, `stale` + `staleReason`.

### Identity (revision 3.1 §5.7, CL9)

| Kind | Verified when | Never part of the identity |
| --- | --- | --- |
| Host | `deviceId` + `agentInstallationId` + `agentIdentityGeneration` all reported, and `deviceId` matches the node's registered device. All three form the key, so re-pairing or credential rotation makes the host and every child resource a new identity (no `firstSeen` or classification carries over) | hostname, URL |
| Instance | host verified + AnxOS instance id | process id |
| systemd service | host verified + instance id + unit name | `externalMainPid` (systemd owns it; a restart changes it) |
| Container | host verified + full 64-hex container ID (from inspect); the key also includes name and compose project/service, so a rename or compose move is a new identity | port |
| Volume | host verified + name + creation timestamp + driver, all required and all in the key, so a recreated volume or a driver change is a new resource | — |
| Compose project | host verified + name + config path (both in the key, so a moved project is a new identity) | — |
| Network, listener | **always unverified** (truncated network ID; listener owners carry no executable path or start time) | — |

A node whose Agent reports a different device than the one registered is
refused (`AGENT_IDENTITY_MISMATCH`) and nothing is attributed to it.

### Protection (decision D4)

Every resource is `production` unless an Owner-confirmed classification for its
exact key says otherwise; non-production applies only to verified identities.
AIM-1 ships no classification editor, so everything is shown as Production.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Agent unreachable | Node `unavailable` / `NODE_UNREACHABLE`; its previous resources kept, `stale`, `lastSeen` unchanged |
| Node disabled, disconnected, recorded offline / auth-failed / incompatible | Skipped without any request, with the reason |
| A section denied or failing (401, 403, Docker absent, timeout) | Reported per section (`AUTH_FAILED`, `PERMISSION_DENIED`, `DOCKER_NOT_INSTALLED`, …); that section's previous resources kept as stale — a failed read is never treated as deletion |
| Same Agent registered twice | One host record listing both nodes (`duplicateNodes`) |
| Duplicate rows in one Agent response | Folded (`duplicateCount`) |
| Node removed from the registry | Its resources stay stale (`NODE_NOT_REGISTERED`) for 7 days, then are pruned |
| Concurrent refreshes | Single-flight; a refresh within 10 s returns the previous result (`throttled`) unless forced |
| Desktop restart | Stored resources load as stale (`NOT_REFRESHED_SINCE_RESTART`) until the next refresh; `firstSeen` survives |
| Corrupt or malformed store | Moved out of the active path to `.corrupt-<ts>` (renamed, never deleted), inventory restarts empty; later restarts do not quarantine again. If the rename is blocked: a copy plus an empty valid store; if that replacement is also blocked, the corrupt file is left untouched, a byte-identical copy is reused (no accumulation) and the session runs read-only |
| Inspect failed or skipped for a previously verified container or volume | The verified record is kept, marked stale (`IDENTITY_NOT_REREAD`), but only if every component still visible in the list (container name, volume driver) is unchanged; otherwise the changed object is recorded as a new, unverified identity |
| More resources than the per-node cap | Kinds that lost rows to the cap keep their previous records as stale (`RESOURCE_CAP_TRUNCATED`); nothing is treated as deleted |
| Store from a newer build | Never overwritten; inventory runs in memory only |

Bounds: 2 nodes in parallel, 2 inspects in parallel, 40 inspects per node,
200 listeners per node, 2,000 resources per node, 20,000 in total; per-request
timeouts of 8 s (15 s for Docker lists). Truncation and skipped inspects are
reported on the node row.

## Security notes

- Builders copy an explicit allow-list of fields. Container environment
  variables, arbitrary labels, commands and bind-mount host paths are never
  copied (the inspect payload contains raw `Config.Env`); tests assert that a
  planted secret never reaches the snapshot or the store.
- Agent tokens never enter the snapshot or the store; node credentials are
  resolved through `nodeService` per request.
- Error messages are passed through the shared redaction utility.

## Verification

| Check | Command |
| --- | --- |
| Model + service, hermetic (29 tests) | `npm run inventory:smoke` |
| Real Agent, fake systemd: discovery, zero control calls, identity mismatch, auth boundary, unreachable node, MainPID change | `npm run inventory:agent:smoke` |
| Real Electron UI against a real Agent | `npm run inventory:ui:qa` |
| Guard chain and tier | `node scripts/permission-matrix-smoke.js` |

The two smokes also run in the `feature` and `release` tiers of
`scripts/release-validation.js`.

## Known limitations

- **GPU** model and VRAM are not reported by any existing Agent route; hosts
  show `gpu: not-reported`.
- **Listener owners and Docker networks** stay unverified (see Identity).
- The **Debian Agent registered on 2026-10-14** (`Anxlab`) reports no
  `serviceManagedInstances` capability, so live systemd discovery there will
  appear only after that host runs a Build 206 Agent.
- Docker's own `GET /api/v1/docker/volumes` inspects every volume and container
  on the Agent side; on hosts with very many containers that read is heavier
  than the rest of discovery.
- Owner classification of non-production scopes (AIM-0) is not implemented.
