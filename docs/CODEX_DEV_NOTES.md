# Project Development Notes

Living development history for Codex context. Entries are factual summaries only; see commit history for full diffs.

## Previous Development History

Work completed prior to the Build 196 hardening pass:

- CurseForge owner-managed proxy fix committed and pushed to `dev` (`3871b49`).
- SSH profile deletion, host-key approval, and session polling committed and pushed to `dev` (`fb1fd23c`).
- `privateKey=` redaction gap in `src/shared/redaction.js` fixed and covered by a new smoke test.
- AGENTS.md updated with the AnxOS Development Protocol (ADP) and pushed (`536bf98c`).

## Build 196 Hardening Pass

Running log of release-hardening fixes.

### Batch 1 — commit `63ec2e6` (pushed to `dev`)

- Fixed: `refreshDockerStatus()` (app.js) leaked `dockerRequestInFlight = true` forever when a Docker
  request went stale after a node switch, permanently blocking further Docker refreshes.
- Fixed: `startInstance()` (instanceServiceCore.js) had a window between its "already running" check
  and registering the process where two concurrent calls could spawn duplicate processes for one
  instance. Added a synchronous `startingInstances` guard; original body renamed to `startInstanceImpl`.
- Fixed: `deleteInstance()` didn't clear pending `restartTimers`/`versionRefreshTimers` for a deleted
  instance id, risking orphaned timer callbacks hitting a missing config.
- Fixed: Agent `logRequestError()` logged raw `error.details` (filesystem paths) unredacted; now
  reuses the existing `sanitizeErrorDetails()` helper, matching the HTTP response path.
- Regression note: `startInstanceImpl` rename is internal only; exported `startInstance` name and
  call sites (`scheduleAutomaticRestart`, `restartInstance`) are unchanged.

### Batch 2 — commit `a2cb940` (pushed to `dev`)

- Fixed: Desktop `fileService.js` logged completed download local/remote paths via raw
  `console.info`, bypassing the diagnostics redaction pipeline entirely (only `console.error` is
  intercepted in `main.js`). Replaced both call sites with `diagnostics.log(...)`, which sanitizes
  context before writing, consistent with other services in `src/services/`.
- Investigated but not changed (verified as non-issues): SSH shell stream close-listener timing
  (not reachable — listeners attach synchronously before any close event can fire), SSH IPC
  listener lifecycle across page navigation (intentional, keeps Console live across navigation),
  and the `openShareServerDialog` modal keydown handler (already removed correctly in its own
  `close()` before `deactivateModal()`).
- Future work: `src/shared/redaction.js`'s `PRIVATE_PATH` regex only matches
  `/home/`, `/Users/`, `/root/`, `C:\Users\` — non-standard filesystem roots (e.g. `/srv/`, `/opt/`)
  aren't redacted. Needs a dedicated pass with full regression coverage given its broad blast radius.

### Batch 3 — Marketplace manual-install session expiration

- Fixed: `pendingManualInstalls` (marketplaceInstallService.js) held manual-download session
  objects (created when CurseForge/Modrinth requires a manually-downloaded restricted file)
  indefinitely — nothing deleted an entry unless the user completed the flow via
  `resumeManualInstall()`. Abandoned sessions leaked in memory for the life of the process.
- Fix: added `MANUAL_INSTALL_SESSION_TTL_MS` (1 hour) and a lazy-expiration check, matching the
  existing `createdAt`/TTL convention used elsewhere (`accountAuthService.js`,
  `securityService.js`, `agentPairing.js`). `createPendingManualInstall()` prunes expired entries
  before adding a new one; `getPendingManualInstall()` deletes and throws
  `PROVIDER_MANUAL_SESSION_EXPIRED` if the session is past its TTL.
- Regression note: only affects sessions abandoned for over an hour; normal manual-download
  flows complete well within that window. No smoke test exercises the manual-install session
  lifecycle directly — validated by code inspection plus the broader `marketplace:smoke` and
  `curseforge:server-pack-resolution:smoke` suites, which passed unchanged.

### Batch 4 — Non-standard Linux private-path redaction

- Fixed: `src/shared/redaction.js` redacted private paths only under `/home/`, `/Users/`, `/root/`,
  and `C:\Users\`, allowing private paths rooted under common application locations such as `/srv/`
  and `/opt/` to reach diagnostics and structured logs unchanged.
- Fix: extended the existing `PRIVATE_PATH` Linux-root allowlist with only `srv` and `opt`, preserving
  its established path boundaries and terminators to avoid broad redaction of URLs or generic
  slash-delimited text.
- Added: a focused `redaction:smoke` suite covering all supported private roots plus negative cases
  for URLs, generic slash-delimited strings, command arguments, embedded path fragments, and
  unrelated text.

### Batch 5 — Targeted `/var` private-path redaction

- Fixed: private paths under `/var/lib/` and `/var/log/` could pass through shared diagnostics and
  structured logging unchanged. These locations occur in AnxOS workflows through Docker volume
  mountpoints and Playit log diagnostics.
- Fix: added only the explicit `var/lib` and `var/log` alternatives to `PRIVATE_PATH`; matching was
  not broadened to all of `/var/`, `/mnt/`, `/media/`, `/usr/`, or `/usr/local/`.
- Added: focused positive coverage for Docker data and Playit log paths, plus negative coverage for
  URLs, similar `/var` prefixes, `/var/cache/`, `/var/run/`, standard system paths, embedded path
  fragments, and the intentionally deferred `/mnt/` and `/media/` roots.
- Validation: `redaction:smoke`, JavaScript syntax checks, Diagnostics smoke and IPC authorization/error
  contracts, Security page and IPC error-contract smoke suites, and SSH redaction smoke all passed.
- Deferred risk: user-configured paths under `/mnt/` or `/media/` can still appear in diagnostics, but
  adding those roots to the generic matcher could redact URL/API paths. Quoted or whitespace-containing
  paths also remain only partially redacted and require a separately scoped, quote-aware hardening pass.

### Batch 6 — Balanced quoted private-path redaction

- Fixed: balanced single-quoted and double-quoted private Linux and `C:\Users\` paths containing
  whitespace were redacted only through the first space, leaving the remaining path suffix visible.
- Fix: defined the supported private-root alternatives once and reused them for dedicated balanced
  single-quote, balanced double-quote, and existing unquoted matchers. Quoted replacements run first,
  replace the complete path interior, preserve the original quote characters, and stop at the matching
  quote or newline. Existing unquoted behavior remains unchanged.
- Added: regression coverage for every supported Linux root, Windows paths with spaces, multiple paths,
  trailing punctuation/error details/prose, idempotence, existing unquoted behavior, deferred input
  shapes, and a bounded quote-heavy performance guard.
- Validation: `redaction:smoke`, JavaScript syntax checks, Diagnostics smoke and IPC authorization/error
  contracts, Security page and IPC error-contract smoke suites, SSH redaction smoke, and repeated
  sanitization checks all passed.
- Deferred: bare structured path values with whitespace, diagnostic-specific path-field sanitization,
  shell-escaped spaces, raw JSON-escaped paths, SSH paths split across chunks, `file://` URLs, and
  malformed or unmatched quote recovery remain outside this batch.

### Batch 7 — Opt-in diagnostic path-field redaction

- Fixed: structured diagnostic fields containing bare absolute private paths with whitespace were
  sanitized as free-form strings, leaving the suffix after the first space visible.
- Added: `sanitizeForDiagnostics(value, options)`, a named diagnostic-only wrapper over the existing
  recursive sanitizer. It uses the shared private-root source and an exact, case-sensitive allowlist:
  `localPath`, `remotePath`, `backupRoot`, `binaryPath`, `configPathUsed`, `logPathUsed`,
  `workingDirectory`, and `executablePath`.
- Behavior: allowlisted string values beginning with a supported absolute private root are replaced
  completely with `[redacted-path]`. Arrays reuse the existing bounded traversal; objects, Errors,
  Buffers, circular references, depth/item/string limits, and secret redaction retain existing semantics.
  Default `sanitize()` behavior is unchanged.
- Enabled boundaries: Agent HTTP technical error details, desktop IPC technical error contracts,
  remote Agent diagnostic export, structured logger writes and snapshots, desktop diagnostic runtime
  state/summary/export, Marketplace IPC and serialized install errors, and update diagnostic log details.
- Preserved operational defaults: Maintenance results, Marketplace disk/write checks, SSH session and
  renderer payloads, update pending-install state, and successful file/Docker/instance/backup payloads
  continue using default sanitization or their existing operational return paths.
- Validation: focused redaction, Diagnostics, IPC error/authorization, Marketplace IPC error, update
  download/authorization, SSH redaction/error/authorization, Maintenance, files pipeline/error-contract,
  and Security page/error-contract smoke suites passed, along with JavaScript syntax and performance
  guards. Tests cover exact fields and exclusions, every supported root, nested arrays/objects, deep
  structures, non-mutation, idempotence, default isolation, logger/snapshot persistence, and operational
  boundary preservation.
- Deferred: generic `path`/`filePath`, `resolvedInstallDirectory`, Docker `mountpoint`, Maintenance
  `pathLabel`, file-browser `filesystemRoot`, long-operation persistence, raw JSON path strings,
  shell-escaped spaces, SSH chunk buffering, `/mnt` and `/media`, `file://` URLs, normalized/fuzzy field
  matching, and nested schemas for generic path keys remain outside this batch.
## 2026-08-20 — Resource-owned operation lifecycle

- Root cause: instance and Marketplace download renderers rebuilt their whole
  lists on every snapshot; download refresh errors explicitly rendered an
  empty list; instance actions had only a page-wide busy boolean and no state
  keyed to the affected resource. The Agent also intentionally omits
  `installationState: installing` entries from list results.
- Added `src/shared/resourceOperationLifecycle.js` to reconcile authoritative
  resources separately from transient operations and reject stale/duplicate
  lifecycle updates.
- Instance rows and download entries now retain keyed DOM owners. Reload uses
  the existing restart backend action but immediately displays `Reloading…`,
  rotates its icon, disables conflicts, shows a brief success state, and keeps
  failure attached to the instance.
- Download Manager retains the last snapshot on polling failure and displays
  real percentage, received/total bytes, speed, and ETA when provided. No
  progress is simulated.
- Focused coverage: `npm run operations:renderer-lifecycle:smoke`.
- Known baseline constraints: `npm run ui:polish:smoke` still fails on the two
  pre-existing SSH `window.confirm` calls. `npm run packaging:smoke` requires a
  current packaged artifact and failed against the stale/missing
  `dist/win-unpacked/resources/app.asar` content; no artifact was rebuilt.

## 2026-08-20 — Instance-owned metrics lifecycle

- Root cause: `refreshSelectedInstanceMetrics()` was the only Instances-page
  metrics request path, and its result lived in one `latestInstanceMetrics`
  slot. Initial list selection requested one server at most; clicking another
  server changed that singleton owner and was what activated its telemetry.
- Added `src/shared/instanceMetricsLifecycle.js`, a node-scoped telemetry map
  keyed by stable `instance.id`. It distinguishes loading, ready, refreshing,
  stale, and unavailable state while retaining the last valid sample.
- The existing five-second Instances refresh now discovers all running
  instances and schedules their existing per-instance IPC requests with
  concurrency capped at three and per-ID in-flight deduplication. Console and
  selected details read the same store and never create another poller.
- Node request contexts, per-request IDs, sample timestamps, conditional
  in-flight cleanup, and eligibility pruning protect against stale responses,
  node switching, stopped instances, and overlapping refresh triggers.
- Focused coverage: `npm run instances:metrics-lifecycle:smoke`.

## 2026-08-27 — FiveM configuration, exit-observed lifecycle, health summary

- Added a FiveM adapter to `src/shared/gameServerConfigManager.js` using real
  FXServer semantics: `sv_hostname`, `sv_maxclients`, `endpoint_add_tcp` /
  `endpoint_add_udp`, repeated `ensure` resource commands, and a sensitive
  `sv_licenseKey` field. Existing license keys are never returned to the
  renderer (`[REDACTED]` plus `hasCurrentValue`); untouched secrets keep their
  saved value on write.
- `instanceServiceCore.js` resolves the FiveM config at `server/server.cfg`
  (matching the marketplace template's `data/server` working directory and its
  `run.sh +exec server.cfg` startup), guards resolution with
  `assertNoInstanceDataEscape`, and infers the `fivem` adapter for FiveM
  instances. Writes create a backup and report `restartRequired: true`.
- Instance wrapper-exit handling now records exit observation on the running
  entry (exit code, signal, failure reason) before teardown and deletes the
  running-process entry only after the runtime state update lands, so a dead
  process cannot keep reporting Running, an adoptable detached runtime is
  preferred over a stopped transition, and readiness is tracked on the entry
  when the process reports ready.
- Added `src/shared/instanceHealthSummary.js`, a shared classifier mapping
  persisted states plus health/readiness onto truthful buckets (running,
  stopped, starting, stopping, unavailable, unhealthy, failed, unknown,
  setupRequired). A live process with degraded health surfaces as unhealthy,
  not Running. The Instances renderer shows per-bucket counts and a
  needs-attention strip through the shared summarizer.
- De-flaked `instance-health-state-smoke.js` with `waitForStatus` polling and
  extended `game-server-config-smoke.js` (run directly: `node
  scripts/game-server-config-smoke.js`) with a FiveM fixture: discovery,
  masked read, safe edit, backup-on-save, comment/untouched-secret
  preservation, and traversal rejection.
- Focused coverage: `npm run instances:health-summary:smoke`,
  `node scripts/game-server-config-smoke.js`,
  `npm run instances:health-state:smoke` equivalent (`node
  scripts/instance-health-state-smoke.js`), plus the lifecycle, stale-PID,
  shutdown, file-security, and SteamCMD suites.
- The Instances page now refreshes itself on a 5-second interval while visible
  (`startInstancesPagePolling`), so status and metrics stay current without
  navigation. The timer honors hidden-tab and in-flight-action guards, stops
  when leaving the page, and is cleared by renderer resource cleanup.
- Replaced the two native `window.confirm` calls in SSH flows (profile delete,
  unknown host-key approval) with the shared modal confirmation system
  (`confirmDestructiveAction` / `createSecurityConfirmation`), restoring the
  no-native-dialogs policy. Host-key approval deliberately does not use the
  destructive-action settings bypass.
- `ui-polish-smoke.js` now normalizes CRLF to LF when loading source files, so
  its exact string assertions pass on Windows checkouts instead of failing on
  whitespace only.
