# Codex Development Notes — Build 196 Hardening Pass

Running log of release-hardening fixes for Codex context. Entries are factual summaries only; see commit history for full diffs.

## Batch 1 — commit `63ec2e6` (pushed to `dev`)

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

## Batch 2 — pending commit

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
