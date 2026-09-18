# Operator Notes — V2 Surfaces

This reference covers operator-visible behavior added by the V2 engineering
campaign that is not yet described in the beginner guide or the troubleshooting
pages. It is written against the code on the `dev` line and the campaign records
in `docs/v2/`; where a statement depends on a validation that has not been run
yet, that is stated explicitly instead of implied.

Authoritative sources, in order: the code, then the later cycle entries in
`docs/v2/V2_CAMPAIGN_LOG.md`. Endpoint and channel names, with permission
tiers, live in `docs/API_SURFACE_V2.md`.

Some of these surfaces are reachable from the UI, and some are currently
API/IPC-only. Where there is no renderer control yet, this document says so; do
not assume a UI exists because the backend capability does.

## 1. Docker policy grants

Docker create requests are evaluated by a deny-by-default policy gate
(`src/shared/dockerPolicy.js`) before any Docker command runs. The following
options are denied unless the request carries an explicit per-flag
`policyGrant`:

- `privileged` mode
- host networking (`network: host`)
- host path mounts (bind mounts to an absolute POSIX path, a Windows drive
  path, or a UNC share)
- engine socket mounts (any volume or mount whose source path looks like
  `docker.sock`)

A denial is enforced at the engine boundary and returns `DOCKER_POLICY_DENIED`
(HTTP 403). The renderer confirmation dialog is presentation only: it is what
attaches the grant, but the main-process/agent gate is the actual boundary, and
a request that reaches the agent without a grant is refused regardless of what
the UI showed.

Compose projects are reviewed against the actual compose file before
`compose up`/recreate: inline YAML and whitelisted compose basenames inside the
validated project directory are parsed and checked for the same dangerous
options. Unparsable YAML fails closed (`COMPOSE_POLICY_UNPARSEABLE`), and a
document larger than 256 KiB fails closed without being parsed.

Resource limits are validated before the engine call: a malformed memory or CPU
limit returns `INVALID_MEMORY_LIMIT` or `INVALID_CPU_LIMIT` (HTTP 400).

`POST /api/v1/docker/preflight/container` reports policy denials and
resource-limit problems as hard findings and host-port conflicts as best-effort
findings (with an `engineAvailable` flag). The operator create flow calls this
preflight first, surfaces blockers and stops, and shows warnings before the
create attempt.

## 2. Volume removal confirmation

Docker cleanup that removes persistent data requires an explicit confirmation
flag. `runCleanup` refuses the `volumes` kind unless the request carries
`confirmVolumeDataRemoval: true`, returning
`VOLUME_REMOVAL_CONFIRMATION_REQUIRED` (HTTP 400). The renderer passes the flag
only after the volume-risk dialog is accepted. The classification lives in
`dockerPolicy.cleanupAffectsPersistentData` and is kept in lockstep with the
cleanup preview, so the preview and the enforcement gate cannot disagree.

## 3. Node groups, disconnect, and revocation

**Groups.** `group` on a node is an organizational label only this wave (no
policy attached). It is trimmed and bounded to 40 characters; longer labels are
rejected with `INVALID_NODE_GROUP`. The nodes toolbar filters by group. An
ungrouped node is shown under a sentinel label rather than being merged with any
real group.

**Disconnect.** Disconnecting a node (desktop `nodes:disconnect`) sets a
persistent manual-disconnect flag. While it is set, health checks do not
resurrect the node to "online" from any surface, and the connection reports the
manual state (`NODE_MANUALLY_DISCONNECTED`). Reconnect (`nodes:reconnect`)
clears the flag and immediately re-checks health. An in-flight health probe from
before the disconnect cannot overwrite the state afterwards. Both actions
require an unlocked local owner and `settings:write`; the application host node
cannot be disconnected.

**Revocation.** Deleting an Agent node from the desktop runs a best-effort
desktop-driven enrollment revocation *before* the local record is removed. The
desktop presents the node's own shared Agent token to
`POST /api/v1/enroll/revoke`. The Agent gates revoke behind the **owner**
permission, so:

- A node whose stored credential is restricted (not owner-tier) may be refused
  with HTTP 403.
- An unreachable Agent times out.

Both outcomes are reported honestly as `revocation.revoked: false` with the
failure code, and the local node record is still removed. This is expected
behavior, not a bug: the UI must never present a refused or timed-out revocation
as a successful one. Revocation is not attempted at all when node credentials
are locked; that is also reported. A successfully revoked enrollment refuses
subsequent authentication with `REVOKED` (HTTP 410) and requires re-enrollment.

## 4. Backup consistency, retention, and archive integrity

**Consistency option.** A backup create request may carry
`consistency: "stopped"`; anything else (including the default) is
crash-consistent and byte-identical to the historical behavior:

- `crash` (default): files are archived while the instance keeps running.
- `stopped`: the instance is quiesced through the same canonical stop path the
  restore flow uses, archived, then restarted.

Honesty rules, enforced in code:

- An already-stopped instance is never stopped or started again; the archive is
  recorded as crash-consistent.
- An instance already `Stopping` (an operator stop in flight) downgrades the
  archive to crash-consistent rather than claiming stopped-consistency or undoing
  the operator's stop.
- A restart failure after a stopped-consistency backup is reported in the result
  and in the backup metadata (`restartAfterBackupError`), never swallowed.
- An external start during the archive window yields
  `RESTART_SKIPPED_ALREADY_RUNNING` and downgrades the disclosure to crash.

Backup metadata carries `consistency`, `instanceWasRunning`, and
`restartedAfterBackup` additively. `listBackups` reports legacy metadata that
predates the option as `crash` (that was the only historical behavior) and
imported backups as `unknown` (their true provenance is not known).

**Retention newest-protection.** The retention policy (defaults `keepLast: 10`,
`maxAgeDays: 30`, overridable per schedule or by `AGENT_BACKUP_KEEP_LAST` /
`AGENT_BACKUP_MAX_AGE_DAYS`) is applied per instance. Pruning never deletes the
**newest** recovery point of an instance even when the age or count policy says
it should go; it is reported in `skipped` with `protectedAs: "newest"`.
`listBackups` exposes `protectedNewest`, `retentionPolicy`, `retentionPolicyMet`,
and `retentionPolicyReason` so the reported health matches what a prune with the
same policy would actually delete.

**Archive integrity refusals.** Import and restore validate the archive before
any mutation and refuse with a stable code on: `BACKUP_ARCHIVE_LIMIT_EXCEEDED`
(413), `BACKUP_ARCHIVE_INVALID`, `BACKUP_ARCHIVE_COMPRESSION_UNSAFE`,
`BACKUP_ARCHIVE_CHECKSUM_INVALID`, `BACKUP_ARCHIVE_UNSUPPORTED_ENTRY`,
`BACKUP_ARCHIVE_EMPTY`, `BACKUP_ARCHIVE_PATH_UNSAFE`, and
`BACKUP_ARCHIVE_HASH_MISMATCH` (all 400). Implemented ceilings are 512 MiB
compressed, 512 MiB expanded, 256 MiB per entry, and 100,000 entries; archives
above a ceiling fail rather than risking process exhaustion.

## 5. Scheduled restarts

Per-instance restart schedules are persisted agent-side and evaluated on a
60-second tick. A schedule is either `interval` (1 to 720 hours) or `daily`
(`HH:MM` in the agent host's local time, re-anchored to the wall clock across
DST transitions). `warnMinutes` defaults to 5 (minimum 1, maximum 1440).

Behavior operators should expect:

- Warnings are staged into the running server's stdin: a long warning at
  `T - warnMinutes` (only when the warning window is more than 1 minute) and a
  short warning at about `T - 1 minute`. Warnings are best-effort: a failed
  stdin write never blocks the restart.
- If the agent was offline across both thresholds, any unsent warnings are
  delivered in order at the due time before the restart.
- A stopped instance is **skipped, never started**: the schedule records
  `skipReason: INSTANCE_NOT_RUNNING` and advances to its next run.
- The restart goes through the canonical durable instance lifecycle restart
  path; it never issues a raw process kill.
- Re-enabling or retiming a schedule re-anchors its next run from now, so an
  edit never fires instantly from a stale due time.
- A schedule belongs to exactly one instance. Mutations reached through an
  instance-scoped path verify the schedule's own instance; a wrong instance path
  reports `RESTART_SCHEDULE_NOT_FOUND` rather than confirming or changing
  another instance's schedule.
- Ticks are idempotent: an overlapping tick shares a single evaluation, and a
  due restart fires once.
- A corrupt schedule store is quarantined once (`RESTART_SCHEDULE_STORE_CORRUPT`,
  HTTP 500) and a store written by a newer schema is refused
  (`RESTART_SCHEDULE_SCHEMA_UNSUPPORTED`, HTTP 409). Neither grows the store
  directory without bound.

**Not yet implemented.** A scheduled restart does not currently check for an
in-flight durable job on the target instance before restarting; that reliability
item (queue Y2) is recorded but not landed. Treat concurrent scheduled restart
and long-running job activity on the same instance as untested.

## 6. Runtime pins

When an install or dependency check resolves a runtime version for a workload
(for example bundled Java for an instance), the resolution is recorded as a pin.
Before an install or version-affecting update on the node, the dependency
service consults the pins and refuses an action that would change a shared
runtime under another workload's pin, with code
`RUNTIME_PINNED_BY_OTHER_WORKLOAD`. This is why an install or update can be
refused even though the dependency itself looks healthy.

**How to unpin.** There is no renderer control and no desktop IPC channel for
runtime pins yet; unpinning is an Agent REST call:

- `GET /api/v1/dependencies/runtime-pins` (optionally filtered by
  `dependencyId` / `instanceId`) lists pins. Tier: `dependencies:read`.
- `DELETE /api/v1/dependencies/runtime-pins` with `{ dependencyId, instanceId }`
  removes one workload's pin, or with `{ dependencyId, all: true }` resets every
  workload's pin for that dependency. Omitting both an `instanceId` and
  `all: true` is refused (`RUNTIME_PIN_TARGET_REQUIRED`). Tier:
  `dependencies:write`.

Deleting an instance clears that workload's pins best-effort, so a deleted
workload cannot block future runtime updates forever. A corrupt pin store is
quarantined once (`RUNTIME_PIN_STORE_CORRUPT`); read-side pin recording degrades
to a reported field while the install chokepoint still fails closed.

**Soft bypass — not a security boundary.** The pin identity is supplied by the
client. A caller holding `dependencies:write` can claim another workload's
instance id and thereby bypass the cross-workload guard. The pin mechanism is an
operator guard against accidental shared-runtime changes, not an authorization
control; do not rely on it to prevent a determined credentialed caller.

## 7. Network inventory

`GET /api/v1/network/inventory` (Agent tier `system:read`) returns a read-only
inventory of the Agent host: network interfaces, listening sockets, cross-port
conflicts, and an optional single-port bound check
(`?checkPort=<port>&protocol=tcp|udp`). Nothing in this surface provisions,
writes, or opens sockets; it is discovery only.

- Listeners come from the platform's own tools: `netstat -ano` plus `tasklist`
  on Windows; `ss` with a `netstat` fallback on Linux. Rows are parsed
  defensively and capped at 1000, with parse-failure telemetry surfaced instead
  of a silently empty inventory.
- A conflict is the same `(protocol, port)` bound on more than one distinct
  local address. The normal dual-stack wildcard pair (`0.0.0.0` + `[::]`) is
  treated as one listener, not a conflict.
- Platform support: Windows and Linux. Other platforms report
  `supported: false` with an explanatory error entry.
- There is no renderer UI consumption yet; this is an Agent API/desktop-channel
  capability only. Treat viewing it as an API operation.

## 8. Linux Agent self-update

The Linux Agent cannot reliably replace its own runtime while running, so the
update is staged next to the live runtime and a short-lived
`systemd-run --user` transient unit performs the swap after the agent exits.
The **managed systemd user unit** (`anxos-agent.service`) is required: if
background startup is not installed, the update is refused with
`LINUX_AGENT_UNIT_NOT_INSTALLED`. Unitless Linux runtimes keep the generic flow
and do not swap in place.

Ordered steps, surfaced as progress records: verify → stage → schedule-swap →
swap → restart → record. The swap unit stops the unit, moves the current runtime
to the backup path, atomically renames the staged runtime into place, and starts
the unit again.

Where artifacts live (paths relative to the desktop Agent data directory,
`<userData>/agent`):

- **Backup of the previous runtime:** `<runtimeRoot>.backup-<stamp>`.
- **Transient swap script:** `<updateDir>/swap-<stamp>.sh` (`updateDir` is
  `<userData>/agent/updates`).
- **Result marker written by the swap script:** `<updateDir>/swap-<stamp>.result`.
  Values: `complete`, `failed-missing-staged`, `failed-backup`,
  `failed-publish`, `failed-rolled-back`, `failed-rollback-failed`,
  `failed-restart`.
- **Update record:** `<updateDir>/last-linux-update.json`, written for both
  success and failure.

What to do on failure:

- `failed-rolled-back` means the publish failed and the previous runtime was
  restored; the agent comes back on the old runtime.
- `failed-rollback-failed` means the publish failed **and** the backup restore
  failed — neither runtime is in place. Recover the backup from the reported
  `backupRoot`.
- If the update fails after the stop, the desktop rolls back the config from its
  own backup and best-effort restarts the agent on the previous runtime; the
  result reports `restartAttempted` and `agentRestarted` honestly, including a
  `restartErrorCode` when the restart also failed.
- On a schedule-timeout (`LINUX_AGENT_SWAP_TIMEOUT`) the transient unit may
  still be mid-swap; inspect `journalctl --user -u anxos-agent-update` and the
  update record before retrying.

**Validation status.** The Linux self-update path is covered by a hermetic smoke
(`agent:self-update:smoke`) that pins the ordering and rollback semantics with
injected seams. It has **not** yet been exercised live on a real Linux host with
a genuine version-delta swap; that live drill is queued and is the validation
that must not be skipped before claiming live support. Windows is unaffected:
Windows updates remain desktop-driven through the task lifecycle and never swap
in place.

Agent health reports an `agentUpdate` capability: on Windows
`{ supported: true, mechanism: "windows-scheduled-task" }`; on Linux
`{ supported: true, mechanism: "linux-systemd" }` only when systemd is present,
otherwise `{ supported: false, mechanism: null }`; other platforms report
unsupported.

## 9. Workload transfer between nodes

Workload transfer moves a workload from one Agent node to another using the
existing backup/import/restore primitives; it adds no new Agent endpoints. It is
desktop-side orchestration (IPC), with **no renderer UI yet**.

- **Preview first.** The preview channel runs the pipeline up to the target
  restore preview — source backup, archive pull, target import, target
  placeholder registration — and stops before any destructive step. It returns
  `requiresConfirmation: true` plus the restore verdict and warnings, then
  cleans up the imported archive and any placeholder it created. Re-run with the
  returned `backupId` and `confirmOverwrite: true` to complete the transfer.
- **Both ends must be Agent nodes.** The application host cannot participate,
  and source and target must differ and be enabled.
- **Only full-scope backups transfer.** A world-scope source backup is refused
  (`TRANSFER_SCOPE_UNSUPPORTED`), because the instance record a fresh target
  needs to register the workload only travels in a full archive.
- **Size ceiling.** The effective limit is the target Agent's HTTP body cap
  (default 256 MiB), not the 512 MiB archive limit, because the archive is sent
  base64-encoded in the JSON body (4/3 inflation). The transfer refuses before
  downloading when the raw archive exceeds `floor(256 MiB * 3/4)` = 192 MiB
  (`TRANSFER_SIZE_EXCEEDS_IMPORT_LIMIT` / `BACKUP_ARCHIVE_LIMIT_EXCEEDED`, HTTP
  413). An Agent configured with a different body cap still enforces its own cap.
- **Placeholder handling.** A fresh target has no matching instance, so the
  transfer registers a placeholder through the canonical create path; a
  full-scope restore replaces it, and on a *failed* transfer a placeholder the
  transfer created is deleted (a pre-existing target is never deleted by the
  failure path).
- **Caveat, verified in the current code.** The declined-preview path
  (`confirmOverwrite` not set) calls the placeholder cleanup **without** checking
  whether the transfer actually created the placeholder, unlike the failure path
  which gates on that flag. A preview against a node that already has an
  instance with the target id can therefore delete that existing instance when
  the operator declines. Until this is fixed, do not run a transfer preview
  whose target instance already exists. This is recorded here as a
  documentation-verified discrepancy against the source comment, not as an
  accepted behavior.
- The source keeps its workload and its backup untouched throughout; the
  destructive phase runs only on the target.

The preview and confirmed channels are both authorized at the write tier (local
owner plus `settings:write`), and every recorded transfer step is audited with
its own outcome.

## 10. Offline job expiry

Job expiry is opt-in. A job may be minted with an `expiresAt`, or the node may
be configured with a default pending-job TTL; with neither, nothing expires and
behavior is unchanged.

- Only pending (enqueued, never-started) **non-destructive** jobs lapse.
  Destructive approvals never lapse by default — they must be explicitly
  cancelled or carry an explicit `expiresAt`.
- A lapsed job settles `FAILED` with code `JOB_EXPIRED` and `expired: true`;
  the old record stays on disk for audit. A keyed request that looks the job up
  by its idempotency key observes the settled result rather than replaying it.
- A running job never expires mid-run; it reconciles exactly as before.

## 11. Backup destinations

Backup destinations are an Agent capability with desktop IPC and **no renderer
UI yet**. There is always one built-in **local** destination (the backup root):
it is read-only, cannot be deleted (a delete returns
`BACKUP_LOCAL_DESTINATION_READ_ONLY`), and is the authoritative copy. The only
remote kind in this slice is **SFTP**.

- An SFTP destination stores only a `connectionId` referencing an existing
  storage connection; the destination store never contains a secret. If the
  connection cannot be resolved (for example the Agent cannot read the store),
  the push fails with `BACKUP_DESTINATION_CREDENTIALS_UNAVAILABLE` rather than
  inventing credentials.
- Remote copies are encrypted with AES-256-GCM before leaving the host. The key
  comes from the Agent environment variable `AGENT_BACKUP_ENCRYPTION_KEY` (64
  hex characters, a 32-byte base64 value, or a passphrase hashed with SHA-256).
  Metadata records only a non-reversible fingerprint (`keyId`) and a reference
  (`keyRef`); the key is never persisted, logged, or returned.
- **Key recovery:** there is no key escrow and no recovery path. If the operator
  loses the key, every remote archive encrypted with it is unrecoverable, and
  rotating the key does not re-encrypt existing archives — each manifest names
  the key id that produced it, so recovery requires the matching key.
- A push failure never fails the local backup: the local artifact stays
  authoritative and the failure is recorded additively in the backup metadata as
  `pushState: "failed"` and returned to the caller.
- Restore from a remote destination downloads and decrypts the archive and
  verifies its SHA-256 against the recorded digest **before** any mutation;
  a mismatch refuses with `BACKUP_ARCHIVE_HASH_MISMATCH`. A destination written
  by a newer schema is refused (`BACKUP_DESTINATION_SCHEMA_UNSUPPORTED`), a
  corrupt destination store is quarantined
  (`BACKUP_DESTINATION_STORE_CORRUPT`), and a wrong key or tampered archive
  fails decryption with `BACKUP_DESTINATION_DECRYPT_FAILED` (the bytes and key
  are never echoed).

## 12. Re-pairing an Agent that is already enrolled

Pairing an Agent that is **already enrolled** now requires proof that the caller
may re-pair it. Without that, anyone who could reach the Agent port could pair,
install a credential of their choosing, and own the node — and the enrollment
record would adopt that credential on the next request, so the enrollment gate
never came into it.

The rule is: on an enrolled Agent, `pairing/start`, `pairing/complete`,
`pairing/status` and `pairing/cancel` are accepted only from **the machine the
Agent runs on** (loopback), or from a caller that presents a credential the
Agent already trusts. Anything else is refused with
`PAIRING_REQUIRES_EXISTING_CREDENTIAL` (403), before any session is created,
token rotated or session cancelled.

What this means in practice:

- **Pairing a new node works exactly as before** (no enrollment record yet), from
  anywhere the Agent is reachable.
- **Repairing a remote node works as long as Control Center still holds that
  node's credential** — it now presents it automatically. This is the common
  case: a stale fingerprint or a re-addressed node.
- **A remote node whose credential is genuinely LOST cannot be re-paired over
  the network.** Do it on the Agent machine (`npm run agent:pair`, or Control
  Center running on that machine), or revoke the enrollment first
  (`enroll/revoke`, owner-authenticated) and then pair. This is deliberate: an
  unauthenticated network peer must not be able to perform credential recovery.
- A remote URL with **no matching node record and no stored credential** is in
  the same category — there is nothing to present, so recovery is on-host.
- On a **locked** desktop the stored credential is unavailable, so remote re-pair
  is refused until the owner unlocks. Fail-safe by design.

If the Agent is network-reachable, remember that this gate is one layer: a
default desktop-spawned Agent binds loopback only, while a standalone Agent
defaults to all interfaces and needs a firewall rule that you create
deliberately. Loopback trust is absolute, so do not put a reverse proxy in front
of the Agent port — remote callers would then look local to this check.
