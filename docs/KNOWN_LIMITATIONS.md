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
`docs/v2/`. They are current as of cycle 9; do not treat a queued validation as
already performed.

- **Live acceptance is outstanding for several V2 gates.** Docker engine live
  acceptance (single/multi-container app, bad image, occupied port, missing
  volume, failed update), the two-node live drill, the V2-B operator
  walkthrough, and the clean-host Debian install are contract-covered by smokes
  but not yet exercised live. Do not claim live support from smoke coverage.
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
- **Scheduled restarts are not serialized against in-flight jobs.** A scheduled
  restart does not currently check for an open durable job on the target
  instance (reliability queue Y2, not landed). Concurrent scheduling and
  long-running jobs on one instance are untested together. At-least-once restart
  after an agent crash between execution and store write (a benign double
  restart) is accepted and documented (Y3).
- **Runtime pins are an operator guard, not a security control.** Pin identity
  is client-supplied, so a caller holding `dependencies:write` can claim another
  workload's id and bypass the cross-workload check. Pins also have no renderer
  or desktop IPC surface yet; unpinning is an Agent REST operation.
- **Network inventory is read-only with known parser caveats.** It is discovery
  only, supported on Windows and Linux, has no renderer consumption yet, and is
  capped at 1000 listener rows. A wildcard and a specific address bound on the
  same UDP port can be reported as a conflict even though it is a legitimate
  bind combination; treat UDP conflicts as advisory.
- **Workload transfer has no renderer UI yet, and its "preview" is not a pure
  read.** The preview channel creates a source backup, pulls and imports the
  archive, and registers a target placeholder before stopping for confirmation.
  Only full-scope backups transfer, and the effective size ceiling is the target
  Agent's base64 HTTP body cap (about 192 MiB of raw archive for the default
  256 MiB cap), not the 512 MiB archive limit.
- **Workload-transfer decline can delete a pre-existing target instance.** The
  declined-preview path runs the placeholder cleanup without checking whether the
  transfer created the placeholder (the failure path does gate on that flag).
  Until this is fixed, do not run a transfer preview whose target node already
  has an instance with the target id. Verified in the current code; see
  `docs/OPERATOR_NOTES_V2.md` §9 and `docs/RECOVERY_MODEL.md`.
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
- **Two V2-D roadmap items remain missing/partial.** Install-plan preview has no
  renderer UI (API-only), and the publisher-trust warning for third-party
  executable content and catalog export/import limits are not shipped. Treat
  third-party executable catalog content as unverified.
- **Job expiry is opt-in.** Without an explicit `expiresAt` or a configured
  default pending-job TTL, nothing expires; destructive approvals never lapse by
  default.

## Website Downloads

- The website download page uses a public release-only GitHub repository for release assets.
- If no published release asset exists, the page should show unavailable download metadata.
- Do not expose private source repository links or GitHub tokens in browser code.
- Static website metadata must not advertise a build number unless the matching release tag and downloadable artifact exist.
