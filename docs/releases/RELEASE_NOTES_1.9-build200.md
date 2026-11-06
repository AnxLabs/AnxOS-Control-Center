# Release Notes — AnxOS Control Center v1.9 build 200

**Channel:** Private Alpha
**Status:** Unreleased V2 reliability baseline

Build 200 establishes the V2 Reliability Contract without beginning the wider
V2 architecture or feature vision. Build 199 remains the immutable final V1
release.

## Added

- A focused Build 199 instance-record fixture and deterministic schema 1 to
  schema 2 migration contract.
- Durable failed-install state for interrupted provider installations.
- Regression coverage for repeated lifecycle cycles, duplicate stops,
  already-stopped behavior, and stop timeouts.

## Fixed

- Interrupted installs are retained with actionable failure evidence instead
  of being silently deleted during startup recovery.
- Stop timeouts no longer leave instance metadata indefinitely in `Stopping`;
  a process proven alive remains truthfully `Running` with
  `INSTANCE_STOP_FAILED` details.
- The shutdown regression uses an already-authorized absolute executable path,
  proving the stop path without broadening executable restrictions.
- Website and updater download routing now recognize only the canonical
  `AnxLabs/AnxOS-Control-Center-Releases` repository and reject source,
  unrelated, malformed, and legacy-owner URLs.

## QA

- Focused migration, lifecycle, installation recovery, Marketplace retention,
  IPC error-contract, and authorization smokes cover the Build 200 changes.
- Full source validation must pass before Build 200 is eligible for commit or
  release-candidate work.
