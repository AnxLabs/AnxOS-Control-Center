# Recovery Model

## Operations

Active persisted operations become `interrupted` after restart, releasing
locks. Retry and cancellation are disabled until an owning service creates a
new executable attempt. Timeout-bounded locks prevent indefinite in-process
ownership.

## Agent connectivity

Authentication rejection, offline/unreachable, timeout, TLS failure, and
version incompatibility remain distinct states. Recovery actions use pairing,
credential repair/rotation, URL correction, service repair, or compatible
Agent update as appropriate.

Renderer recovery categories remain distinct for invalid Agent URL, TLS or
certificate failure, authentication rejection, unreachable/timeout, version
incompatibility, and duplicate registration. Each category exposes only safe
corrective actions; credential values and raw stacks are never recovery data.
Node registration preserves the original Agent status and stable failure code
when identity probing fails, instead of collapsing authentication, transport,
TLS, and timeout failures into a generic identity error.
Pairing completion is bounded to 15 seconds and aborts the underlying request.
Because a lost rotation response is ambiguous, timeout and transport failures
are not blindly retryable; recovery requires a fresh one-time pairing code.

Marketplace provider downloads are streamed into bounded memory with early
`Content-Length` rejection and mid-stream cancellation. ZIP extraction rejects
absolute/traversal paths, excessive entry counts or expanded sizes, and unsafe
compression ratios before reading entry bodies.

Provider-created instances persist with `installationState: "installing"` and
are excluded from normal instance listings and startup until server artifacts,
configuration, and metadata have been verified. The final Agent update changes
the state to `active`; that activation is the success boundary. Failure changes
the state to `failed`, retains the stage and specific error, and leaves the
record inspectable and explicitly removable without exposing credentials.

On process startup, both the standalone Agent (before opening its HTTP listener)
and the desktop local-instance runtime (before registering IPC handlers) call
`recoverIncompleteInstallations()`. The shared routine stops a still-live PID
owned by an `installing` record, retains it as a failed interrupted install,
reports per-instance failures, and is idempotent. It never removes active
instances or instance data.

Instance status keeps the existing `state`/`lifecycleState` contract and adds
orthogonal `processState`, `readinessState`, and `healthState` fields. A live
process starts as `Starting/starting/unknown`; recognized server-ready output
changes it to `Running/ready/healthy`. A process still alive at the configured
startup deadline becomes `Running/timeout/degraded`, not falsely healthy.
Failures remain `Crashed`, bounded immediate restart failures become
`Crash Loop`, and intentional stops return to `Stopped/stopped/unknown`.
When a persisted active lifecycle record has no live or discoverable PID,
reconciliation clears the stale PID and reports `Unknown` with
`failureReason: "STALE_PID"`; it does not misreport an unobserved exit as an
intentional stop. A persisted `Stopping` record still repairs to `Stopped`.

Backup imports and restores validate gzip integrity, tar header checksums,
entry types and canonical paths before mutation. The current in-process tar
implementation intentionally caps compressed archives at 512 MiB, expanded
content at 512 MiB, individual entries at 256 MiB, and entry count at 100,000;
archives above those implemented limits fail with
`BACKUP_ARCHIVE_LIMIT_EXCEEDED` rather than risking process exhaustion.
Backup archives are written to process-specific temporary files and renamed
only after the archive is complete and validated. Agent startup removes stale
temporary files and archives that have no committed metadata before scheduled
backup work begins or the HTTP listener opens. Recovery is idempotent and
preserves archives that have a matching metadata record.

## Instances

Runtime PID reconciliation detects live configured and detached processes.
Intentional stops do not auto-restart. Automatic restarts are bounded with
exponential backoff; exhaustion persists `CRASH_LOOP`. Manual lifecycle actions
cancel pending restart timers. Desktop and Agent shutdown use the shared
instance shutdown path: restart timers are cancelled, owned processes receive
an intentional graceful stop concurrently, waiting is capped at five seconds,
and a process still owned after a failed stop is force-terminated.

## Backup restore

Restore validates the archive, requires overwrite confirmation, verifies the
instance is stopped, checks free space on the snapshot and restore volumes, and
creates a full safety snapshot before mutation. Backup creation also checks the
destination volume before writing an archive. A partial restore failure restores
the safety snapshot. Rollback failure is reported separately as
`RESTORE_ROLLBACK_FAILED` and retains both cause codes.

## Shutdown

Desktop shutdown rejects new IPC requests, stops the updater, disposes Files
and SSH services, and waits for owned local instances before allowing Electron
to quit. Agent shutdown first closes its HTTP listener, stops backup scheduling,
ends existing sockets, waits for owned instances, and retains a ten-second
process-level failsafe. Both paths persist intentional stopped state and clear
owned PIDs during the normal shutdown flow.

Desktop file edits, imports, Agent downloads, and SFTP transfers write to a
unique sibling temporary path. The final destination is renamed only after the
write or stream completes; failure and cancellation remove the temporary
artifact. SFTP uploads follow the same temporary-upload and remote-rename
contract.

Desktop backup imports stat the selected regular file against the shared Agent
archive limit before reading it into memory. Backup exports write a sibling
temporary file and rename it into the user-selected destination only after the
buffer has been written successfully.

## Scheduled restarts

A scheduled restart only runs when its instance is already running. A stopped
instance is skipped and never started; the schedule records `INSTANCE_NOT_RUNNING`
and advances to its next run. The restart is carried out through the canonical
durable instance lifecycle restart path, never a raw process kill. Warnings are a
best-effort courtesy channel: a failed stdin write never blocks the restart, and
if the agent was offline across the warning thresholds the unsent warnings are
delivered in order at the due time. A corrupt schedule store is quarantined once
and evaluation continues with the remaining schedules. A schedule is not yet
serialized against an in-flight durable job on the target instance.

## Linux Agent self-update

The Linux Agent runtime update is staged next to the live runtime and published
by a short-lived `systemd-run --user` transient unit after the Agent exits,
because a running Agent cannot reliably replace its own runtime. The managed
systemd user unit is required; without it the update is refused
(`LINUX_AGENT_UNIT_NOT_INSTALLED`). The ordered swap stops the unit, moves the
current runtime to `<runtimeRoot>.backup-<stamp>`, atomically renames the staged
runtime into place, and starts the unit again. The unit writes a result marker
(`<updateDir>/swap-<stamp>.result`) that is observable across a mid-swap crash:
`complete`, `failed-missing-staged`, `failed-backup`, `failed-publish`,
`failed-rolled-back`, `failed-rollback-failed`, or `failed-restart`. A failure
after the backup rename restores the backup before restarting, and
`failed-rollback-failed` means neither runtime is in place and the backup at the
reported path is the recovery source. After a failed update the desktop rolls
back its configuration backup and best-effort restarts the Agent on the previous
runtime, reporting `restartAttempted` and `agentRestarted` (with
`restartErrorCode` when the restart also failed). A swap-timeout leaves the
transient unit possibly mid-swap, so the update record, the result marker, and
`journalctl --user -u anxos-agent-update` must be inspected before retrying. The
full path has not yet been exercised live; see `docs/KNOWN_LIMITATIONS.md`.

## Workload transfer

Workload transfer between nodes is preview-first. The preview phase runs only to
the target's read-only restore preview and then stops for confirmation; if the
operator does not confirm, the imported archive is removed. A failed transfer
cleans up the target-side imported archive whenever the confirmed restore did not
consume it, and deletes a placeholder it created (a pre-existing target instance
is not deleted by the failure path). Per-step records are retained on both
success and failure, so the failing step is always identifiable. The source
node's workload and backup are not modified by a failed or declined transfer.

Formerly a known exception, now fixed (P0, found by the cycle-10 adversarial
audit and independently by the documentation review): the declined-preview path
used to invoke the placeholder cleanup without checking whether a placeholder
had been created, so a declined preview against a node that already had an
instance under the target id deleted that pre-existing instance. The decline
branch is now gated on the created placeholder the same way the failure path is
(`src/services/workloadTransferService.js` — `context.placeholderCreated ===
true && !context.importedBackupConsumed`), and the survival of a pre-existing
target instance across a declined preview is pinned by a regression leg in
`scripts/workload-transfer-smoke.js`. A declined preview no longer deletes
anything it did not create.

## Desktop updates

The updater prefers the HTTPS release manifest because it carries the artifact
platform, architecture, byte size, and SHA-256 digest. Assets for another
operating system or CPU architecture are not eligible. Legacy release metadata
without a digest can still announce an available release, but direct in-app
download fails with `UPDATE_CHECKSUM_REQUIRED`; the release page remains the
manual fallback.

Downloads use a unique sibling `.part` file. The final Downloads entry is
created atomically only after the received byte count and SHA-256 digest match,
and an existing user file is never overwritten. Shutdown aborts the active HTTP
request and file stream and removes the partial artifact. Size and digest are
checked again immediately before opening the installer, and a failed
`shell.openPath()` handoff is reported as a failure.

The desktop does not claim installer rollback. Once the verified artifact is
handed to the operating-system installer, mutation and rollback are owned by
that installer. User configuration, instances, and backups are stored outside
the packaged application files, but automatic previous-version restoration is
not implemented or exposed as a supported update capability.

Before installer handoff, the updater persists the previous and target public
version/build, artifact name, expected SHA-256, and handoff status in the
schema-versioned update store. The next successful application launch confirms
the target version. If the previous version launches again, the state becomes
`handoff-unconfirmed` with reinstall/previous-version guidance. The old process
cannot prove why a new executable never launched, so crash-before-launch and
automatic OS-level rollback remain technically not guaranteed.
