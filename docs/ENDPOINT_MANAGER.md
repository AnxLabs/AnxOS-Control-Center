# Endpoint Manager

The Endpoint Manager is the V2-K infrastructure-control-plane surface that
replaces ad-hoc Public Access records with a single endpoint registry. An
endpoint is one addressing record that describes how a managed service can be
reached: the host, optional port and protocol, the classification of the
address, and the provider, service, or computer it belongs to.

The registry is desktop-local state (`endpoints.json`). It is read-only toward
its legacy source: the Public Access file (`public-access-services.json`) is
imported once and never rewritten or deleted.

Related documents:

- `CONNECTIVITY_MODEL.md` — health vocabulary, diagnostics stages, degraded
  behavior.
- `ARCHITECTURE.md` — component map and ownership boundaries.
- `CONFIG_MIGRATIONS.md` — store versioning conventions.
- `SECURITY_BOUNDARIES.md` — authorization model for IPC surfaces.

## Endpoint entity

### Fields

| Field | Type | Semantics |
| --- | --- | --- |
| `id` | string | Stable endpoint identity, `ep-<16 hex>`. Derived from endpoint identity when not supplied. |
| `name` | string | Required, at most 120 characters. |
| `type` | enum | One of `lan`, `private`, `tailscale`, `public`, `custom`. Required. |
| `host` | string | IPv4 address, IPv6 address, or DNS hostname. Required, at most 253 characters, stored lowercase for names. |
| `port` | integer or null | 1–65535 when present. |
| `protocol` | enum or null | One of `tcp`, `udp`, `http`, `https`. |
| `enabled` | boolean | Defaults to `true`. Disabled endpoints are preserved and sorted last, never deleted. |
| `providerId` | string or null | Provider slug matching `[a-z0-9][a-z0-9-]{0,63}` (for example `playit`, `manual`). |
| `serviceId` | string or null | The managed service (instance) the endpoint describes, matching `[A-Za-z0-9._-]{1,120}`. |
| `computerId` | string or null | The computer (node) that owns the endpoint. The store's list filter names this key `nodeId`. |
| `source` | enum | One of `discovered`, `manual`, `provider`. Defaults to `manual`. |
| `notes` | string | Free text, at most 500 characters. |
| `metadata` | object | Flat metadata bag: at most 24 keys; values are string (at most 300 characters), number, boolean, or null. |
| `health` | object or null | Nullable health snapshot accepted by the model and store. No current producer persists this field; surfaces attach health in memory from cached diagnostics. |
| `lastCheckedAt` | string or null | ISO timestamp of the last recorded check. |
| `createdAt` / `updatedAt` | string | ISO timestamps maintained by the store. `createdAt` is preserved across updates; `updatedAt` is rewritten on every write. |

### Type semantics

The type describes the reachability scope, not the confidence that the
endpoint currently works.

| Type | Meaning |
| --- | --- |
| `lan` | Reachable on the local network segment (same LAN as the operator machine). |
| `private` | Reachable through private address space only (RFC1918, link-local, CGNAT); not necessarily on the local segment. Discovery classifies loopback addresses (`127.0.0.0/8`, `::1`) as `private`. |
| `tailscale` | Reachable over a Tailscale tailnet (`100.64/10` address or MagicDNS name); access depends on tailnet membership. |
| `public` | Reachable from the public internet. Treat public exposure as hostile. |
| `custom` | User-defined classification that does not fit the types above. |

### Source semantics

| Source | Meaning |
| --- | --- |
| `discovered` | Written by endpoint discovery from live listener or probe evidence. Discovery only ever creates or updates `discovered` records, never deletes, and never flips `enabled`. |
| `manual` | Operator-created. Discovery skips any identity that already exists with a non-`discovered` source. |
| `provider` | Reconciled from a provider tunnel by `providerIntegrationService.syncTunnels()`. Provider endpoints carry fixed tunnel metadata (`tunnelId`, `tunnelName`, `region`, `addressSource`). |

### Identity and uniqueness

- `buildEndpointId({ computerId, type, host, port, protocol, serviceId, name })`
  derives `ep-` plus the first 16 hex characters of the SHA-256 digest over
  those components joined by `|`.
- `endpointKey(endpoint)` is
  `computerId|type|host|port|protocol|serviceId` — the duplicate identity.
  Two endpoints with the same key cannot coexist; the store refuses the write
  with `ENDPOINT_DUPLICATE`.
- Updating through the same `id` reuses the existing record and preserves
  `createdAt`. Updating an input whose identity matches a different record is
  refused rather than silently merged.
- Discovery reconciliation is keyed by the same `endpointKey`; an existing
  discovered record keeps its `id` while its host and merged metadata are
  refreshed from the new evidence.

### Validation

`validateEndpointInput()` returns typed field errors instead of sanitizing
silently. Host validation rejects control characters, shell metacharacters,
whitespace, and bracketed-invalid IPv6 forms; ports accept integers or numeric
strings. Store-level failure codes: `ENDPOINT_VALIDATION_FAILED`,
`ENDPOINT_DUPLICATE`, `ENDPOINT_NOT_FOUND`. Field codes include
`ENDPOINT_NAME_REQUIRED`, `ENDPOINT_NAME_TOO_LONG`, `ENDPOINT_TYPE_INVALID`,
`ENDPOINT_HOST_REQUIRED`, `ENDPOINT_HOST_INVALID`,
`ENDPOINT_HOST_TOO_LONG`, `ENDPOINT_PORT_INVALID`,
`ENDPOINT_PROTOCOL_INVALID`, `ENDPOINT_SOURCE_INVALID`,
`ENDPOINT_PROVIDER_INVALID`, `ENDPOINT_SERVICE_INVALID`,
`ENDPOINT_COMPUTER_INVALID`, `ENDPOINT_NOTES_TOO_LONG`,
`ENDPOINT_ENABLED_INVALID`, and `ENDPOINT_METADATA_INVALID`.

## Discovery

Discovery answers one question per managed service: which addresses and ports
does this computer actually expose for it? It is conservative by design:

- it only creates or updates endpoints with `source: "discovered"`,
- it never deletes an endpoint,
- it never changes `enabled`,
- it never overwrites a `manual` or `provider` record,
- every call is bounded — the agent inventory read and the local TCP probes
  run under timeouts.

Discovery targets one managed service (`serviceId`). Ports come from the
instance record (`ports` entries and `preferredPort`). A run without
`serviceId` finds no ports and reports reason `no-ports`.

### Two evidence paths

| Target | Evidence | Behavior |
| --- | --- | --- |
| Agent node | Read-only network inventory (`serviceRouter.getNetworkInventory`): listener rows, interface addresses, and a per-port check | Loopback listeners become `private` (scope `loopback`). Wildcard listeners (`0.0.0.0`, `::`, `*`) are expanded to the computer's LAN interfaces (IPv4 only) and Tailscale interfaces. Concrete non-loopback bind addresses are recorded with scope `bound`. |
| Application host | Bounded local TCP connect probe (`127.0.0.1` plus every non-internal interface address, 1500 ms per probe) | Listening probe results become endpoints: internal/loopback → `private` (scope `loopback`); private-range → `lan`; Tailscale-named or CGNAT addresses → `tailscale`; anything unclassifiable is skipped with reason `unclassified-address`. |

Address classification mirrors the endpoint type semantics:
`tailscale` interface name or CGNAT (`100.64.0.0/10`) → `tailscale`;
private address ranges → `lan`; loopback → `private`; otherwise `custom`
(concrete bind addresses only).

### Discovery result states

| State | Condition |
| --- | --- |
| `healthy` | Every requested port was listening and nothing was skipped. |
| `degraded` | Some port was not listening, or listeners were skipped for another reason. |
| `unknown` | No ports were determined, inventory or probe was unavailable, or instances could not be read. |
| `unsupported` | The node reports no network inventory support, or the local probe reports `supported: false`. |

Result payload also carries `created`, `updated`, `ports`, `skipped` reasons,
`inventoryAvailable`, and `portNotListening`. An unreachable Agent throws
`ENDPOINT_AGENT_UNAVAILABLE`, which the IPC layer treats as an expected
degraded outcome.

## Provider integration

`providerIntegrationService` maps provider detection snapshots into canonical
provider state and reconciles provider tunnels into endpoint records.

### Canonical provider state

Every adapter produces one shape via
`normalizeProviderState()` from `src/shared/providerAdapterContract.js`:
`providerId`, `displayName`, `availability` (`available`/`unavailable`/
`unknown`), `state` (`running`, `stopped`, `not-installed`, `auth-required`,
`setup-required`, `degraded`, `unsupported`, `unknown`), `connected`,
`version`, `region`, `publicAddress`, `localTarget`, `tunnels`,
`lastCheckedAt`, and bounded `diagnostics` entries (`code`, `message`).

The contract strips denylisted keys (`token`, `secret`, `password`,
`credential`, `apiKey`, `auth`, `authorization`, `privateKey`,
`refreshToken`, `accessToken` and any key matching the shared sensitive-key
regex) and replaces credential-looking string values with `[redacted]` before
any mapping sees them. Adapters must never claim a capability they do not
have:

| Capability | playit | manual |
| --- | --- | --- |
| `detect` | true | false |
| `status` | true | true |
| `listTunnels` | true | false |
| `controlAgent` | true | false |
| `publicAddress` | true | false |
| `localTarget` | true | false |
| `region` | true | false |
| `endpointDiscovery` | true | false |
| `createTunnel` / `deleteTunnel` | false | false |

`detect` and `status` both return the canonical provider state; `listTunnels`
returns canonical tunnels; `endpointDiscovery` turns one canonical tunnel into
an endpoint-model input. The remaining capabilities are descriptive booleans.

### Playit behavior

`src/shared/providers/playitProviderAdapter.js` maps the desktop/agent Playit
detection snapshot (installed, running, connected, tunnel address/domain,
local target, protocol, tunnel id, version, diagnostics, tunnels) into the
canonical shape. State mapping:

- `installed === false` → `not-installed`
- auth evidence (`authenticated === false`, `authRequired`, or an
  auth-required marker in diagnostics) → `auth-required`, unless Playit is
  installed and running with `connected === true` (live evidence wins over a
  stale auth note)
- installed and `running === false` → `stopped`
- running and `connected === false` → `degraded`
- running → `running`
- anything else → `unknown`

`syncTunnels()` is idempotent and reconciles tunnels into provider endpoints:
records are classified `endpointsCreated`, `endpointsUpdated`, `unchanged`,
`associated`, `ambiguous`, or `unassociated` from the pre-upsert state. Tunnels
without a local port or with a protocol other than `tcp`/`udp` are skipped with
a note. Stale provider endpoints (a stored `provider` endpoint whose tunnel id
no longer matches a reported tunnel) are reported in
`staleProviderEndpoints` — never deleted and never disabled.

### Graceful degradation

- A thrown, rejected, or timed-out Playit snapshot (default 8 s bound) degrades
  to state `unknown`, availability `unknown`, with diagnostic
  `PROVIDER_SNAPSHOT_UNAVAILABLE`. `getProviderSnapshot()` never throws for
  provider failure; only a missing `nodeId` throws `NODE_REQUIRED`.
- `syncTunnels()` failures are recorded as data: state `unknown` with
  `AGENT_UNAVAILABLE` or `PROVIDER_SNAPSHOT_INVALID`, or state `not-installed`
  with `PLAYIT_NOT_INSTALLED`. No endpoints are changed in any failure path.
- Snapshot reads are cached briefly (default TTL 30 s) and can be forced with
  `refresh: true`.
- Provider sync outcomes are persisted per node in `endpoints.json`
  (`providerSyncs[nodeId]` with `providerId`, `lastSyncAt`, `state`,
  `tunnelCount`, `errorCode`).
- Local and private endpoints are independent of provider state: a provider
  outage cannot degrade a LAN reachability claim (see
  `CONNECTIVITY_MODEL.md`).

### Manual provider

The manual / port-forwarding adapter has nothing to detect on the machine:
reachability depends on operator-managed router and DNS configuration AnxOS
cannot observe. It reports state `setup-required` with availability `available`
only when the caller says manual endpoints are recorded, and always carries the
`MANUAL_PROVIDER_ADVISORY` diagnostic ("Public reachability depends on
operator-managed router/DNS configuration and is not verified by AnxOS"). It
declares no other capabilities.

### Adding a provider

1. Create `src/shared/providers/<providerId>ProviderAdapter.js`. It must stay
   dependency-free (no Electron, no `fs`, no network — the file is copied into
   the standalone Agent runtime).
2. Implement `id` (lowercase slug), `displayName`, and a frozen `capabilities`
   object keyed by the contract's capability ids with real boolean values.
3. Implement a function for every capability you declare `true` among
   `detect`, `status`, `listTunnels`, `endpointDiscovery`.
4. Map detection output through `normalizeProviderState()` and tunnels through
   `normalizeTunnel()`; return endpoint inputs from `endpointDiscovery` with a
   fixed metadata key set.
5. Register the adapter in `providerIntegrationService.getDefaultRegistry()`
   and route `getProviderStateForNode()` to it.
6. Extend `scripts/provider-adapter-contract-smoke.js`: it deep-checks
   adapters against the contract, so capability drift fails the build.
7. Add a smoke with fake snapshots for the new provider's state mapping and
   tunnel reconciliation (see `scripts/provider-integration-smoke.js`), and
   register nothing in shared code that assumes provider-specific fields —
   consumers read only the canonical shape.

## Migration from Public Access

The legacy `public-access-services.json` file is read-only during migration.
Imported candidates per record:

| Legacy field | Imported as |
| --- | --- |
| `localPort` + `localHost` (default `127.0.0.1`) | One `private` endpoint (scope `local`) named `<name> (local)`. |
| `publicAddress` | One `public` endpoint named `<name> (public)` with provider id from `providerId` (validated slug) or `manual`; metadata carries `legacyRef`, `tunnelId`, `tunnelName`, `accessType`. |
| `privateAddress`, `DNSName`, `dnsName`, `hostname`, or `IPv4` | One `tailscale` endpoint named `<name> (tailscale)`. |
| `endpointOptions` (`magicdns`, `ipv4`, `ipv6`, at most 3 per service) | One `tailscale` endpoint per option, named from the option label/type. |

Skipped records are counted and kept in the migration report with reasons:

- `no-port` — no usable `localPort`; the record cannot produce an endpoint.
- `duplicate` — the candidate identity already exists in the registry (from an
  earlier legacy record or an existing endpoint). Migration is additive and
  never merges into an existing record.
- `invalid` — the candidate fails endpoint validation.
- `legacy-corrupt` — the legacy file exists but is unreadable; it is left
  untouched and a `ENDPOINT_LEGACY_CORRUPT` error is reported.

Migration is one-shot and idempotent: the first load with no `endpoints.json`
present imports from the legacy file and records
`legacyMigration: { appliedAt, source, imported, skipped, reasons }` in
`endpoints.json`; later loads with that record return `alreadyApplied: true`
and change nothing. `migrateLegacyAccessServices({ dryRun: true })` previews
the same report without writing. The legacy file itself is never modified,
moved, or deleted.

## Storage, recovery, and rollback

### File shape

`<configDirectory>/endpoints.json`:

```json
{
  "schemaVersion": 1,
  "endpoints": [],
  "providerSyncs": {
    "<nodeId>": { "providerId": null, "lastSyncAt": null, "state": null, "tunnelCount": null, "errorCode": null }
  },
  "legacyMigration": null
}
```

Writes are atomic (temp file + rename) with mode `0600`. Loads are tolerant:
malformed endpoint records are dropped, duplicate ids and identities are
dropped, and provider-sync and migration fields are re-normalized.

### Recovery and quarantine

- Corrupt file (unreadable, unparseable, or not an object): the original bytes
  are preserved as `<file>.corrupt-<timestamp>` and the store starts empty.
  `loadReport.corrupt` is `true` with code `ENDPOINT_STORE_CORRUPT`. Nothing is
  silently deleted.
- Future schema (`schemaVersion` greater than 1): `load()` throws
  `ENDPOINT_SCHEMA_UNSUPPORTED` and the file is left untouched. This build
  refuses to rewrite state it does not understand.
- Schema migrations (when an older version exists in the future) run behind
  `migrationRecoveryPolicy`: a recovery point `<file>.schema-v<from>.backup`
  must be taken, read back, and byte-verified before any rewrite; otherwise
  the migration fails with `ENDPOINT_MIGRATION_RECOVERY_UNVERIFIED`.
- A migration error or corruption surfaces as `degraded: true` on endpoint
  read models (`getEndpointSummary`, `resolveServiceEndpoints`,
  `endpoints:list`) so the UI can disclose it instead of pretending the
  registry is healthy.

### Rollback

Reverting the desktop code to a pre-endpoint build leaves the registry file
unread by that build and the legacy Public Access file untouched, so the
legacy page keeps working. To fully reset the new registry:

1. Close the app.
2. Delete `<configDirectory>/endpoints.json` (optional, explicit operator
   action; backups are the operator's responsibility).
3. On next load, the file is absent, so the one-shot migration re-imports the
   legacy records from `public-access-services.json` (ids are computed
   deterministically, so re-imported identities are stable).

No endpoint state is stored anywhere else, and no rollback step modifies the
legacy file.

## Secret contract

Endpoint records and their metadata are addressing/routing data only. They must
never contain credentials, tokens, passwords, API keys, connection strings with
embedded secrets, or any other secret material — secrets belong in secure
storage. Enforcement layers:

- `endpointModel` validation bounds metadata to flat primitives and rejects
  nested structures.
- Provider adapters strip sensitive keys and credential-looking values before
  mapping.
- `computerService` applies a sensitive-key denylist (`token|secret|password|
  passwd|credential|auth|api[-_]?key|private[-_]?key|cookie`) to endpoint
  metadata as presentation defense in depth.
- Diagnostics evidence accepts only flat scalars (no provider snapshots or
  credential-shaped objects) and refuses nested structures loudly.

## IPC channels and permission tiers

All channels are main-process `ipcMain.handle` routes registered by
`src/ipc/networkIpc.js`, `telemetryIpc.js`, `notificationsIpc.js`, and
`computersIpc.js`. The endpoint, diagnostics, provider, telemetry,
notification, and computer channels run the guard chain
`requireLocalOwnerAuthenticated → requirePermission → audit` (node-scoped
endpoint/provider/diagnostics channels additionally validate `payload.nodeId`
through `requireNodeContext`). `backups:verify` uses `requireNodeContext →
requirePermission → audit` and refuses non-Agent targets (`NODE_NOT_AGENT`).

| Channel | Permission token | Owner | Admin | Operator / legacy User | Viewer | Service |
| --- | --- | --- | --- | --- | --- | --- |
| `endpoints:list` | `endpoints:read` | yes | yes | yes | yes | no |
| `endpoints:create` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:update` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:delete` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:setEnabled` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:associate` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:discover` | `endpoints:write` | yes | yes | no | no | no |
| `endpoints:test` | `diagnostics:run` | yes | yes | yes | no | no |
| `connectivity:getDiagnostics` | `endpoints:read` | yes | yes | yes | yes | no |
| `connectivity:runDiagnostics` | `diagnostics:run` | yes | yes | yes | no | no |
| `providers:getStatus` | `providers:read` | yes | yes | yes | yes | no |
| `providers:sync` | `providers:sync` | yes | yes | no | no | no |
| `telemetry:getSummary` | `telemetry:read` | yes | yes | yes | yes | no |
| `telemetry:getSeries` | `telemetry:read` | yes | yes | yes | yes | no |
| `telemetry:export` | `telemetry:export` | yes | yes | no | no | no |
| `telemetry:clear` | `telemetry:manage` | yes | yes | no | no | no |
| `notifications:list` | `nodes:read` | yes | yes | yes | yes | no |
| `computers:getSummary` | `nodes:read` | yes | yes | yes | yes | no |
| `backups:verify` | `backups:verify` | yes | yes | yes | no | no |

Owner holds `["*"]`; the legacy `User` role keeps the exact Operator profile;
`Service` identities carry explicit grants only and grant nothing implicitly.
`endpoints:discover`, `endpoints:test`, `connectivity:*`, `providers:*`, and
`backups:verify` require a node-scoped Agent context; the application host is
a valid target for `computers:getSummary` (defaulting to the selected node or
the application host).

## Audit actions

The V2-K surfaces add these audit actions (identifier-only metadata; no
credential or token material is recorded):

| Action | Channel |
| --- | --- |
| `endpoints.list` | `endpoints:list` |
| `endpoint.create` | `endpoints:create` |
| `endpoint.update` | `endpoints:update` |
| `endpoint.delete` | `endpoints:delete` |
| `endpoint.toggle` | `endpoints:setEnabled` |
| `endpoint.associate` | `endpoints:associate` |
| `endpoint.discover` | `endpoints:discover` |
| `endpoint.test` | `endpoints:test` |
| `connectivity.getDiagnostics` | `connectivity:getDiagnostics` |
| `connectivity.runDiagnostics` | `connectivity:runDiagnostics` |
| `providers.getStatus` | `providers:getStatus` |
| `provider.sync` | `providers:sync` |
| `telemetry.getSummary` | `telemetry:getSummary` |
| `telemetry.getSeries` | `telemetry:getSeries` |
| `telemetry.export` | `telemetry:export` |
| `telemetry.clear` | `telemetry:clear` |
| `notifications.list` | `notifications:list` |
| `computers.getSummary` | `computers:getSummary` |
| `backup.verify` | `backups:verify` |

Audit records carry actor (id, username, role), action, outcome, target, and
reason. The new call sites pass identifiers, node ids, endpoint ids, and
backup ids only — never payloads, addresses beyond the target id, or
credentials.

## UI surfaces

| Surface | Location | Behavior |
| --- | --- | --- |
| Network page | `index.html` `data-page="network"` (`app.js` renderers `renderNetworkProviders`, `renderNetworkEndpoints`, `renderNetworkDiagnostics`, `renderNetworkGraph`) | Summary cards (endpoints, enabled, issues, providers), provider cards from the canonical provider snapshot, the endpoint registry with per-endpoint test/toggle actions, diagnostics results (summary, reachability scopes, six stages with remediation actions), and the connectivity graph. |
| Instance Network tab | `index.html` `data-instance-panel="network"` (`refreshInstanceNetworkTab`, `renderInstanceNetworkTab`, `refreshInstanceNetworkDiagnostics`) | Service-scoped endpoint registry with Add Endpoint, Discover, Sync Provider, Run Diagnostics, and Copy Address actions; diagnostics panel and connectivity graph; honest empty/unavailable/degraded states; lazy load on tab activation with serial-number guards against out-of-order responses; no polling. |
| Instance Performance tab | `index.html` `data-instance-panel="performance"` | Sampled telemetry history for the instance from the bounded store (ranges, honest "no samples yet" empty state). |
| Node details drawer | `app.js` `renderNodeConnectivity` | Computer summary (identity, connectivity scopes, addresses, services, endpoints, telemetry, provider sync) read from `computers:getSummary` with a fallback to the endpoint registry plus the loaded node record when the channel is unavailable. Refreshed on drawer open and health refresh only. |
| Notifications page | `index.html` `data-page="notifications"` | Operational journal list with severity/category filters and action links (`Open Nodes`, `Open Instance`, `Open Network`). |

Renderer access goes through `preload.js` namespaces `endpoints`,
`connectivity`, `providers`, `telemetry`, `notifications`, and `computers`.
The renderer never holds endpoint secrets or authorizes privileged actions —
it renders what the main process returns.
