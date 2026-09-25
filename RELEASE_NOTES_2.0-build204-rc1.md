# Release Notes — AnxOS Control Center v2.0 build 204 (release candidate v2.0-build204-rc1)

**Channel:** Private Alpha
**Status:** Release candidate — first-run reliability, security hardening, and recovery safeguards

This file is the release body for the tagged release candidate
`v2.0-build204-rc1`. The product identity is Build 204 of AnxOS Control Center
v2.0 (Private Alpha); the canonical untagged notes live in
`RELEASE_NOTES_2.0-build204.md`.

Build 204 consolidates the cycle-26 work on top of the published Build 203
candidate: the first-run onboarding flow is restored and harness-verified, the
standalone Agent binds to loopback by default, installer paths are contained,
recovery points are verified before irreversible rewrites, and a set of
renderer honesty fixes removes UI states that contradicted the data behind
them. This remains a Private Alpha release candidate, not a public-ready
release.

## Added

### First-run onboarding, restored and verified

- The first-run welcome and the full setup wizard are reachable again on a
  fresh install. The account gate treated the bundled account service config
  as an account requirement, so the welcome stayed hidden on every signed-out
  install; the gate now waits only for account restoration to resolve,
  preserving the ordering guarantee pinned by `bootstrap:auth-order:smoke`.
- Onboarding steps 3 and 4 no longer throw on fresh state: the agent-target
  predicate accepted `undefined` but not `null`, so the wizard's action
  handler swallowed an error and left "Prepare Node" with an empty body and
  "Connect Local Agent" without its pairing UI.
- New harness `npm run qa:onboarding` drives the whole fresh-install flow on
  an isolated profile — welcome, the seven wizard steps, completion state in
  `localStorage` and the config-dir preferences file — with 39 checks and
  per-step screenshots.

### Safe Agent network defaults

- The standalone Agent binds `127.0.0.1` by default. Wildcard binding is an
  explicit `AGENT_HOST` opt-in that emits a loud startup diagnostic naming the
  concrete-address alternative, which also gains a strict Host allowlist.
  Desktop-spawned Agents and remote node management are unchanged.

### Recovery and backup safeguards

- Orphan archives are quarantined instead of deleted.
- The device-identity migration verifies its recovery point before its
  irreversible rewrite, and owner-workspace repair takes a verified
  pre-repair copy.
- New `restore-drill:smoke` performs a real create → backup → destroy →
  restore → verify cycle with fail-closed legs for truncated and missing
  archives — the first executed restore drill in this repository.
- A 20-site schema-migration audit is recorded: the 4 HIGH-risk sites are
  safeguarded with verified recovery points, and the MEDIUM findings are
  documented rather than hidden.

### Other surfaces in this build

- A phone can be paired with a node Agent through a QR claim flow and a
  rate-limited, pre-auth `/pair` claim page (registered fail-closed in the
  permission matrix; the claim page is documented as pre-auth by design).
- The bundled Agent runtime can be pushed to a node over SSH.
- FiveM templates provision the official `cfx-server-data` spawn resources
  (`mapmanager`, `spawnmanager`, and a gamemode), and the readiness gate now
  refuses to start an instance missing them. SteamCMD update integrity was
  hardened at the provisioning boundary.
- Workspace shortcuts, active-workspace refresh, and visibility-aware polling
  so hidden pages stop polling until they are visible again.

## Fixed

- Docker polling no longer leaves the Docker page stuck on its error state
  after a transient failure (daemon restart, Agent briefly unreachable, node
  switch): the gate is `document.hidden` only, with repeat refreshes still
  bounded by the existing in-flight, node-context, timeout, and backoff
  guards.
- The durable-jobs panel no longer presents this computer's job history under
  a selected remote node's name; when the selected node's jobs cannot be read,
  the panel says "This computer only".
- Instance service links validate the node-supplied host as a bare host and
  hide the link on URL-shaped input instead of retargeting it.
- The navigation badge reads `99+` past 99 (the exact count stays in the
  aria-label) instead of a bare `99` that contradicted the panel counters.
- Copy and dead-end fixes: the Create Server wizard's node step no longer
  references a target selector that does not exist; Settings copy no longer
  claims IPC enforcement that is not wired; console CPU/RAM placeholders say
  "Select a server" and Network says "Not reported".
- UX consistency (adversarial first-user pass; 8 of 23 findings fixed and
  visually re-verified): Create Server no longer dead-ends when no template
  matches; the node badge no longer contradicts the health panel (it derives
  from the shared health model); the Agent Control pill no longer sticks on
  "Loading"; Public Access no longer reads "1 active" while the tunnel is
  stopped (now "1 configured"); the Create Server summary no longer says
  "Connected/Ready" when the node step refuses; Add Node placeholders are
  vendor-neutral; node-card name and subtitle no longer concatenate; bulk
  buttons that were enabled no-ops are disabled.
- The Windows packaging gate now actually gates: `packaging:smoke` /
  `artifacts:validate --platform=win` compared asar entries with the wrong
  separator and scanned dependencies comment-blind, so they had never passed
  on Windows and `packaging:smoke` silently skipped inside `rc:validate`.
  Both are fixed with mutation-proven regression legs and the harness now
  defaults to the host platform.

## QA

- Pre-release verification (cycle 26c, this machine): `rc:validate` 291/291
  PASS; `qa:acceptance` PASS (19 screenshots, 0 renderer errors/warnings);
  `qa:onboarding` PASS (39 checks); `qa:responsive` PASS (45 checks);
  `packaging:smoke` and `artifacts:validate --platform=win` PASS; the runs
  left the working tree unchanged.
- New and updated harnesses in this build:
  - `qa:onboarding` — fresh-install first-run flow on an isolated profile,
    39 checks, per-step screenshots.
  - `qa:responsive` — layout, overflow, and target-size checks across
    viewports (45 checks).
  - `agent:rebinding:smoke` — spawns real Agents and pins 419 assertions:
    a concrete bind refuses rebinding-shaped Hosts with 421 pre-auth and no
    echo; the wildcard bind's accepted gap is pinned together with its
    mitigations (no `Access-Control-Allow-Origin`, no hostile host in the
    pairing payload, cross-origin state changes refused with 403); there is
    no WebSocket surface.
  - `restore-drill:smoke` — a real create → backup → destroy → restore →
    verify cycle with fail-closed legs.
  - `qa:second-machine` — a one-command acceptance wrapper (acceptance +
    onboarding + responsive) that copies artifacts, writes `summary.json`,
    and exits non-zero on failure; documented in
    `docs/SECOND_MACHINE_ACCEPTANCE.md`.
  - `renderer:monaco-worker-csp:smoke` — drives the real Electron app: the
    Monaco worker is constructed under the CSP, zero CSP violations, no
    main-thread fallback warning, and the editor renders.
- Security scan status: `npm audit` on the production tree is 0 advisories
  (5 dev-only electron-builder chain findings remain); the sealed
  1012-finding scan was line-verified — 0 clear true positives in product
  code, 1 low-likelihood item (SHA-1 fallback in marketplace import), 696
  false positives, and 315 dev-tooling findings in non-shipped scripts.
- The versioning smoke's RC-retry provenance scenario is advanced with each
  build bump, and the build-204 release-candidate gate is re-run on the
  release commit; the log is kept under `artifacts/preflight/`.

## Security

- The Agent's Host trust no longer fails open on `%`-smuggling; malformed
  Host headers are refused.
- Installer path containment covers `archive`, `extractDir`, and
  `additionalArchives` in both builders, and archive paths carrying control
  characters are rejected.
- A remote-agent downgrade guard refuses silent downgrades of a remote Agent
  runtime.
- The standalone Agent defaults to loopback with an explicit wildcard opt-in
  (see Added).
- The sealed 1012-finding scan was triaged rather than smoothed over: the
  SHA-1 fallback in marketplace import is recorded as the one low-likelihood
  item to revisit, and no finding was promoted to a clean verdict without
  line-level verification.

## Release status and known limits

- This remains a Private Alpha release candidate and is not a public-ready
  release.
- Only unsigned local packaged builds have been produced and accepted so far;
  the locally packaged candidate in the cycle-26c log is Build 203's Setup
  (SHA-256 `5FC0546D…`). Signed Build 204 release-candidate verification and
  the installer lifecycle acceptance (install, in-place upgrade, reboot,
  repair, uninstall) remain outstanding and require explicit owner
  authorization.
- Second-machine acceptance has a one-command harness and documentation, but
  has not yet been executed on a second machine; all evidence in this build
  is from one machine and profile.
- Browser-exploitation of DNS rebinding remains UNPROVEN (no DNS control is
  available without changing machine state); code reading and cross-origin
  probes do not upgrade that verdict. The wildcard bind's gap and its
  mitigations are pinned by `agent:rebinding:smoke`.
- Adversarial-pass findings reported but not fixed are tracked: the Firewall
  raw-agent-error string (smoke-pinned), Fleet-row title spacing, the
  "Console vs Monitoring" naming decision, and raw `java-app`/`java-runtime`
  identifiers pending user-facing mappings.
