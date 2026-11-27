# Known Limitations

These limitations are acceptable for Private Alpha if they are clearly communicated to testers. They should not be hidden or treated as successful behavior.

## Release Channel

- AnxOS Control Center is Private Alpha.
- Do not present it as public beta, stable, or v1.0-ready.
- No version bump, tag, or GitHub Release should be created for readiness-only documentation changes.
- Current source identity is Version 2.0 Build 216, Private Alpha, per
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

## Build 217

- **Memory use is about the same as Build 216 (1-3% lower).** The 15-25%
  target was not met. The one large item is Chromium's audio service (about
  84 MB). The startup sound, which is on by default, keeps it alive for the
  whole session. Turning the sound off by default would save that memory; this
  is left as an owner decision.
- **Sign-in pages still come from `anxoscontrolcenter.org`.** The app opens
  account pages on `anxhost.anxlabs.net`, and the website sends them on (302)
  to the legacy host. That lasts until the owner approves:
  - adding the new origin to the account service (Supabase functions or
    `ANXOS_ALLOWED_ORIGINS`) and to Supabase Auth's redirect list;
  - removing the website's 302.

  The steps are in `docs/anxhost/DOMAIN_MIGRATION_PLAN.md`.
- **Running the installer by hand while the app is open still force-closes
  it.** The in-app Install now closes AnxHost properly first: servers stop
  with their own stop command and pending writes are saved. AnxHost Setup
  itself is unchanged, so starting the installer from a download while the
  app runs still ends the app the old way (see Build 216 below). Leftover temp
  files from such a close are moved aside at the next start, into
  `.recovered-tmp/` in the settings folder (the newest 20 are kept), and are
  never put back automatically.
- **Install waits for work on this PC.** A file transfer, a server or
  modpack install, a Docker image download, or a start, stop, restart,
  install or settings change of a server this app runs, holds the update
  back until it finishes. A task that is paused also holds it back; cancel it
  to install.
- **Not run for this build: the Docker-dependent real-app checks**
  (`build214-ui-qa` J1, J2, P1 and `build215-ui-qa`). Docker Desktop was not
  running on the development PC. Their other checks passed.
- **A configurable AnxNet domain and an AnxLabs relay are not built.** The
  investigation and proposal are in `docs/anxhost/ANXNET_INFRASTRUCTURE.md`.

## Build 216

- **The product is named AnxHost Control Center, but identifiers keep AnxOS**
  so updates stay in place: the app ID, executable and install folder, the
  `AnxHub` data folder, the `AnxOSAgent` task, the `anxos-agent` package and
  `AnxOS-Agent-*.deb` / `AnxOS-Control-Center-*` file names, Docker
  `anxos.*` labels, the phone's cookie and certificate names, and the
  `anxoscontrolcenter.org` domain. Some frozen labels (for example the AnxOS
  Linux distribution name) still read AnxOS.
- **The 216-B website rename went live through Cloudflare's Git deploy,**
  which deployed every push to `dev` to production (the live site matched
  `f8d9dfc2` and later, still describing Build 215). Since 2026-11-27 the
  Pages project no longer deploys `dev` pushes; production changes only
  through the guarded `cloudflare-pages-deploy.yml`. The website now lives on `anxhost.anxlabs.net` (canonical since
  2026-11-27). `anxoscontrolcenter.org` sends ordinary pages there with a
  301 and keeps serving installed apps directly: sign-in, `config.js`,
  `release-notes.json` and downloads (`docs/anxhost/DOMAIN_MIGRATION_PLAN.md`).
- **The app still says "AnxOS" in places.** Build 216 renamed the shell,
  title bar, tray and settings, but some screens keep the old name in their
  text: Add Computer ("AnxOS Agent", "Install AnxOS there"), Settings
  ("Customize AnxOS"), the AnxNet card ("AnxOS's own private network"),
  "AnxOS-managed" server badges, Marketplace template publishers, the phone
  access card and others (about 24 static texts in `index.html`; `app.js`
  has more, some of them frozen file and package names). RC3 is accepted
  unchanged; the rest of the rename is Build 217 work.
- **Sign-in stays on `anxoscontrolcenter.org`.** The app trusts only that
  host (`src/shared/officialSite.js`, frozen) and the account service's CORS
  list has only that origin. Moving sign-in is Build 217 plus an approved
  account-service change.
- **Upgrades force-end a running app.** When the desktop app is running,
  Setup's close step (electron-builder's NSIS engine) sends `taskkill`, which
  the app treats as a window close and only hides to the tray, then
  `taskkill /F` about 2 s later. A write in progress can be cut short. In RC3
  acceptance this left a complete orphan `alerts.json.<pid>.<time>.tmp` beside
  an intact `alerts.json`, with no data lost. Writes use temp-file-and-rename,
  so the saved file stays whole, but an interrupted save is lost and its temp
  file is never cleaned up. Every earlier build closed the app the same way.
  Future improvement: before the engine runs, Setup asks the running app to
  quit cleanly (finish pending writes, then exit), and the app removes stale
  `*.tmp` files at startup.
- **AnxHost Setup was tested unsigned on the development PC** (its window,
  packaging with a real signed engine, and the NSIS engine compile). Installing,
  upgrading and uninstalling with it are first tested from the signed release
  candidate in Windows Sandbox.
- **Remembered sign-in needs Windows secure storage.** Where `safeStorage` is
  unavailable, "Trust this device" is off and the owner signs in at every
  start. Remembered sessions written by older builds with the fallback key are
  refused once.
- **The phone keeps the system font** instead of the desktop's font stack (the
  stack made the phone suite time out; the cause is not proven).
- **The phone UI suite sometimes times out early** (about 3 runs in 11 during
  216-F, before any check fails); the cause is not explained.
- **Kept for a later, separately approved step:** the AMP backend and Home AMP
  card, the Expo pairing backend (its buttons are gone), and page CSS for the
  retired pages.

## Build 215

- **Passwordless Agent updates need a Build 215 Agent on the node** (it ships
  the update helper) and the SSH user in the `anxos-update` group. Getting a
  node from Build 214 to 215 still needs `sudo apt-get install` by hand once,
  or passwordless sudo. Rolling back through the helper to a build older than
  215 removes the helper again.
- **Real update acceptance ran on disposable Ubuntu 24.04 containers** with
  the official Build 213 and 214 packages, not on Anxlab or the VPS. The
  update helper was copied in as a Build 215 package installs it; a packaged
  215 to 215+ upgrade cannot be run until Build 215 is published.
- **Docker image update** works only for services AnxOS installed from the
  catalog. Compose projects and containers created elsewhere are refused. It
  rolls the image back if the new one does not stay up; it cannot undo data
  changes the new version made (for example a database migration).
- **"Will it run on this computer?"** uses the server's memory setting, not a
  measured requirement; game file sizes are not measured, so disk only warns
  on a nearly full computer.
- **Docker services in All computers** show no CPU or memory per container
  (live stats are skipped to keep the list fast; the Docker page has them).
- **No AMP comparison was run.** `docs/BUILD215_AMP_COMPARISON.md` has the
  plan and AnxOS's own measurements; the AMP baseline is unverified.

## Marketplace

- Marketplace installs depend on external networks, provider APIs, disk space, and runtime dependencies.
- SteamCMD installs can be large and slow.
- Some templates may be smoke-tested but not fully live-validated on every supported node type.
- A failed install may leave partial files for diagnostics and retry; do not assume partial data is safe to delete manually without reviewing it.
- **Build 214 catalog (evidence per card: `docs/MARKETPLACE_TEMPLATE_CERTIFICATION.md`):**
  - Game servers added in Build 214 were installed for real on Windows; their
    Linux variants say "not tested by AnxOS yet" (Factorio was tested on
    Linux only; Unturned, Valheim and Palworld on both). ARK: Survival
    Ascended and Space Engineers have no Linux server.
  - On Windows, Stop cannot ask ARK, ARK: Survival Ascended, Space Engineers
    or Core Keeper to save first (no console); the last autosave is kept.
  - Docker services were installed for real on Docker Desktop for Windows
    only; the cards still declare Linux computers, and services are managed
    on the Docker page, not in My Servers.
  - Deploying your own application: AnxOS runs no npm or pip. A Node.js
    project with dependencies must include node_modules; a Python project
    whose requirements.txt lists packages is refused. Python Discord Bot is
    unavailable for the same reason.
  - The server secret store (Project Zomboid's administrator password, the
    Discord bot token) needs a Build 214 Agent; older Agents are refused.
  - CurseForge modpacks were not installed for real in Build 214 (they need
    CurseForge API access); Rust and CS2 were not re-run.

## Game Server Updates, Mods, Alerts and Sign-in (Builds 208–209)

- **Applying updates is SteamCMD-only.** Paper, Vanilla, FiveM and Hytale get check-only update badges; applying those updates stays manual.
- **One SteamCMD job runs per node at a time.** Other updates on that node wait.
- **Backup before update is optional.** **Roll Back Update** can only restore a backup that was taken before the update.
- **Scheduled restarts update SteamCMD servers only when that option is turned on.**
- **The Mod Manager is Minecraft-only and Modrinth-only.** It manages only mods that AnxOS installed. Downloads come only from Modrinth's CDN and must match Modrinth's SHA-512.
- **Alert webhooks are Discord or HTTPS, one per node.** The URL is stored on the Agent and is never shown again; to change it, enter a new one.
- **Hytale runs on Linux nodes only** and needs an account sign-in on first start. **Sign in** opens only the publisher's own sign-in site, and Control Center never sees the account credentials.
- **Updating or restarting an Agent stops every server it runs.** Back up and stop them first, then start them again from the app.
- **Live acceptance coverage.** The Build 209 release candidate was accepted live for Hytale (readiness, sign-in, version) and the fleet **Check All** update check. The Mod Manager, webhook alerts, backup-before-update and rollback, the restart schedule editor, scheduled SteamCMD updates, Steam beta branches and fleet one-by-one updates are covered by repository smoke tests only until a release candidate accepts them live.

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
- **Updating package-installed Agents from the app (Build 213): the in-app
  one-click Linux upgrade is not yet proven end to end.**
  - **What it does:** **Update** and **Update all Agents** in Agent Control now
    handle Agents installed from the `anxos-agent` .deb:
    - download the matching release package and the installed build's package
      for rollback
    - check both against the release's `SHA256SUMS` and the package's own
      identity
    - refuse while servers run under the Agent
    - back up the Agent state, install with `sudo -n apt-get`, and confirm the
      new build
    - reinstall the previous package if the new Agent doesn't come up
  - **Tested so far:** hermetic tests
    (`package-agent-update-smoke`, `agent-update-manager-smoke`), plus the
    preflight and download-and-verify steps against real nodes.
  - **Real package upgrades, done outside the app (2026-11-17):** Anxlab and
    the VPS were upgraded from the published 2.0-build212 package to
    2.0-build213 with `apt-get install` (the VPS over SSH, Anxlab by the
    owner with sudo). Both came up on 2.0-build213 with identity, enrollment,
    configuration and server settings unchanged, and AnxRP kept running. So
    the packages, maintainer scripts and upgrade path are proven; the app's
    **Update** / **Update all Agents** buttons driving that same upgrade have
    not yet run on a real Linux computer, and no real rollback has run.
  - **Since Build 214:** running service-managed servers
    (`systemd-service`, such as AnxRP) no longer block an update, because an
    Agent restart does not stop them. In Build 213 the button refuses while
    any server runs.
  - **Limits:**
    - It needs a key-based SSH profile.
    - If the SSH user needs a password for sudo, it stops after verification
      and shows the command to run.
    - It needs a published package for the installed build to roll back to,
      so pre-212 Agents must be updated once by hand.
    - Packages are checksum-verified against the release, not signed with a
      separate key.
  - **Automatic updates:** off by default. Settings > Updates > Automatic
    Agent updates turns them on for chosen computers, days and a time window,
    and keeps a history. They are skipped while a computer's servers run.
- **Build 213 features that need a Build 213 Agent on the computer:** phone
  file downloads, and cancelling a server update before SteamCMD starts
  (issue #53). With an older Agent the app offers that Cancel only once
  SteamCMD runs, and says why.
- **Moving servers between computers** was verified between two Agents on
  one PC, not between two machines.
- **Modpack updates** are detected and shown; AnxOS does not apply them.
- **The AnxNet edge** (relay and public gateway) was verified as its own
  process on loopback only. It has not run on a public server; that opens
  public ports and needs the owner's approval
  (`docs/ANXNET_EDGE_DEPLOYMENT.md`).
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
