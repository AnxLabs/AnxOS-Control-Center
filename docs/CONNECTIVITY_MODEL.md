# Connectivity Model

This document defines how AnxOS Control Center describes whether a service can
be reached, how connectivity diagnostics are structured and bounded, and what
the UI and notifications may claim from that evidence. Everything here is
implemented in `src/shared/healthModel.js`,
`src/shared/connectivityDiagnostics.js`,
`src/services/connectivityDiagnosticsService.js`,
`src/shared/connectivityGraph.js`, and
`src/services/operationalNotificationService.js`.

## RUNNING is not HEALTHY; HEALTHY is not PUBLICLY REACHABLE

A process can be Running while nothing outside the machine can reach it. The
model therefore treats three questions as distinct:

- **Process**: is the service process alive? (`service-process` stage)
- **Reachability**: from where can it actually be reached? Each scope —
  local, LAN, private overlay, public — has its own evidence (its own
  stage or combination of stages).
- **Provider / public path**: does a tunnel provider carry traffic, and does a
  public endpoint answer a probe from the control plane's vantage?

No answer implies the next one. `healthy` requires positive evidence; absence
of evidence is `unknown`, never `healthy`. A RUNNING service with no probe
evidence is not "healthy", and a connected tunnel provider is not proof that
any specific endpoint is publicly reachable.

## Health vocabulary

The six canonical states (`CONNECTIVITY_STATES` in
`src/shared/healthModel.js`). Everything the endpoint manager, diagnostics
pipeline, connectivity graph, notifications, and computer summary report must
be expressed in these states, never in ad-hoc strings.

| State | Meaning | Typical producer |
| --- | --- | --- |
| `healthy` | Positive evidence that this stage/scope works now. | TCP connect succeeded; port bound; agent online and fresh; provider running and connected; instance Running. |
| `degraded` | Evidence that it partially works or works with reduced reliability. | Agent degraded; provider running but not connected; port not listening while others were; discovery completed with skipped listeners. |
| `failed` | Evidence that it does not work. | Connection refused; port not bound; provider stopped/not installed/auth-required; agent offline; instance Stopped/Failed. |
| `unknown` | The question has not been answered (missing, stale, or timed-out evidence). It is neither failed nor healthy. | Probe timed out; dependency call threw or timed out; agent health data stale; no recorded provider state. |
| `unsupported` | This check does not apply in this configuration and there is nothing to fail. | UDP reachability cannot be probed; node reports no network inventory support; provider unsupported on this computer. |
| `not_configured` | No path/check has been configured yet and there is nothing to fail. | No service associated; no provider configured for the endpoint; no public endpoint configured. |

Rules:

1. Process/lifecycle state, reachability, and provider state are distinct
   axes; one never implies another.
2. `healthy` requires positive evidence; absence of evidence is `unknown`.
3. `unknown` is neither failed nor healthy — it means the question has not
   been answered.
4. `unsupported` and `not_configured` are not failures; they mean there is
   nothing to fail.
5. A RUNNING service is not automatically reachable: a healthy
   `service-process` stage says nothing about local-socket, host-network,
   provider, or public-endpoint reachability.
6. Unrecognized state strings are treated as `unknown`, so a typo can never be
   reported as healthy.

### Aggregation

Two pure functions combine states, and the choice between them depends on what
is being asked:

| Function | Question | Semantics |
| --- | --- | --- |
| `worstState(states)` | "How bad is this set overall?" | Highest-ranked state present. Ranks: `healthy` 1, `degraded` 2, `unknown` 3, `failed` 4. Unranked states (`unsupported`, `not_configured`) are excluded; when only unranked states are present the answer is `not_configured`; empty input is `unknown`. |
| `combineStates(states)` | "Do these jointly describe one path/scope?" | Any `failed` → `failed`; otherwise any `unknown` (or empty) → `unknown`; otherwise any `degraded` → `degraded`; otherwise any `healthy` → `healthy`; otherwise the single unranked value, or `not_configured` when several unranked values are mixed. |

`unknown` outranks `degraded` and `healthy` in `worstState` because absence of
evidence must never silently read as good news.

### Instance process mapping

`mapInstanceProcessState()` maps the stored instance lifecycle onto
diagnostic-path states. These are diagnostic states, not the canonical
instance lifecycle enum (the renderer's lifecycle classification remains the
authority for instance lifecycle).

| Instance state | Diagnostic state |
| --- | --- |
| `Running` | `healthy` |
| `Starting`, `Restarting`, `Stopping` | `degraded` |
| `Stopped`, `Failed` | `failed` |
| `Setup Required` | `not_configured` |
| anything else | `unknown` |

A Stopped or Failed process is `failed` on the connectivity path because it
cannot carry traffic; Setup Required is merely `not_configured` because it has
a guided workflow and is not an operational fault.

## Reachability scopes

Scopes are the distinct questions a connectivity check can answer
(`REACHABILITY_SCOPES`).

| Scope | Label | Computed from |
| --- | --- | --- |
| `process` | Process | `service-process` stage state. |
| `local` | Local | `combineStates([service-process, local-socket])`. |
| `lan` | LAN | Only when at least one `lan` endpoint exists: `combineStates([local, host-network])`. No LAN endpoint → `not_configured`; endpoint read failure → `unknown`. |
| `private_overlay` | Private Overlay | Same as LAN, keyed on at least one `tailscale` endpoint. |
| `public` | Public | `public-endpoint` stage state when a public endpoint exists; no public endpoint → `not_configured`; endpoint read failure → `unknown`. |

The diagnostics model's `buildReachability()` default only answers
`process` and `local` from the stages; LAN, overlay, and public default to
`unknown` unless the caller supplies explicit, valid scope states. The
diagnostics service always supplies the scope map above.

## The six diagnostic stages

One run of `connectivityDiagnosticsService.runDiagnostics()` walks six ordered
checkpoints from the service process out to the public internet. Each stage
uses its own evidence source and maps it into the canonical states.

| # | Stage id | Label | Evidence used | State mapping |
| --- | --- | --- | --- | --- |
| 1 | `service-process` | Service Process | The instance record (`state`/`processState`, `processRunning`, `pid`, `uptimeSeconds`, `healthState`), read through the service router. | `mapInstanceProcessState`; no service associated or instance missing → `not_configured`; failed adds a Start service remediation hint. |
| 2 | `local-socket` | Local Port | The endpoint under test (`endpointId`, else the first enabled endpoint for the service); a bounded TCP connect probe to `host:port` (default 2500 ms). | Connected → `healthy` with latency; refused → `failed` (Open Network hint); timeout → `unknown`; other error → `failed`; UDP → `unsupported`; missing endpoint/port → `not_configured`. |
| 3 | `host-network` | Host Networking | The node's network inventory shaped with a per-port check: listener rows, `checkPort.listening`, bound addresses, listener source. | Bound → `healthy` with `boundAddresses`; not listening → `failed`; inventory unsupported → `unsupported`; check unavailable → `unknown`; no port → `not_configured`. |
| 4 | `agent` | Agent | The node record's connection state and last successful contact. | Application host → `not_configured` (local computer, no agent required); online → `healthy`; degraded → `degraded`; offline / `authentication_failed` / `agent_incompatible` → `failed`; stale (> 120 s since last contact) → `unknown`; otherwise `unknown`. |
| 5 | `provider` | Tunnel Provider | The canonical provider state for the endpoint's (or public endpoint's) `providerId` from `providerIntegrationService`. | Running + connected → `healthy`; running + not connected → `degraded`; stopped / not-installed / auth-required → `failed` (Open provider hint); unsupported → `unsupported`; anything else → `unknown`; no provider configured → `not_configured`. |
| 6 | `public-endpoint` | Public Endpoint | The chosen public endpoint (explicit endpoint, else first enabled public endpoint) and, optionally, a control-plane TCP probe at a fixed 2500 ms timeout. | Connected → `healthy` with `vantage: "control-plane"`; provider stage failed → `failed` ("Provider path failed"); probe failure/timeout → `unknown` with the NAT-hairpin note; no port → `unknown`; no public endpoint → `not_configured`. |

Overall state is `worstState(stages)`. Headlines are derived from the stages:
`Path broken at: <failed stages>`, `Incomplete evidence: <unknown stages>`,
`Degraded at: <degraded stages>`, `Healthy`, or `Not configured`.

### Remediation kinds

Stage remediation entries use the closed vocabulary `open-network`,
`open-provider`, `start-service`, `open-console`, `copy-details`. Unknown
stages receive a Copy details hint by default; failed stages receive the
stage-specific hint. The renderer maps `open-network` to the Network page and
`open-provider` stays on the provider surface.

## Caching, timeouts, and bounded probing

The diagnostics pipeline is read-only: it never starts, stops, repairs, or
reconfigures anything. It reads recorded state and runs bounded TCP probes.

| Policy | Value |
| --- | --- |
| Result cache TTL | 30 000 ms (configurable per service instance). Cache key: `nodeId|serviceId|endpointId`. |
| Cache bypass | `refresh: true` skips the cache. `endpoints:test` and `connectivity:runDiagnostics` always pass `refresh: true`; UI reads (`connectivity:getDiagnostics`, telemetry, notifications, computer summary) use the cache only. |
| In-flight deduplication | Concurrent identical runs share one promise. |
| Dependency call budget | Every dependency call (`getServiceContext`, `getEndpoints`, `getProviderState`, `getNetworkInventory`, `getAgentState`) runs under the probe timeout (default 2500 ms). |
| Local probe timeout | Default 2500 ms (`probeTimeoutMs`). |
| Public probe timeout | Fixed at 2500 ms; deliberately constant so a caller-tuned local probe timeout cannot change the public probe. |
| Agent staleness | Agent health data older than 120 000 ms is `unknown`, not healthy. |
| Stage isolation | Every stage runs in try/catch; a thrown, hung, or timed-out dependency becomes a stage in state `unknown` with sanitized evidence. `runDiagnostics()` never rejects for dependency failures. |
| Single caller error | Passing an `endpointId` that does not exist for the target throws a typed `ENOTFOUND` before any stage runs. |
| Evidence bounds | At most 12 stages, 24 evidence keys per stage, 32 items per evidence array; evidence values are flat scalars only. Result ids are deterministic: `dx-` plus the first 16 hex characters of the SHA-256 digest over the canonical target, `checkedAt`, and stage states (never evidence). |
| Cache reads | `getCachedDiagnostics()` returns the cached result or an explicit sentinel `{ cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" }` — never a fabricated health state. |

Endpoint discovery (`endpointService`) uses its own bounded probe: a 1500 ms
TCP connect per address, with no shell and no UDP probe. Telemetry reads cached
diagnostics only and never probes.

## Vantage honesty

- The public-endpoint probe runs **from the control plane** (the operator's
  desktop). A successful connection proves the control-plane vantage can
  reach the endpoint; it does **not** prove internet-wide reachability.
- A failed or timed-out public probe is reported as `unknown`, never `failed`,
  with the NAT-hairpin caveat: "External reachability not confirmed from this
  vantage (NAT hairpin or firewall on the local network can cause this)." A
  node cannot always reach its own public address, so this result is
  evidence-quality data, not a verdict.
- "External reachability not verified" is the honest fallback whenever no
  probe was executed.
- Provider health (`running`) is provider-level only: it says the provider
  agent reports itself up, not that any tunnel or endpoint is reachable from
  the public internet.

## Graph data model

`src/shared/connectivityGraph.js` (`buildConnectivityGraph`) turns a
diagnostics result plus endpoint inventory into a deterministic node/edge
graph. It is main-process only and fabricates nothing: when diagnostics are
missing, every node and edge is `unknown`.

Nodes:

| Kind | Id | State source |
| --- | --- | --- |
| `service` | `service:<id>` | Overall diagnostics state. |
| `computer` | `computer:<id>` | `agent` stage. |
| `provider` | `provider:<providerId>` (one per unique provider id, sorted) | `provider` stage. |
| `endpoint` | `endpoint:<id>` | Route-dependent: provider-sourced endpoints use the `provider` stage; `public` endpoints use `public-endpoint`; all others use `combineStates([local-socket, host-network])`. |

Edges: `service → computer` (`service-process` state), `computer → endpoint`
(endpoint edge state, labeled `<protocol> <port>` when derivable), and
`provider → endpoint` (public-endpoint state) for provider-routed endpoints.

Bounds and determinism: at most 40 nodes (`MAX_NODES`); endpoints sorted by
type/name/id with a stable index tiebreaker and de-duplicated by explicit id;
nodes beyond the budget are omitted, `truncated: true` is set, and the summary
detail names the omitted count. The summary carries the worst node state and
node/edge counts.

## Notification severity mapping

`operationalNotificationService` is transition-driven, not snapshot-driven:
the first observation of a target only seeds its state (a desktop start or a
fresh journal cannot spam), and later transitions emit exactly one event per
target. See `docs/ENDPOINT_MANAGER.md` for the endpoint fields it reads.

| Category | Transition | Severity | Action link |
| --- | --- | --- | --- |
| `agent` | Any state → offline | `critical` "Machine disconnected" | `open-nodes` |
| `agent` | Offline → online (only when an unresolved incident exists) | `info` "Machine back online" | `open-nodes` |
| `service` | → failed with crash-loop evidence | `critical` "Service crash loop" | `open-instance` |
| `service` | Running → failed | `critical` "Service crashed" | `open-instance` |
| `service` | Running → stopped | `warning` "Service stopped unexpectedly" | `open-instance` |
| `service` | Failed/stopped → running (only with an unresolved incident) | `info` "Service running again" | `open-instance` |
| `provider` | Connected → stopped / not installed | `critical` "Tunnel provider disconnected" | `open-network` |
| `provider` | Connected → degraded | `warning` "Tunnel provider degraded" | `open-network` |
| `provider` | → connected (only with an unresolved incident) | `info` "Tunnel provider connected" | `open-network` |
| `endpoint` | Healthy → failed (from cached diagnostics only) | `warning` "Endpoint became unavailable" | `open-network` |
| `endpoint` | → healthy (only with an unresolved incident) | `info` "Endpoint available again" | `open-network` |
| `backup` | Failed status or failed verification | `warning` "Backup failed" (once per backup id, ever) | `open-instance` |

Journal rules:

- Severities are `info`, `warning`, `critical`; categories are `agent`,
  `service`, `provider`, `endpoint`, `backup`.
- Repeat changes within the dedupe window (default 10 minutes) are suppressed
  entirely. Recoveries and once-per-backup failures are window-exempt so a
  resolution is never lost to a just-sent warning.
- A recovery is only announced when there is an unresolved incident to resolve,
  so the journal never claims "back online" for a problem it never announced.
- Events are redacted (`redactString`) before storage or return; technical
  details are bounded to 300 characters.
- The journal keeps at most 200 events, dropping the oldest **resolved** events
  first so unresolved incidents survive a busy burst. List reads are newest
  first, `since`-cursor filtered, 1–100 per page (default 50).
- Persistence: `<configDirectory>/notifications.json`, written atomically
  (mode `0600`). A restart reloads the state map, so already-notified states
  are never re-notified.
- Endpoint observations come only from **cached** diagnostics; the journal
  never probes. An endpoint without a cached evaluation produces no
  observation.
- The collector accepts an optional backup source; the `backup` category is
  dormant until one is supplied. The default desktop collector wires nodes,
  instances, providers, endpoints, and cached diagnostics.
- Store failure behavior: a corrupt store or a store written by a newer build
  is preserved as `<file>.corrupt-<timestamp>` and the journal starts empty
  with `degraded` reported.

## Degraded-mode guarantees

| Failure | Guarantee |
| --- | --- |
| Agent offline / unreachable | Computer summaries keep the last known contact time (`lastContact`, `lastKnownAt`, `lastContactStale` past 120 s) and skip the instance-inventory read instead of recording degradation; the diagnostics `agent` stage reports failed/unknown; discovery fails with the expected `ENDPOINT_AGENT_UNAVAILABLE` envelope rather than an unexpected IPC error. |
| Provider unavailable | The provider snapshot degrades to canonical state `unknown` with `PROVIDER_SNAPSHOT_UNAVAILABLE`; provider sync changes nothing and records the failure; local and LAN endpoints are independent of provider state, so a provider outage cannot degrade them. |
| Telemetry store unavailable | The telemetry sampler degrades to in-memory sampling with `degraded` and `storeAvailable: false`; a newer-schema file is never overwritten. Telemetry is read-only observability — controls (endpoint CRUD, diagnostics, instance lifecycle) are unaffected. |
| Diagnostics timeout | The affected stage becomes `unknown` with sanitized evidence and Copy details remediation; the run still completes and the overall state reflects the missing evidence. |
| Endpoint store corrupt / migration failed | Endpoint and computer read models report `degraded: true` while continuing to serve whatever records loaded; the corrupt file is preserved for recovery. |
| Provider status unknown | The provider card and provider stage render `unknown` with the provider id and diagnostic messages; nothing is faked into "running". |
