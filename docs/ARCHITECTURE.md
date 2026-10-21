# AnxOS Control Center Architecture

## Runtime boundaries

- `main.js` owns Electron startup, privileged IPC registration, window policy,
  updater lifecycle, and shutdown disposal.
- `preload.js` is the context-isolated renderer bridge. Node integration is
  disabled and the renderer sandbox is enabled.
- `app.js` owns renderer state and presentation. It does not hold Agent tokens
  or authorize privileged actions.
- `src/services/` contains Desktop main-process services and node routing.
- `src/shared/` contains code used by both Desktop and the standalone Agent.
- `agent/src/server.js` is the authenticated Agent HTTP boundary. Agent routes
  delegate to services and permission checks.

## State ownership

- Node registry and selected node: `src/services/nodeService.js`.
- Protected per-node credentials: `src/services/nodeCredentialStore.js`.
- Canonical selection notifications: `src/services/activeNodeSelectionService.js`.
- Agent-backed feature routing: `src/services/serviceRouter.js`.
- Long-running backend records: `src/shared/longOperationService.js`.
- Renderer operation presentation is separate and is not execution ownership.

Services are composed in `main.js` and passed into domain IPC registrars. IPC
registrars own boundary validation and authorization; services own domain
state and side effects. The Agent uses the same separation in
`agent/src/server.js`: authentication and API-capability middleware execute
before routes, and routes delegate to shared or Agent-specific services.

Node-aware Desktop services receive an explicit node context. Local application
host execution, a registered Local Agent, and a remote Agent are separate
targets; routing does not infer one from another. The renderer mirrors the
canonical selected id only for presentation and stale-response guards.

## Persistence

Configuration is stored below the resolved AnxOS config directory. Sensitive
credentials use dedicated stores and are omitted from public node records.
Versioned stores write atomically, preserve a migration/corruption backup, and
refuse unknown future schemas. Store-specific versions and failure behavior are
listed in `CONFIG_MIGRATIONS.md`.

Startup loads configuration before accepting privileged work. The Desktop
registers local-instance recovery before IPC; the Agent repairs incomplete
Marketplace installs and backup artifacts before opening its HTTP listener.
Shutdown rejects new Desktop IPC, stops updater network activity, disposes
streams/listeners, and waits for owned instance processes. Agent shutdown
closes the listener and sockets before stopping owned instances.

## Packaging

Electron Builder includes `src/shared/**/*` in the Desktop package and copies
the same JavaScript modules to `local-agent-runtime/src/shared`. This keeps the
packaged Desktop and standalone Agent on one shared implementation. Packaging
smoke coverage resolves and requires shared modules from the packaged Agent's
actual resource depth, rather than checking file presence alone.

## Known boundaries

The renderer's operation list is presentation state, not a durable task engine.
Recovered backend operation records are marked interrupted; executable retry
and cancellation handlers are intentionally not serialized.
The Desktop updater is intentionally outside the shared operation registry. It
uses its own single-flight guards, cancellable HTTP/file handles, atomic
checksum-verified download commit, and no claimed installer rollback.

## Infrastructure Control Plane (V2-K)

Added 2026-09-28. This section describes the endpoint, connectivity, provider,
telemetry, notification, and computer surfaces added for V2-K. Detailed
contracts live in `ENDPOINT_MANAGER.md` and `CONNECTIVITY_MODEL.md`.

### Component map

| Layer | Components | Role |
| --- | --- | --- |
| Stores | `src/services/endpointStore.js` (`endpoints.json`), `src/shared/telemetryStore.js` + `src/services/telemetryService.js` (`telemetry.json`), `src/services/operationalNotificationService.js` (`notifications.json`) | Versioned, bounded, atomically written state with quarantine and future-schema refusal. |
| Services | `endpointService.js` (CRUD, discovery, association), `providerIntegrationService.js` (canonical provider state, tunnel sync), `connectivityDiagnosticsService.js` (six-stage diagnostics, caching, graph), `computerService.js` (computer read model), `telemetryService.js` (sampler), `operationalNotificationService.js` (transition journal) | Domain logic and side effects; never trusted for authorization. |
| Shared models | `endpointModel.js`, `healthModel.js`, `connectivityDiagnostics.js`, `connectivityGraph.js`, `connectivityPresentation.js`, `providerAdapterContract.js`, `providers/playitProviderAdapter.js`, `providers/manualProviderAdapter.js`, `serviceCapabilityContract.js`, `telemetryStore.js` | Dependency-free logic shared with the Agent runtime; the canonical vocabularies live here. |
| IPC | `src/ipc/networkIpc.js`, `telemetryIpc.js`, `notificationsIpc.js`, `computersIpc.js`, `backupsIpc.js` (`backups:verify`); wired in `main.js` | Guard chain (`requireLocalOwnerAuthenticated`, `requirePermission`, `requireNodeContext`) then `audit`, then delegate. Typed `{ ok: false, error }` envelopes for expected Agent unavailability. |
| UI | `index.html` Network page and Notifications page, instance Network/Performance tabs, node details drawer in `app.js`; bridge namespaces in `preload.js` | Presentation only; honest empty/unavailable/degraded states; no polling beyond tab activation and drawer refresh. |
| Schedulers | `main.js` starts the telemetry sampler and the notification scheduler (both unref'd; stopped on `before-quit`) | The stores only advance when their bounded loops run. |

### Data flow

```
Computer            Agent                Service             Local              LAN / Overlay       Provider             Public Endpoint
computerService.js  agentClient.js       service-process     local-socket       host-network        provider stage       public-endpoint
nodeService.js  --> agent/src/server.js  instance record --> TCP connect  --> network inventory --> playit/manual  --> control-plane probe
                    (Agent REST API)     (per run)          (bounded 2.5 s)    (listeners/bound)   adapters            (fixed 2.5 s, vantage note)
```

Read path for the same surfaces:

```
Renderer (app.js) --preload.js--> IPC (networkIpc / telemetryIpc / notificationsIpc / computersIpc)
    --> services (endpointService, providerIntegrationService, connectivityDiagnosticsService,
                  telemetryService, operationalNotificationService, computerService)
    --> stores (endpointStore -> endpoints.json, telemetryService -> telemetry.json,
                operationalNotificationService -> notifications.json)
    --> routing (serviceRouter -> nodeRouter / agentClient -> Agent REST API)
```

### Canonical models

| Model | Home | Notes |
| --- | --- | --- |
| Endpoint | `src/shared/endpointModel.js` + `src/services/endpointStore.js` | Field/type/source semantics, identity (`ep-*`, `endpointKey`), the no-secrets contract. |
| Health | `src/shared/healthModel.js` | Six-state vocabulary, ranks, aggregation, reachability scopes. |
| Diagnostic | `src/shared/connectivityDiagnostics.js` + `connectivityDiagnosticsService.js` + `connectivityGraph.js` + `connectivityPresentation.js` | Stage/result/graph construction, validation, presentation helpers. |
| Provider | `src/shared/providerAdapterContract.js` + `src/shared/providers/*` + `providerIntegrationService.js` | Canonical provider state and tunnels; capability tables; Playit and manual adapters. |
| Computer | `src/services/computerService.js` | First-class computer summary; never throws; frozen shape; last-known contact and degraded reasons. |
| Backup | `agent/src/services/backupService.js` (verification lifecycle, restore confirmation) + `src/ipc/backupsIpc.js` (`backups:verify`) | States `unverified`, `verified`, `failed`, `corrupt`, `unknown`; digest observed, never fabricated. |
| Audit | `src/services/securityService.js` (`audit` + audit log) | Actor, action, outcome, target, reason; identifier-only metadata. |
| Telemetry | `src/shared/telemetryStore.js` + `src/services/telemetryService.js` | Bounded series, missing-is-not-zero, retention, export seam. |

### Ownership boundaries

- Main process owns stores, probes, and schedulers. The diagnostics pipeline is
  read-only: it never starts, stops, repairs, or reconfigures anything.
- The Agent owns machine-local detection and inventory; the desktop never
  substitutes a different node's data, and node-scoped channels require an
  explicit node context.
- Shared modules (`src/shared/**`) stay dependency-free because they are copied
  into the packaged Agent runtime.
- The endpoint store never writes, moves, or deletes
  `public-access-services.json`; the legacy file remains the operator's
  fallback and migration source.
- Stores refuse unseen future schema versions instead of rewriting them
  (`endpoints.json` leaves the file untouched; the notification journal
  quarantines and starts empty).
- Renderer hiding is presentation only and is never a security boundary.

### Extension seams

- **Service adapters** — `src/shared/serviceCapabilityContract.js` exposes the
  closed `SERVICE_CAPABILITY_IDS` vocabulary and `KNOWN_FAMILY_EXTENSIONS`.
  Capability states are `available`, `planned` (visible extension point, never
  rendered as working), and `unsupported`. Minecraft ships a `players`
  extension; FiveM declares `players`, `resources`, and `serverMetadata` as
  planned FXServer HTTP API adapters. Node capability flags
  (`NODE_CAPABILITY_REQUIREMENTS`) gate metrics, endpoints, diagnostics, and
  backups per node.
- **Provider adapters** — one adapter per provider under
  `src/shared/providers/`, registered in `providerIntegrationService`,
  validated by `providerAdapterContract.validateProviderAdapter()` and pinned
  by `scripts/provider-adapter-contract-smoke.js`. Steps for adding a provider
  live in `ENDPOINT_MANAGER.md`.
- **Backup adapters** — the Agent verification lifecycle is additive metadata
  (schema version 1): a record starts `unverified`, `verifyBackup()` observes
  it into `verified`/`failed`/`corrupt`/`unknown`, and restore is a separate
  confirmed operation (`confirmOverwrite: true`, else
  `RESTORE_OVERWRITE_CONFIRMATION_REQUIRED`; preview is read-only).
- **Telemetry export** — `telemetryStore.exportSeries()` is the read-only
  handoff to a future persistence/transport layer; the desktop export channel
  is its current consumer.

### Known transitional duplication

The legacy Public Access workspace (`data-page="playit"`, `publicAccessIpc`,
`playitIpc`, `publicAccessServiceRegistry`) still exists alongside the new
Network page, and the legacy instance Overview fields
(`data-instance-network-detail`) duplicate part of the instance Network tab.
`public-access-services.json` is still written by the legacy surfaces while
the endpoint registry is the canonical model going forward.

Consolidation intent: the Network page and instance Network tab read the
canonical endpoint registry, provider adapters, and diagnostics graph; the
legacy surfaces stay only until provider creation/repair flows are fully
covered by the new surfaces. Consolidation should remove the duplicate read
models and pages, not the legacy file: `public-access-services.json` remains
untouched as the one-shot migration source and the rollback path.
