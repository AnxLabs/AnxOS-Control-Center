# Known Limitations

These limitations are acceptable for Private Alpha if they are clearly communicated to testers. They should not be hidden or treated as successful behavior.

## Release Channel

- AnxOS Control Center is Private Alpha.
- Do not present it as public beta, stable, or v1.0-ready.
- No version bump, tag, or GitHub Release should be created for readiness-only documentation changes.
- Current source identity is Version 2.0 Build 203, Private Alpha, per
  `release.json`. Historical build-numbered reports are evidence for their named
  artifacts only; see `DOCUMENTATION_INDEX.md`. Availability of matching
  candidate artifacts must be proven separately and is not inferred from source
  metadata.

## Desktop

- Development mode via `npm start` is the primary validation path.
- Packaged builds may require separate signing and installer validation.
- Some Windows service registration actions require Administrator elevation and should be blocked or explained when not elevated.
- The beginner Local Agent flow is designed for Windows and still needs full real-machine installer, service, reboot, SmartScreen, and antivirus validation.

## Agent

- Desktop and Agent code must stay compatible.
- New desktop features may require updating and restarting the Agent.
- Linux package availability depends on distribution repositories and host permissions.
- Do not run the Agent as root just to bypass file, Docker, or provider permissions.
- Local Agent automatic pairing is separate from remote Agent token workflows. Do not ask normal users to copy Local Agent tokens.

## Marketplace

- Marketplace installs depend on external networks, provider APIs, disk space, and runtime dependencies.
- SteamCMD installs can be large and slow.
- Some templates may be smoke-tested but not fully live-validated on every supported node type.
- A failed install may leave partial files for diagnostics and retry; do not assume partial data is safe to delete manually without reviewing it.

## Files

- Agent filesystem access is restricted to the configured authorized root.
- Paths outside the authorized root are intentionally rejected.
- Local Windows paths and Linux Agent paths are isolated per profile.
- If Agent filesystem configuration changes, restart the Agent when required.

## Docker

- Docker features require Docker or compatible tooling on the selected node.
- The UI must not fake empty Docker data when Docker is missing or the daemon is unavailable.
- Docker cleanup actions are destructive and should be previewed before execution.
- Docker capability reporting distinguishes supported, installed, configured,
  running, reachable, authorized, and compatible state. Real daemon permissions,
  registry access, and image pulls still require node-specific validation.

## Public Access

- Provider capabilities vary.
- Playit tunnel metadata may require socket permissions in addition to service detection.
- Unsupported provider actions must remain disabled with a reason.
- Public reachability should be verified from outside the local network before claiming external access works.

## Account and Security

- Owner-only operations require owner access.
- Account services depend on the configured online backend.
- Password reset, device login, and profile flows require live backend validation before broad tester rollout.
- Logs, diagnostics, screenshots, and bug reports must remain redacted.

## Diagnostics and Operations

- Historical failed operations are useful context but should not automatically imply current node failure.
- Some diagnostics are intentionally technical.
- Unknown, Not Tested, Unavailable, Warning, and Degraded have different meanings and should not be collapsed into one status.

## V2 Campaign Surfaces

These limitations reflect the current `dev` line and the campaign records in
`docs/v2/`. They are current as of cycle 25; do not treat a queued validation as
already performed.

- **Live acceptance is partially executed, not complete.** The desktop has been
  launched and inspected in real windows (cycles 19–21), which confirmed the
  alerts and durable-jobs panels, the Docker surface, Public Access, and owner
  authentication at runtime, and closed the node-switch and status-as-metric
  defects. Still outstanding: the wider Docker engine live list (bad image,
  occupied port, missing volume, failed update — `docker:smoke` passes against
  the real socket, but the destructive list has no harness and would mutate
  container state), the operator walkthrough's config-write and recovery paths,
  live-window acceptance of the cycle-25 renderer panels, and onboarding on a
  genuinely fresh install (`qa:acceptance` dismisses the welcome flow without
  asserting on it). The clean-host Debian install and the live Linux
  self-update swap remain externally blocked on hardware. Do not claim live
  support from smoke coverage.
- **Linux Agent self-update is validated hermetically only.** The ordered
  swap/rollback semantics are pinned by `agent:self-update:smoke` with injected
  seams, but the flow has not been run on a real Linux host with a genuine
  version-delta swap. Until that live drill runs, the current staging step
  copies the same runtime root into place; a real version delta is unproven.
- **Docker image update has no controlled rollback** (`rollbackSupported:
  false`). Where image data compatibility allows, a rollback is not built or
  exposed; the deferral is a recorded roadmap decision, not a shipped feature.
- **Compose projects are policy-checked, but the first-class container create
  path is the primary gate.** Compose-file policy gating shipped as a follow-on;
  verify operator-authored compose content is reviewed before `compose up`. The
  renderer confirmation dialog is presentation only and is never the boundary.
- **Volume cleanup is destructive and confirmation-gated.** `runCleanup` refuses
  the `volumes` kind unless the request confirms volume-data removal; do not
  treat the preview alone as protection.
- **Restore preview has caveats.** The target restore preview is a genuinely
  read-only dry run, but an unreadable target status degrades to a warning
  (`RESTORE_TARGET_STATUS_UNAVAILABLE`) rather than a guaranteed running-state
  verdict, and the preview's own status self-heal can report a target state that
  differs from the immediately following confirmed restore. Treat the preview as
  a decision aid, not a guarantee.
- **Scheduled restarts are serialized against in-flight jobs (Y2 closed).** A
  due restart checks for a non-terminal durable job on the target instance and
  skips the window with `INSTANCE_BUSY` (or fails closed with
  `JOB_QUERY_FAILED` when the job store is unreadable) rather than killing the
  job; the skipped cycle keeps its cadence
  (`agent/src/services/restartScheduleService.js`). One accepted remainder:
  at-least-once restart after an agent crash between execution and store write
  (a benign double restart) is accepted and documented (Y3).
- **Runtime pins are an operator guard, not a security control.** Pin identity
  is client-supplied, so a caller holding `dependencies:write` can claim another
  workload's id and bypass the cross-workload check. Pins also have no renderer
  or desktop IPC surface yet; unpinning is an Agent REST operation.
- **Network inventory is read-only with known parser caveats.** It is discovery
  only, supported on Windows and Linux, consumed by the Security page inventory
  panel (`app.js` `networkInventory*`), and capped at 1000 listener rows. A
  wildcard and a specific address bound on the same UDP port can be reported as
  a conflict even though it is a legitimate bind combination; treat UDP
  conflicts as advisory.
- **Workload transfer's "preview" is not a pure read.** The renderer flow ships
  (instance action → target dialog → preview → typed confirmation), but the
  preview channel creates a source backup, pulls and imports the archive, and
  registers a target placeholder before stopping for confirmation. Only
  full-scope backups transfer, and the effective size ceiling is the target
  Agent's base64 HTTP body cap (about 192 MiB of raw archive for the default
  256 MiB cap), not the 512 MiB archive limit.
- **Workload-transfer decline no longer deletes a pre-existing target instance
  (fixed).** The declined-preview path deletes a placeholder only when the
  transfer itself created it — it gates on `context.placeholderCreated === true`
  and an unconsumed import (`src/services/workloadTransferService.js`), mirroring
  the failure path's identical guard. The pre-existing target's payload and
  identity survive a declined preview, pinned by
  `scripts/workload-transfer-smoke.js`.
- **Backup destinations are API/IPC-only and include no key recovery.** There is
  one built-in local destination plus SFTP; remote copies are encrypted with
  AES-256-GCM using `AGENT_BACKUP_ENCRYPTION_KEY`. There is no key escrow and no
  recovery path: losing the key makes the affected remote archives
  unrecoverable, and rotating the key does not re-encrypt existing archives.
  A failed push is recorded in metadata and reported but does not fail the local
  backup. No renderer control exists yet.
- **The browser surface is a read-only agent-served management page, not full
  desktop parity.** It is loopback-only with short-lived sessions, and does not
  expose the full desktop workflow set.
- **Publisher trust and catalog export/import are shipped, with honesty
  caveats.** The publisher-trust notice renders from the policy's own exported
  copy and fails closed, and catalog export/import is schema-versioned and
  refuses an unjustified `verified` declaration. But `verified` is **not
  reachable from production data** — nothing hashes a downloaded artifact and
  there is no PKI, so curated templates evaluate `unsigned-executable` and
  provider packs `unverified-publisher` — and a `hash-mismatch` verdict is
  advisory (no install is blocked yet). Catalog import validates and reports
  without persisting. Treat third-party executable catalog content as
  unverified. (The install-plan preview remains a read-only dialog for curated
  templates; provider packs still have no plan preview by design.)
- **Job expiry is opt-in.** Without an explicit `expiresAt` or a configured
  default pending-job TTL, nothing expires; destructive approvals never lapse by
  default.

## Website Downloads

- The website download page uses a public release-only GitHub repository for release assets.
- If no published release asset exists, the page should show unavailable download metadata.
- Do not expose private source repository links or GitHub tokens in browser code.
- Static website metadata must not advertise a build number unless the matching release tag and downloadable artifact exist.
