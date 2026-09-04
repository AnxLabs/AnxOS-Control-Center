# Release Notes — AnxOS Control Center v1.9 build 197

**Channel:** Private Alpha
**Date:** 2026-09-04

## Added

- Instance runtime reconciliation: a stale persisted `Running` state with no live,
  identity-matching process now reconciles to `Stopped` (startable, updatable) instead of
  a blocking `Unknown`. A genuinely live runtime (tracked child, adopted detached runtime,
  or live persisted PID) still blocks file updates and SteamCMD updates.
  Covered by the new `instances:runtime-reconciliation:smoke` (wired into the
  `qa:feature` and release validation tiers).
- Stale-PID recovery: a dead PID is authoritative proof the runtime is gone, so recovery
  lands on `Stopped` while `STALE_PID` survives as the last-operation evidence.

## Fixed

- A failed instance operation (e.g. a failed reload) no longer masquerades as the live
  runtime state. The state pill and detail state field show the reconciled instance
  state; the failure stays visible as a "Last operation: X failed" tooltip and in the
  failure-reason field. This resolves the lingering `RELOAD FAILED` presentation that
  kept Palworld showing a failure state after the underlying runtime had already exited.
- SteamCMD marketplace updates and server file updates now consult the reconciled
  runtime state, so a stale `Running` record no longer blocks updates with
  `STEAMCMD_UPDATE_REQUIRES_STOPPED` when nothing is actually running.

## Documentation

- `docs/V1_ACCEPTANCE_RECORD.md`: recorded the 2026-09-04 V1-A live drill (Terraria
  TShock + Better MC [FORGE] BMC4 started concurrently on the Anxlab Debian agent,
  independent live per-instance metrics, live console output, clean stop with
  confirmation dialogs and recoverable state).
- `docs/B0_BASELINE.md`: closed the "no live two-instance + connected-Agent acceptance"
  gap with the dated drill evidence.

## QA

- `qa:fast`, `qa:feature` (19 suites including the new runtime-reconciliation smoke),
  and the full `rc:validate` gate executed for this build.
- V1-A live two-instance drill executed on real hardware (see V1_ACCEPTANCE_RECORD.md).

## Known Issues

- Palworld Dedicated Server may still report `RELOAD FAILED` in the detail header while
  its persisted configuration is being reconciled; the state now correctly reflects the
  runtime (Stopped/Unknown) and the failure is surfaced as the last-operation evidence.
- FiveM live lifecycle flow remains unverified (see B0_BASELINE.md known gaps).
