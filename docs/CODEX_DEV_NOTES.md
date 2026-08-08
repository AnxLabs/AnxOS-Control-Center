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
