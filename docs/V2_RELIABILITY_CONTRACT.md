# Build 200 V2 Reliability Contract

Build 200 is the V2 reliability baseline. It stabilizes the existing product;
it does not begin the wider V2 architecture or feature vision. Build 199 at
tag `v1.9-build199` and commit `0d16d92` remains the immutable final V1 release.

## Lifecycle contract

- Instance operations use explicit persisted lifecycle states and finish in a
  truthful terminal or recoverable state.
- Duplicate starts are rejected and repeated stops converge on `Stopped`.
- A stop timeout returns `INSTANCE_STOP_FAILED`, retains timeout details, and
  records `Running` when the target process is still proven alive. It never
  remains indefinitely in `Stopping`.
- Restart reconciliation validates persisted process identity before adopting a
  PID. Dead or mismatched PIDs cannot masquerade as a healthy runtime.
- Executable validation remains unchanged. Shutdown may stop a process already
  owned by an instance record; it does not broaden the executable allowlist.

## Build 199 migration contract

- Build 199 instance schema 1 upgrades to schema 2 on first read through an
  atomic replacement.
- The original record is preserved once as `config.json.schema-v1.backup`.
- Unknown fields and instance data are preserved. Re-reading an upgraded record
  is safe and does not replace the original backup.
- Missing schema metadata follows the existing schema-0 backup path.
- Future schemas fail with `INSTANCE_CONFIG_SCHEMA_UNSUPPORTED` and malformed
  JSON fails with `INSTANCE_CONFIG_UNREADABLE`; neither input is rewritten.

## Installation failure contract

- `installing` remains hidden and non-startable until verification succeeds.
- Activation to `active` is the success boundary.
- Interrupted or failed installs become `failed`, retain a specific error and
  stage, remain non-startable, and are visible for inspection and explicit
  removal or a supported retry.
- Startup recovery is idempotent and never silently deletes an interrupted
  installation.

## Explicit boundary

Build 200 adds no service decomposition, runtime replacement, release-system or
website redesign, new integration or server type, remote orchestration,
clustering, scheduling, cloud sync, account/billing/analytics/telemetry work,
plugin expansion, visual redesign, speculative optimization, or Build 201
feature.
